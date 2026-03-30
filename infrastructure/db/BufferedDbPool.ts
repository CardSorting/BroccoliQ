import { type Kysely, type Transaction, sql } from 'kysely';
import * as crypto from 'node:crypto';
import { getDb, type Schema } from './Config.js';

// Production-grade Mutex implementation
class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  constructor(public name: string) {}

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export type DbLayer = 'domain' | 'infrastructure' | 'ui' | 'plumbing';

type WhereCondition = {
  column: string;
  value: string | number | string[] | number[] | null;
  operator?: '=' | '<' | '>' | '<=' | '>=' | '!=' | 'IN' | 'in' | 'In' | 'UNSAFE_IN' | 'IS' | 'IS NOT' | 'LIKE';
};

export type Increment = { _type: 'increment'; value: number };

export type WriteOp = {
  type: 'insert' | 'update' | 'delete' | 'upsert';
  table: keyof Schema;
  values?: Record<string, unknown | Increment>;
  where?: WhereCondition | WhereCondition[];
  conflictTarget?: string | string[]; // For upserts
  agentId?: string;
  layer?: DbLayer;
};

const LAYER_PRIORITY: Record<DbLayer, number> = {
  domain: 0,
  infrastructure: 1,
  ui: 2,
  plumbing: 3,
};

function normalizeWhere(where: WhereCondition | WhereCondition[] | undefined): WhereCondition[] {
  if (!where) return [];
  return Array.isArray(where) ? where : [where];
}

/**
 * BufferedDbPool provides a high-performance, asynchronous write-behind layer
 * over SQLite. It batches operations, manages agent-specific uncommitted state,
 * and ensures data consistency between in-memory buffers and on-disk storage.
 */
export class BufferedDbPool {
  private globalBuffer: WriteOp[] = [];
  private inFlightOps: WriteOp[] = [];
  private agentShadows = new Map<
    string,
    { ops: WriteOp[]; affectedFiles: Set<string>; lastUpdated: number }
  >();
  private stateMutex = new Mutex('DbStateMutex');
  private flushMutex = new Mutex('DbFlushMutex');
  private flushInterval: NodeJS.Timeout | null = null;
  private db: Kysely<Schema> | null = null;

  constructor() {
    this.startFlushLoop();
  }

  private flushTimeout: NodeJS.Timeout | null = null;
  private currentFlushDelay: number | null = null;

  /**
   * Adaptive flush scheduling.
   */
  private scheduleFlush(delay = 10) {
    if (this.flushTimeout) {
      if (this.currentFlushDelay !== null && this.currentFlushDelay <= delay) {
        return;
      }
      clearTimeout(this.flushTimeout);
    }

    this.currentFlushDelay = delay;
    this.flushTimeout = setTimeout(async () => {
      this.currentFlushDelay = null;
      this.flushTimeout = null;
      try {
        await this.flush();
      } finally {
        const release = await this.stateMutex.acquire();
        try {
          if (this.globalBuffer.length > 0) {
            this.scheduleFlush(10);
          }
        } finally {
          release();
        }
      }
    }, delay);
  }

  private cleanupInterval: NodeJS.Timeout | null = null;

  private startFlushLoop() {
    this.scheduleFlush(1000);
    this.flushInterval = setInterval(() => this.scheduleFlush(1000), 1000);
    this.cleanupInterval = setInterval(() => this.cleanupShadows(), 30000);
  }

  private async cleanupShadows() {
    const release = await this.stateMutex.acquire();
    try {
      const now = Date.now();
      const SHADOW_EXPIRATION = 5 * 60 * 1000;
      for (const [agentId, shadow] of this.agentShadows.entries()) {
        if (now - shadow.lastUpdated > SHADOW_EXPIRATION) {
          this.agentShadows.delete(agentId);
        }
      }
    } finally {
      release();
    }
  }

  public async beginWork(agentId: string) {
    const release = await this.stateMutex.acquire();
    try {
      if (!this.agentShadows.has(agentId)) {
        this.agentShadows.set(agentId, {
          ops: [],
          affectedFiles: new Set(),
          lastUpdated: Date.now(),
        });
      }
    } finally {
      release();
    }
  }

  public async push(op: WriteOp, agentId?: string, affectedFile?: string) {
    return this.pushBatch([op], agentId, affectedFile);
  }

