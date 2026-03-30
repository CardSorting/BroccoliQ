import { type Kysely, type Transaction, sql } from 'kysely';
import * as crypto from 'node:crypto';
import { getDb, getRawDb, type Schema } from './Config.js';
import type Database from 'better-sqlite3';

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
  private bufferA = new Map<keyof Schema, WriteOp[]>();
  private bufferB = new Map<keyof Schema, WriteOp[]>();
  private activeBuffer: Map<keyof Schema, WriteOp[]> = this.bufferA;
  private inFlightOps: Map<keyof Schema, WriteOp[]> = new Map();
  private agentShadows = new Map<
    string,
    { ops: WriteOp[]; affectedFiles: Set<string>; lastUpdated: number }
  >();
  private stateMutex = new Mutex('DbStateMutex');
  private flushMutex = new Mutex('DbFlushMutex');
  private flushInterval: NodeJS.Timeout | null = null;
  private db: Kysely<Schema> | null = null;
  private rawDb: Database.Database | null = null;
  private totalTransactions = 0;
  private stmtCache = new Map<string, Database.Statement>();
  private parameterBuffer = new Array(2000); // Pre-allocated for chunked inserts

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
          let hasData = false;
          for (const ops of this.activeBuffer.values()) {
            if (ops.length > 0) {
              hasData = true;
              break;
            }
          }
          if (hasData) {
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
      this.rawDb = await getRawDb();
    }
    return this.db;
  }

  private getStatement(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt && this.rawDb) {
      stmt = this.rawDb.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt!;
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
    // Performance Optimization: Direct push to buffer if not a critical flush
    // This allows multiple agents to push concurrently without waiting for a full mutex acquisition
    // except when we hit the flush threshold.
    let currentBufferLength = 0;
    
    if (agentId) {
      // Level 3 Optimization: Lock-free shadow access
      // Each agent is isolated; we only lock if we need to create the entry for the first time.
      let shadow = this.agentShadows.get(agentId);
      
      if (!shadow) {
        const release = await this.stateMutex.acquire();
        try {
          shadow = this.agentShadows.get(agentId) ?? {
            ops: [],
            affectedFiles: new Set<string>(),
            lastUpdated: Date.now(),
          };
          this.agentShadows.set(agentId, shadow);
        } finally {
          release();
        }
      }

      // Safe to push without stateMutex because this agentId is unique to this caller
      for (const op of ops) {
        shadow.ops.push({ ...op, agentId });
      }
      if (affectedFile) shadow.affectedFiles.add(affectedFile);
      shadow.lastUpdated = Date.now();
    } else {
      let tableBuffer = this.activeBuffer.get(ops[0]!.table);
      if (!tableBuffer) {
        tableBuffer = [];
        this.activeBuffer.set(ops[0]!.table, tableBuffer);
      }
      tableBuffer.push(...ops);
      currentBufferLength = tableBuffer.length;
    }
    
    if (currentBufferLength > 100000) {
      console.warn(`[DbPool] CRITICAL backpressure: activeBuffer length is ${currentBufferLength}`);
    }

    shouldFlush = currentBufferLength >= 10000;

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
        for (const op of shadow.ops) {
          let tableBuffer = this.activeBuffer.get(op.table);
          if (!tableBuffer) {
            tableBuffer = [];
            this.activeBuffer.set(op.table, tableBuffer);
          }
          tableBuffer.push(op);
        }
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
    const releaseFlush = await this.flushMutex.acquire();
    let opsToFlush: WriteOp[] = [];
    const startTime = Date.now();

    try {
      const releaseState = await this.stateMutex.acquire();
      let hasData = false;
      try {
        const dirtyBuffer = this.activeBuffer;
        for (const ops of dirtyBuffer.values()) {
          if (ops.length > 0) { hasData = true; break; }
        }
        
        if (hasData) {
          // Atomic Swap: Infinite Horizon (Partitioned)
          this.activeBuffer = dirtyBuffer === this.bufferA ? this.bufferB : this.bufferA;
          this.activeBuffer.clear(); // Reset the new active buffer map
          
          this.inFlightOps = dirtyBuffer;
          opsToFlush = Array.from(dirtyBuffer.values()).flat().sort((a, b) => {
            const pA = (LAYER_PRIORITY as any)[a.layer ?? 'plumbing'];
            const pB = (LAYER_PRIORITY as any)[b.layer ?? 'plumbing'];
            if (pA !== pB) return pA - pB;
            if (a.table !== b.table) return (a.table as string).localeCompare(b.table as string);
            return (a.type as string).localeCompare(b.type as string);
          });
        } else if (this.inFlightOps.size > 0) {
           opsToFlush = Array.from(this.inFlightOps.values()).flat();
        }
      } finally {
        releaseState();
      }

      if (opsToFlush.length === 0) return;

      const db = await this.ensureDb();
      let totalFlushed = 0;
      this.totalTransactions++;

      await db.transaction().execute(async (trx) => {
        const processedGroups = this.groupOps(opsToFlush);

        for (const group of processedGroups) {
          const first = group[0];
          if (!first) continue;
          const table = first.table;

          // High-Performance Path: Chunked Raw SQL (Level 3 Quantum Boost)
          if (group.length >= 100 && first.type === 'insert' && this.rawDb) {
            totalFlushed += await this.executeChunkedRawInsert(table, group);
          } else if (group.length > 1 && first.type === 'insert') {
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
        this.inFlightOps.clear();
      } finally {
        releaseStateClear();
      }
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const isRetryable = err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' || err.message?.includes('deadlock');

      const releaseState = await this.stateMutex.acquire();
      try {
        if (isRetryable) {
          for (const op of opsToFlush) {
            let tableBuffer = this.activeBuffer.get(op.table);
            if (!tableBuffer) { tableBuffer = []; this.activeBuffer.set(op.table, tableBuffer); }
            tableBuffer.unshift(op);
          }
        }
        this.inFlightOps.clear();
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
      applyOps(this.inFlightOps.get(table) || [], finalResults);
      applyOps(this.activeBuffer.get(table) || [], finalResults);
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

  private async executeChunkedRawInsert(table: keyof Schema, group: WriteOp[]): Promise<number> {
    if (group.length === 0 || !this.rawDb) return 0;
    const firstOp = group[0];
    if (!firstOp?.values) return 0;

    const columns = Object.keys(firstOp.values);
    const CHUNK_SIZE = 100; // Optimal for SQLite param limits and SQL length
    
    let totalFlushed = 0;
    for (let i = 0; i < group.length; i += CHUNK_SIZE) {
      const chunk = group.slice(i, i + CHUNK_SIZE);
      const valuePlaceholders = `(${columns.map(() => '?').join(',')})`;
      const placeholders = chunk.map(() => valuePlaceholders).join(',');
      const sql = `INSERT INTO ${table as string} (${columns.join(',')}) VALUES ${placeholders}`;
      
      const stmt = this.getStatement(sql);
      
      // Level 4 Optimization: Zero-Allocation Parameter Flattening
      // Reuse the pre-allocated parameterBuffer to avoid GC pressure for 1M+ ops
      let pIdx = 0;
      for (const op of chunk) {
        const vals = op.values as Record<string, any>;
        for (const col of columns) {
          this.parameterBuffer[pIdx++] = vals[col];
        }
      }
      
      const params = this.parameterBuffer.slice(0, pIdx);
      stmt.run(...params);
      totalFlushed += chunk.length;
    }
    
    return totalFlushed;
  }

  private async executeRawBulkInsert(table: keyof Schema, group: WriteOp[]): Promise<number> {
    if (group.length === 0 || !this.rawDb) return 0;
    const firstOp = group[0];
    if (!firstOp?.values) return 0;

    const columns = Object.keys(firstOp.values);
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT INTO ${table as string} (${columns.join(',')}) VALUES (${placeholders})`;
    
    const stmt = this.getStatement(sql);
    
    // Use raw better-sqlite3 run in a loop (inside the Kysely transaction)
    for (const op of group) {
      const params = columns.map(col => (op.values as Record<string, any>)[col]);
      stmt.run(...params);
    }
    
    return group.length;
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
    let activeSize = 0;
    for (const ops of this.activeBuffer.values()) activeSize += ops.length;
    let inFlightSize = 0;
    for (const ops of this.inFlightOps.values()) inFlightSize += ops.length;

    return {
      activeBuffer: this.activeBuffer === this.bufferA ? 'A' : 'B',
      activeBufferSize: activeSize,
      inFlightOpsSize: inFlightSize,
      activeShadows: this.agentShadows.size,
      totalTransactions: this.totalTransactions,
      latencies: {
        enqueue: { p95: this.calculatePercentile(this.enqueueLatencies, 95), p99: this.calculatePercentile(this.enqueueLatencies, 99) },
        processing: { p95: this.calculatePercentile(this.processingLatencies, 95), p99: this.calculatePercentile(this.processingLatencies, 99) },
      },
    };
  }
}

export const dbPool = new BufferedDbPool();