  private async ensureDb(): Promise<Kysely<Schema>> {
    if (!this.db) {
      const db = await getDb();
      await sql`PRAGMA cache_size = -128000;`.execute(db);
      await sql`PRAGMA temp_store = MEMORY;`.execute(db);
      await sql`PRAGMA journal_mode = WAL;`.execute(db);
      await sql`PRAGMA synchronous = NORMAL;`.execute(db);
      await sql`PRAGMA mmap_size = 2147483648;`.execute(db);
      await sql`PRAGMA threads = 4;`.execute(db);
      await sql`PRAGMA auto_vacuum = NONE;`.execute(db);
      this.db = db;
    }
    return this.db;
  }

  private enqueueLatencies: number[] = [];
  private processingLatencies: number[] = [];
  private MAX_METRICS_SAMPLES = 5000;

  private recordLatency(target: number[], value: number) {
    target.push(value);
    if (target.length > this.MAX_METRICS_SAMPLES) {
      target.shift();
    }
  }

  private calculatePercentile(samples: number[], percentile: number): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index] ?? 0;
  }

  public async pushBatch(ops: WriteOp[], agentId?: string, affectedFile?: string) {
    const enqueueStart = performance.now();
    let shouldFlush = false;
    const release = await this.stateMutex.acquire();
    try {
      if (agentId) {
        const shadow =
          this.agentShadows.get(agentId) ??
          ({
            ops: [],
            affectedFiles: new Set<string>(),
            lastUpdated: Date.now(),
          } as { ops: WriteOp[]; affectedFiles: Set<string>; lastUpdated: number });
        for (const op of ops) {
          shadow.ops.push({ ...op, agentId });
        }
        if (affectedFile) shadow.affectedFiles.add(affectedFile);
        shadow.lastUpdated = Date.now();
        this.agentShadows.set(agentId, shadow);
      } else {
        this.globalBuffer.push(...ops);
      }
      
      if (this.globalBuffer.length > 50000) {
        console.warn(`[DbPool] CRITICAL backpressure: globalBuffer length is ${this.globalBuffer.length}`);
      }

      shouldFlush = this.globalBuffer.length >= 10000;
    } finally {
      release();
    }

    this.recordLatency(this.enqueueLatencies, performance.now() - enqueueStart);
    if (shouldFlush) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(5);
    }
  }

  public async commitWork(agentId: string) {
    let shadowOpsCount = 0;
    const release = await this.stateMutex.acquire();
    try {
      const shadow = this.agentShadows.get(agentId);
      this.agentShadows.delete(agentId);
      if (shadow && shadow.ops.length > 0) {
        shadowOpsCount = shadow.ops.length;
        this.globalBuffer.push(...shadow.ops);
      }
    } finally {
      release();
    }

    if (shadowOpsCount > 0) {
      this.scheduleFlush(0);
    }
  }

  public async rollbackWork(agentId: string) {
    const release = await this.stateMutex.acquire();
    try {
      this.agentShadows.delete(agentId);
    } finally {
      release();
    }
  }

  public async runTransaction<T>(callback: (agentId: string) => Promise<T>): Promise<T> {
    const agentId = `trx-${crypto.randomUUID()}`;
    await this.beginWork(agentId);
    try {
      const result = await callback(agentId);
      await this.commitWork(agentId);
      return result;
    } catch (e) {
      await this.rollbackWork(agentId);
      throw e;
    }
  }

  public async flush() {
    if (this.globalBuffer.length === 0 && this.inFlightOps.length === 0) return;

    const releaseFlush = await this.flushMutex.acquire();
    let opsToFlush: WriteOp[] = [];
    const startTime = Date.now();

    try {
      const releaseState = await this.stateMutex.acquire();
      try {
        if (this.globalBuffer.length === 0) return;

        opsToFlush = this.globalBuffer.sort((a, b) => {
          const pA = LAYER_PRIORITY[a.layer ?? 'plumbing'];
          const pB = LAYER_PRIORITY[b.layer ?? 'plumbing'];
          if (pA !== pB) return pA - pB;
          if (a.table !== b.table) return (a.table as string).localeCompare(b.table as string);
          return (a.type as string).localeCompare(b.type as string);
        });
        this.globalBuffer = [];
        this.inFlightOps = opsToFlush;
      } finally {
        releaseState();
      }

      const db = await this.ensureDb();
      let totalFlushed = 0;

      await db.transaction().execute(async (trx) => {
        const processedGroups = this.groupOps(opsToFlush);

        for (const group of processedGroups) {
          const first = group[0];
          if (!first) continue;
          const table = first.table;

          if (group.length > 1 && first.type === 'insert') {
            totalFlushed += await this.executeBulkInsert(trx, table, group);
          } else if (group.length > 1 && first.type === 'update') {
            totalFlushed += await this.executeBulkUpdate(trx, table, group);
          } else {
            for (const op of group) {
              await this.executeSingleOp(trx, op);
              totalFlushed++;
            }
          }
        }
      });

      const duration = Date.now() - startTime;
      this.recordLatency(this.processingLatencies, duration);

      const throughput = Math.round(totalFlushed / (duration / 1000 || 0.001));
      if (duration > 50 || totalFlushed > 1000) {
        const p95p = this.calculatePercentile(this.processingLatencies, 95);
        const p99p = this.calculatePercentile(this.processingLatencies, 99);
        const p95e = this.calculatePercentile(this.enqueueLatencies, 95);
        console.log(`[DbPool] Flush: ${totalFlushed} ops in ${duration}ms (${throughput} ops/sec) | Latency: p95_proc=${p95p.toFixed(1)}ms, p99_proc=${p99p.toFixed(1)}ms, p95_enq=${p95e.toFixed(2)}ms`);
      }

      const releaseStateClear = await this.stateMutex.acquire();
      try {
        this.inFlightOps = [];
      } finally {
        releaseStateClear();
      }
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const isRetryable = err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' || err.message?.includes('deadlock');

      const releaseState = await this.stateMutex.acquire();
      try {
        if (isRetryable) {
          this.globalBuffer = [...opsToFlush, ...this.globalBuffer];
        }
        this.inFlightOps = [];
      } finally {
        releaseState();
      }
      if (isRetryable) throw e;
    } finally {
      releaseFlush();
    }
  }

  private async executeBulkUpdate(
    trx: Transaction<Schema>,
    table: keyof Schema,
    group: WriteOp[],
  ): Promise<number> {
    if (group.length === 0) return 0;
    const first = group[0];
    if (!first?.values) return 0;

    const canBatchIntoSingleStatement = group.every(
      (op) =>
        JSON.stringify(op.values) === JSON.stringify(first.values) &&
        op.where &&
        !Array.isArray(op.where) &&
        op.where.column === 'id' &&
        (op.where.operator === '=' || op.where.operator === undefined),
    );

    if (canBatchIntoSingleStatement && first.where && !Array.isArray(first.where)) {
      const ids: unknown[] = [];
      for (const op of group) {
        const val = (op.where as WhereCondition).value;
        if (Array.isArray(val)) {
          ids.push(...val);
        } else {
          ids.push(val);
        }
      }

      const valuesWithNoIncrements: Record<string, unknown> = {};
      const increments: Record<string, number> = {};
      for (const [k, v] of Object.entries(first.values)) {
        if (this.isIncrement(v)) {
          increments[k] = v.value;
        } else {
          valuesWithNoIncrements[k] = v;
        }
      }

      const query = trx.updateTable(table);
      const sets: Record<string, unknown> = { ...valuesWithNoIncrements };
      for (const [k, v] of Object.entries(increments)) {
        sets[k] = sql`${sql.ref(k)} + ${v}`;
      }

      await query.set(sets as never).where('id' as never, 'in', ids as never).execute();
      return group.length;
    }

    const promises = group.map(op => this.executeSingleOp(trx, op));
    await Promise.all(promises);
    return group.length;
  }

  public async selectWhere<T extends keyof Schema>(
    table: T,
    where: WhereCondition | WhereCondition[],
    agentId?: string,
    options?: {
      orderBy?: { column: keyof Schema[T]; direction: 'asc' | 'desc' };
      limit?: number;
    },
  ): Promise<Schema[T][]> {
    const release = await this.stateMutex.acquire();
    try {
      const db = await this.ensureDb();
      const conditions = normalizeWhere(where);

      let query = db.selectFrom(table).selectAll();
      for (const cond of conditions) {
        const opStr = cond.operator || '=';
        if (Array.isArray(cond.value)) {
          query = (query as any).where(cond.column, 'in', cond.value);
        } else {
          query = (query as any).where(cond.column, opStr, cond.value);
        }
      }

      if (options?.orderBy) {
        query = (query as any).orderBy(options.orderBy.column, options.orderBy.direction);
      }
      if (options?.limit) {
        query = (query as any).limit(options.limit);
      }

      const diskResults = (await query.execute()) as Schema[T][];

      const applyOps = (ops: WriteOp[], target: Schema[T][]) => {
        // Pre-filter ops by table to reduce iterations from 50k to <1000 in most cases
        const tableOps = ops.filter(op => op.table === table);
        if (tableOps.length === 0) return;

        for (const op of tableOps) {
          const applyValues = (existing: unknown, newValues: Record<string, unknown>) => {
            const next = { ...(existing as Record<string, unknown>) };
            for (const [k, v] of Object.entries(newValues)) {
              if (this.isIncrement(v)) {
                next[k] = (Number(next[k]) || 0) + v.value;
              } else {
                next[k] = v;
              }
            }
            return next as Schema[T];
          };

          const opWhere = normalizeWhere(op.where);
          
          // Pre-compute Sets for IN operators to O(1) lookup
          const inSets = opWhere.map(c => {
            if (c.operator?.toUpperCase() === 'IN' && Array.isArray(c.value)) {
              return new Set(c.value as unknown[]);
            }
            return null;
          });

          const matches = (r: unknown) => {
            const row = r as Record<string, unknown>;
            if (opWhere.length === 0) return false;
            return opWhere.every((c, idx) => {
              const val = row[c.column];
              const opStr = (c.operator || '=').toUpperCase();
              
              if (opStr === 'IN') {
                const set = inSets[idx];
                if (set) return set.has(val as any);
                if (Array.isArray(c.value)) return (c.value as unknown[]).includes(val);
                return val === c.value;
              }
              if (opStr === '=') return val === c.value;
              if (opStr === '!=') return val !== c.value;
              if (opStr === '>') return Number(val) > Number(c.value);
              if (opStr === '<') return Number(val) < Number(c.value);
              if (opStr === '>=') return Number(val) >= Number(c.value);
              if (opStr === '<=') return val !== null && Number(val) <= Number(c.value);
              return false;
            });
          };

          if (op.type === 'insert' && op.values) {
            target.push({ ...op.values } as unknown as Schema[T]);
          } else if (op.type === 'upsert' && op.values) {
            const pkMatch = (r: unknown) => {
              const row = r as Record<string, unknown>;
              if (opWhere.length > 0) return matches(row);
              return row['id'] !== undefined && (op.values as Record<string, unknown>)['id'] !== undefined && row['id'] === (op.values as Record<string, unknown>)['id'];
            };
            const existingIdx = target.findIndex(pkMatch);
            if (existingIdx >= 0) {
              const existing = target[existingIdx];
              if (existing) target[existingIdx] = applyValues(existing, op.values as Record<string, unknown>);
            } else {
              target.push({ ...op.values } as unknown as Schema[T]);
            }
          } else if (op.type === 'update' && op.values) {
            for (let i = 0; i < target.length; i++) {
              const existing = target[i];
              if (existing && matches(existing)) target[i] = applyValues(existing, op.values as Record<string, unknown>);
            }
          } else if (op.type === 'delete') {
            for (let i = target.length - 1; i >= 0; i--) {
              const existing = target[i];
              if (existing && matches(existing)) target.splice(i, 1);
            }
          }
        }
      };

      let finalResults = [...diskResults];
      applyOps(this.inFlightOps, finalResults);
      applyOps(this.globalBuffer, finalResults);
      if (agentId) {
        const shadow = this.agentShadows.get(agentId);
        if (shadow) applyOps(shadow.ops, finalResults);
      }

      if (options?.orderBy) {
        const col = options.orderBy.column as string;
        const dir = options.orderBy.direction;
        finalResults.sort((a, b) => {
          const valA = (a as Record<string, unknown>)[col];
          const valB = (b as Record<string, unknown>)[col];
          if (valA === undefined || valB === undefined || valA === null || valB === null) return 0;
          if (valA < valB) return dir === 'asc' ? -1 : 1;
          if (valA > valB) return dir === 'asc' ? 1 : -1;
          return 0;
        });
      }
      if (options?.limit) finalResults = finalResults.slice(0, options.limit);
      return finalResults;
    } finally {
      release();
    }
  }

  public async selectOne<T extends keyof Schema>(
    table: T,
    where: WhereCondition | WhereCondition[],
    agentId?: string,
  ): Promise<Schema[T] | null> {
    const results = await this.selectWhere(table, where, agentId);
    return results.length > 0 ? (results[results.length - 1] as Schema[T]) : null;
  }

  public static increment(value: number): Increment {
    return { _type: 'increment', value };
  }

  private groupOps(ops: WriteOp[]): WriteOp[][] {
    const coalescedOps: WriteOp[] = [];
    const updateCache = new Map<string, number>();

    for (const op of ops) {
      if (op.type === 'update' && op.where && !Array.isArray(op.where) && op.where.column === 'id' && op.where.operator === '=') {
        const pk = `${op.table}:${op.where.column}:${op.where.value}`;
        const hasIncrements = Object.values(op.values || {}).some((v) => this.isIncrement(v));
        const existingIdx = updateCache.get(pk);
        if (!hasIncrements && existingIdx !== undefined) {
          const targetOp = coalescedOps[existingIdx];
          if (targetOp) targetOp.values = { ...(targetOp.values || {}), ...(op.values || {}) };
          continue;
        } else if (!hasIncrements) {
          updateCache.set(pk, coalescedOps.length);
        }
      }
      coalescedOps.push(op);
    }

    const groups: WriteOp[][] = [];
    let currentGroup: WriteOp[] = [];
    for (const op of coalescedOps) {
      if (op.type === 'insert' && op.values) {
        if (currentGroup.length > 0 && currentGroup[0]?.table === op.table && currentGroup[0]?.type === 'insert') {
          currentGroup.push(op);
        } else {
          if (currentGroup.length > 0) groups.push(currentGroup);
          currentGroup = [op];
        }
      } else {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [];
        groups.push([op]);
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups;
  }

  private async executeBulkInsert(trx: Transaction<Schema>, table: keyof Schema, group: WriteOp[]): Promise<number> {
    const firstOp = group[0];
    if (!firstOp?.values) return 0;
    const columnCount = Object.keys(firstOp.values).length || 1;
    const CHUNK_SIZE = Math.max(1, Math.floor(5000 / columnCount));
    let flushed = 0;
    for (let i = 0; i < group.length; i += CHUNK_SIZE) {
      const chunk = group.slice(i, i + CHUNK_SIZE);
      const values = chunk.map((op) => op.values).filter((v): v is Record<string, unknown> => v !== undefined);
      await trx.insertInto(table).values(values as never).execute();
      flushed += chunk.length;
    }
    return flushed;
  }

  private isIncrement(value: unknown): value is Increment {
    return typeof value === 'object' && value !== null && '_type' in value && (value as Increment)._type === 'increment';
  }

  private async executeSingleOp(trx: Transaction<Schema>, op: WriteOp) {
    const conditions = normalizeWhere(op.where);
    const table = op.table;

    if (op.type === 'insert' && op.values) {
      await trx.insertInto(table).values(op.values as never).execute();
    } else if (op.type === 'upsert' && op.values) {
      const valuesWithNoIncrements: Record<string, unknown> = {};
      const increments: Record<string, number> = {};
      for (const [k, v] of Object.entries(op.values)) {
        if (this.isIncrement(v)) increments[k] = v.value;
        else valuesWithNoIncrements[k] = v;
      }
      await trx.insertInto(table).values(valuesWithNoIncrements as never).onConflict((oc) => {
        let conflictTarget = op.conflictTarget;
        if (!conflictTarget) conflictTarget = conditions.length > 0 ? conditions.map((c) => c.column) : ['id'];
        const updateSet: Record<string, unknown> = { ...valuesWithNoIncrements };
        for (const [k, v] of Object.entries(increments)) updateSet[k] = sql`${sql.ref(k)} + ${v}`;
        if (Array.isArray(conflictTarget)) return oc.columns(conflictTarget as string[] as never[]).doUpdateSet(updateSet as never);
        return oc.column(conflictTarget as string as never).doUpdateSet(updateSet as never);
      }).execute();
    } else if (op.type === 'update' && op.values) {
      const sets: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.values)) {
        if (this.isIncrement(v)) sets[k] = sql`${sql.ref(k)} + ${v.value}`;
        else sets[k] = v;
      }
      let query = trx.updateTable(table).set(sets as never);
      for (const cond of conditions) {
        const opStr = (cond.operator === 'IN' ? 'in' : cond.operator || '=') as never;
        query = query.where(cond.column as never, opStr, cond.value as never);
      }
      await query.execute();
    } else if (op.type === 'delete') {
      let query = trx.deleteFrom(table);
      for (const cond of conditions) {
        const opStr = (cond.operator === 'IN' ? 'in' : cond.operator || '=') as never;
        query = query.where(cond.column as never, opStr, cond.value as never);
      }
      await query.execute();
    }
  }

  public async stop() {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.flushTimeout) clearTimeout(this.flushTimeout);
    await this.flush();
  }

  public getMetrics() {
    return {
      globalBufferSize: this.globalBuffer.length,
      inFlightOpsSize: this.inFlightOps.length,
      activeShadows: this.agentShadows.size,
      latencies: {
        enqueue: { p95: this.calculatePercentile(this.enqueueLatencies, 95), p99: this.calculatePercentile(this.enqueueLatencies, 99) },
        processing: { p95: this.calculatePercentile(this.processingLatencies, 95), p99: this.calculatePercentile(this.processingLatencies, 99) },
      },
    };
  }
}

export const dbPool = new BufferedDbPool();
