# BroccoliQ Usage Guide

Complete guide to building high-throughput systems with buffered database and job queue infrastructure.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [BufferedDbPool Deep Dive](#2-buffereddbpool-deep-dive)
3. [SqliteQueue Pipeline](#3-queue-pipeline)
4. [Increment Coalescing](#4-increment-coalescing)
5. [Layering Guidelines](#5-layering-guidelines)
6. [Safety Patterns](#6-safety-patterns)
7. [Failure Recovery](#7-failure-recovery)
8. [Performance Optimization](#8-performance-optimization)
9. [Monitoring & Metrics](#9-monitoring--metrics)
10. [Scaling Strategies](#10-scaling-strategies)
11. [Troubleshooting](#11-troubleshooting)
12. [Advanced Patterns](#12-advanced-patterns)

---

## 1. Getting Started

### Installation

```bash
npm install broccolidb
```

### Project Setup

Create a new Node.js project:

```bash
mkdir my-high-throughput-app
cd my-high-throughput-app
npm init -y
npm install broccolidb @types/node
```

### Basic Structure

```typescript
// src/index.ts
import { dbPool, SqliteQueue } from 'broccolidb';

async function main() {
  // Initialize the global buffered pool
  const metrics = dbPool.getMetrics();
  console.log('Pool ready:', metrics);

  // Create a queue
  const queue = new SqliteQueue({ concurrency: 500 });
  
  // Enqueue some work
  await queue.enqueue({ type: 'metric', value: '123.45' });
  
  // Process it
  await queue.process(processJob);
  
  // Cleanup
  await queue.close();
  await dbPool.stop();
}

main().catch(console.error);
```

---

## 2. BufferedDbPool Deep Dive

### What is BufferedDbPool?

BufferedDbPool is a **write-behind persistence layer** that batches database operations for high-throughput scenarios. It's not an ORM—it's a memory-first data access layer.

### Core Concepts

#### Dual Buffer System (Level 1)

```typescript
private bufferA = new Map<keyof Schema, WriteOp[]>();
private bufferB = new Map<keyof Schema, WriteOp[]>();
private activeBuffer: Map<keyof Schema, WriteOp[]>;
```

**How it works:**
1. App writes to `activeBuffer`
2. When buffer is full or time threshold reached:
   - **Zero-downtime swap**: Lock held → Swap A ↔ B → Unlock
   - Immediately begin writing to new buffer
   - Previous buffer is flushed to disk
3. Result: No blocking during flushes

**Benefits:**
- Sub-millisecond buffer switches
- No impact on concurrent readers/writers
- Enables 10K+ ops/sec throughput

#### Adaptive Flush Scheduling

```typescript
private scheduleFlush(delay = 10) {
  // Delay based on buffer size: 5ms (small) → 10ms (large)
  // Flush when: buffer >= 10K ops OR timeout threshold
}
```

**Dynamic thresholds:**
- **Small flush**: 5ms delay (for <10K ops)
- **Large flush**: 10ms delay (for >10K ops)
- **Immediate**: 0ms delay (backpressure case)

**Why these values?**
- 10ms tradeoff between latency and I/O cost
- Reduces transaction frequency
- Allows buffering to accumulate for bulk operations

### Write Operations

#### Basic Insert

```typescript
await dbPool.push({
  type: 'insert',
  table: 'queue_jobs',
  values: {
    id: 'job-123',
    payload: JSON.stringify({ task: 'process' }),
    status: 'pending',
    priority: 0,
    attempts: 0,
    maxAttempts: 5,
    runAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
});
```

#### Upsert with Conflict Handling

```typescript
await dbPool.push({
  type: 'upsert',
  table: 'users',
  values: { 
    id: 'user-1', 
    name: 'Alice', 
    lastActive: Date.now() 
  },
  conflictTarget: 'id', // Or columns array
  where: { column: 'id', value: 'user-1' }
});
```

#### Atomic Increment

```typescript
await dbPool.push({
  type: 'update',
  table: 'counters',
  values: {
    count: dbPool.increment(1) // +1 atomically
  },
  where: { column: 'id', value: 'global' }
});
```

#### Increment with Previous Value

```typescript
// Current value: 10 → new value: 15
await dbPool.push({
  type: 'update',
  table: 'metrics',
  values: {
    currentValue: dbPool.increment(5)
  },
  where: { column: 'id', value: 'request-count' }
});
```

#### Bulk Push (Single Transaction)

```typescript
await dbPool.pushBatch([
  { type: 'insert', table: 'queue_jobs', values: { /* job 1 */ } },
  { type: 'insert', table: 'queue_jobs', values: { /* job 2 */ } },
  { type: 'insert', table: 'queue_jobs', values: { /* job 3 */ } }
]);
```

### Query Operations

#### Select Where

```typescript
// Select pending jobs
const pendingJobs = await dbPool.selectWhere('queue_jobs', {
  column: 'status',
  value: 'pending'
});

// With complex conditions
const expiredJobs = await dbPool.selectWhere('queue_jobs', [
  { column: 'status', value: 'pending' },
  { column: 'runAt', value: Date.now(), operator: '<=' }
]);

// With ordering and limit
const pendingJobs = await dbPool.selectWhere('queue_jobs', {
  column: 'status',
  value: 'pending'
}, undefined, {
  orderBy: { column: 'priority', direction: 'desc' },
  limit: 100
});
```

#### Select One

```typescript
const job = await dbPool.selectOne('queue_jobs', {
  column: 'id',
  value: 'job-123'
});
```

#### Query with Agent Shadows

```typescript
await dbPool.beginWork('agent-1');  // Start agent transaction
await dbPool.push({ /* ... */ }, undefined, 'file-1'); // Apply to shadow
await dbPool.commitWork('agent-1'); // Flushed atomically
```

### Transaction Patterns

#### Simple Transaction

```typescript
await dbPool.push({
  type: 'insert',
  table: 'work',
  values: { id: 'w-1', status: 'started', startAt: Date.now() }
});

await dbPool.runTransaction(async (agentId) => {
  await dbPool.push({
    type: 'update',
    table: 'work',
    values: { status: 'processing' }
  }, agentId);
  
  await dbPool.push({
    type: 'insert',
    table: 'audit_events',
    values: { type: 'started', data: '...' }
  }, agentId);
});

// If any step fails: rollback happens automatically
```

#### Lock-Free Transaction (No Acquire)

```typescript
// No stateMutex acquire - lock-free if agent exists
await dbPool.beginWork('agent-1');
try {
  await dbPool.push(..., 'agent-1');
  await dbPool.commitWork('agent-1');
} catch (e) {
  await dbPool.rollbackWork('agent-1');
}
```

---

## 3. SqliteQueue Pipeline

### Queue Modes

BroccoliQ provides two processing modes:

#### Mode 1: Individual Job Processing

```typescript
async function processJob(job: QueueJob<{ data: string }>) {
  console.log('Processing:', job.payload.data);
}

await queue.process(processJob, {
  concurrency: 500,
  batchSize: 500,
  pollIntervalMs: 1
});
```

**How it differs from Mode 2:**
- Jobs processed one-by-one
- Individual job failures trigger retry logic
- Higher I/O overhead (still batched on backend)

#### Mode 2: True Batch Processing

```typescript
async function processBatch(jobs: QueueJob<{ data: string }>[]) {
  console.log(`Processing batch of ${jobs.length} jobs`);
  // Process entire batch as one logical operation
}

await queue.processBatch(processBatch, {
  concurrency: 5,           // Only 5 batches at a time
  batchSize: 1000,          // 1000 jobs per batch
  maxInFlightBatches: 5,    // Pipelined
  completionFlushMs: 1,
  pollIntervalMs: 1
});
```

**When to use each:**
- **Mode 1**: Individual jobs with unique I/O needs
- **Mode 2**: Homogeneous operations (bulk file uploads, logging, analytics)

### Queue Options

```typescript
const queue = new SqliteQueue({
  // Visibility timeout: jobs stuck this long are reclaimed
  visibilityTimeoutMs: 300000, // 5 minutes default
  
  // Done jobs older than this are pruned
  pruneDoneAgeMs: 86400000,    // 24 hours default
  
  // Default max attempts for new jobs
  defaultMaxAttempts: 5,
  
  // Base delay for retry (exponential backoff)
  baseRetryDelayMs: 1000       // 1 second
});
```

### Job Lifecycle

```typescript
// Enqueue
const jobId = await queue.enqueue({
  type: 'metric',
  value: 123
}, {
  priority: 10,
  delayMs: 5000,    // Run in 5 seconds
  id: 'custom-id'   // Optional custom ID
});

// Process
await queue.process(async (job) => {
  // job.payload contains our typed data
  console.log(job.payload);
  
  // Complete
  await queue.complete(job.id);
  
  // Fail with retry
  throw new Error('Temporary error');
}, {
  concurrency: 500
});

// Internal job status progression
pending → processing → done   [success]
pending → processing → failed  [max attempts]
```

### Priority & Delay

```typescript
// High priority job
await queue.enqueue(
  { task: 'critical' },
  { priority: 100 } // Higher = dequeued first
);

// Delayed job
await queue.enqueue(
  { task: 'scheduled' },
  { delayMs: 60000 } // Run in 60 seconds
);

// Priority + delay
await queue.enqueue(
  { task: 'urgent-scheduled' },
  { priority: 50, delayMs: 120000 } // Deferred but still high priority
);
```

### Pipeline Concurrency

The queue operates on a **pipeline model**:

```
limit: 500
workers: 5
   
[ Dequeue 2x ] → [ Hand to 5 workers ] → [ Workers process ] → [ Return results ]
    1000             500                500                 500
```

**Mechanism:**
- Dequeues `limit * 2` jobs
- Divides among `concurrency` workers
- Workers process in parallel
- While running, queue immediately dequeues more

**Benefits:**
- No idle time waiting for processing
- High throughput even with slow handlers
- Pre-fetching hides I/O latency

### Memory-First Dequeue

```typescript
async dequeueBatch(limit: number): Promise<QueueJob<T>[]> {
  // 1. Check local circular buffer first (O(1) pop)
  if (this.bufferSize() > 0) {
    const memoryJobs = this Pull from local buffer
    return memoryJobs;
  }
  
  // 2. If empty, poll database
  return db.query('SELECT * FROM queue_jobs WHERE ... ORDER BY priority DESC');
}
```

**Why memory-first?**
- Local buffer avoids DB queries for hot jobs
- O(1) operation vs O(log N) query
- Pre-fetching fills buffer for next call

### Backpressure Handling

```typescript
const queue = new SqliteQueue({
  concurrency: 500,    // Max simultaneous processing
  batchSize: 500       // Max jobs per batch
});

// When buffer size increases:
// The queue automatically:
// 1. Enqueues immediately (1ms delay)
// 2. If buffer > 100K, triggers immediate flush (0ms delay)
// 3. Logs warning: [DbPool] CRITICAL backpressure
```

**What counts as backpressure?**
- Active buffer > 10,000 jobs: timer reduced to 1ms
- Active buffer > 100,000 jobs: immediate flush
- In-flight ops: current buffer swapped while flush occurs

---

## 4. Increment Coalescing (Level 6)

### What is Increment Coalescing?

Automatic merging of consecutive increment operations to reduce transaction count.

### Example

```typescript
// These operations happen atomically in a single flush:
await dbPool.push({
  type: 'update',
  table: 'metrics',
  values: { count: dbPool.increment(5) }
});

await dbPool.push({
  type: 'update',
  table: 'metrics',
  values: { count: dbPool.increment(3) }
});

// Becomes one operation: count = count + 8
```

### How It Works

```typescript
private groupOps(ops: WriteOp[]): WriteOp[][] {
  const coalescedOps: WriteOp[] = [];
  const updateCache = new Map<string, number>();

  for (const op of ops) {
    if (op.type === 'update' && op.dedupKey) {
      const existingIdx = updateCache.get(op.dedupKey);
      if (existingIdx !== undefined) {
        // Same key, merge values
        const existing = coalescedOps[existingIdx];
        for (const [key, val] of Object.entries(op.values)) {
          if (this.isIncrement(val)) {
            existing.values[key].value += val.value;
          }
        }
        continue;
      }
      updateCache.set(op.dedupKey, index);
    }
    coalescedOps.push(op);
  }
  return groups...
}
```

### Use Cases

#### Counters

```typescript
// Good: Increment coalescing
await dbPool.pushBatch([
  { type: 'update', table: 'counts', values: { hits: dbPool.increment(1) }, where: { column: 'id', value: 'home' } },
  { type: 'update', table: 'counts', values: { hits: dbPool.increment(2) }, where: { column: 'id', value: 'home' } }
]); // Becomes: hits + 3

// Bad: Separate values
await dbPool.push({
  type: 'update',
  table: 'counts',
  values: { hits: 1 + 1 + 1 } // Not atomic
});
```

#### Summation

```typescript
// Track per-hour metrics
await dbPool.push({
  type: 'update',
  table: 'hourly_metrics',
  values: { requests: dbPool.increment(1) },
  where: { column: 'id', value: '2025-03-31-12' }
});

// Coalesces into single transaction
```

---

## 5. Layering Guidelines

### Layer Priority Levels

```typescript
type DbLayer = 'domain' | 'infrastructure' | 'ui' | 'plumbing';

const LAYER_PRIORITY: Record<DbLayer, number> = {
  domain: 0,      // Highest priority
  infrastructure: 1,
  ui: 2,
  plumbing: 3     // Lowest priority
};
```

### Rules

1. **Write Propagation**: Higher layer writes always overwrite lower layer values
2. **Scan Order**: Queries scan in LAYER_PRIORITY order (highest first matches)
3. **Consistency**: Layering guarantees order to disk (schema version ID)

### When to Use Each Layer

#### Domain (0) - Business Logic

```typescript
// Core business state
await dbPool.push({
  type: 'insert',
  table: 'orders',
  values: { id: 'o1', status: 'created' },
  layer: 'domain'
}, 'agent-123');
```

#### Infrastructure (1) - System Operations

```typescript
// System-level operations
await dbPool.push({
  type: 'insert',
  table: 'queue_jobs',
  values: { id: 'j1', status: 'pending' },
  layer: 'infrastructure'
});
```

#### UI (2) - Application State

```typescript
// User interface state
await dbPool.push({
  type: 'update',
  table: 'ui_preferences',
  values: { theme: 'dark' },
  layer: 'ui'
});
```

#### Plumbing (3) - Utilities

```typescript
// Internal helpers
await dbPool.push({
  type: 'insert',
  table: 'cache_entries',
  values: { key: '123', value: '...' },
  layer: 'plumbing'
});
```

### Cross-Layer Safety

```typescript
// Context: Many agents updating same entity
await dbPool.push({ /* agent UI layer */ }, 'agent-1', 'file-1');
await dbPool.push({ /* domain layer */   }, 'agent-2', 'file-1');

// Result: Domain layer wins (priority 0 > 2)
// Guarantees business rules take precedence
```

---

## 6. Safety Patterns

### Database Configuration

```typescript
// Engine-level optimisations (automatic from Config.ts)
PRAGMA journal_mode = WAL;     // Non-blocking reads
PRAGMA synchronous = NORMAL;   // Durability without blocking
PRAGMA mmap_size = 2147483648; // Memory-mapped I/O
PRAGMA threads = 4;           // Parallel execution
```

Batched operations automatically use these settings.

### Use Transactions Correctly

```typescript
// ✅ Good: Agent-scoped transaction
await dbPool.runTransaction(async (agentId) => {
  await dbPool.push({ /* first op */ }, agentId);
  await dbPool.push({ /* second op */ }, agentId);
  // Atomic commit or rollback
});

// ❌ Bad: Transaction without agent (results in multiple writes)
await dbPool.push({ first op */ });
await dbPool.push({ /* second op */ });
```

### Safe Error Handling

```typescript
try {
  await dbPool.push({ /* operation */ });
} catch (e) {
  const err = e as { code?: string, message?: string };
  
  // Retryable: Re-queue the operation
  if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(err.code || '')) {
    // Push to a separate retry queue
    await retryQueue.push(job);
  }
  
  // Non-retryable: Log and continue
  else {
    console.error('Permanent failure:', err.message);
  }
}
```

### Graceful Shutdown

```typescript
async function gracefulShutdown(signal: 'SIGTERM' | 'SIGINT') {
  console.log(`Received ${signal}, shutting down...`);
  
  // 1. Stop accepting new jobs
  queue.stop();
  
  // 2. Wait for in-flight jobs
  // SqliteQueue automatically handles this
  
  // 3. Flush any remaining operations
  await dbPool.flush();
  
  // 4. Close database
  await dbPool.stop();
  
  console.log('Shutdown complete');
}

process.on(signal, gracefulShutdown);
```

---

## 7. Failure Recovery

### Automatic Retry Logic

```typescript
async fail(id: string, error: string) {
  const job = await dbPool.selectOne('queue_jobs', {
    column: 'id',
    value: id
  });
  
  if (!job) return;
  
  // Exponential backoff: 2^(attempts-1) * baseDelay
  const nextDelay = 2 ** (job.attempts - 1) * this.baseRetryDelayMs;
  
  if (job.attempts < job.maxAttempts) {
    // Soft fail: Re-queue with delay
    await dbPool.push({
      type: 'update',
      table: 'queue_jobs',
      values: { 
        status: 'pending', 
        runAt: Date.now() + nextDelay 
      },
      where: { column: 'id', value: id }
    });
    
    console.warn(`Job ${id} failed. Retrying in ${nextDelay}ms...`);
  } else {
    // Hard fail: Mark permanently failed
    await dbPool.push({
      type: 'update',
      table: 'queue_jobs',
      values: { 
        status: 'failed', 
        error 
      },
      where: { column: 'id', value: id }
    });
    
    console.error(`Job ${id} failed permanently`);
  }
}
```

**Retry Pattern:**
- Attempts 0-4: Exponential backoff (1s, 2s, 4s, 8s, 16s)
- Attempt 5+: Permanent failure (DLQ)

### Stale Job Reclamation

```typescript
async reclaimStaleJobs(): Promise<number> {
  const now = Date.now();
  const threshold = now - this.visibilityTimeoutMs;
  
  // Find jobs stuck in processing
  const staleJobs = await dbPool.selectWhere('queue_jobs', [
    { column: 'status', value: 'processing' },
    { column: 'updatedAt', value: threshold, operator: '<' }
  ]);
  
  if (staleJobs.length === 0) return 0;
  
  // Revert to pending (new visibilityTimeout)
  await dbPool.pushBatch(
    staleJobs.map(job => ({
      type: 'update',
      table: 'queue_jobs',
      values: { status: 'pending', updatedAt: now },
      where: { column: 'id', value: job.id }
    }))
  );
  
  console.warn(`Reclaiming ${staleJobs.length} stale jobs`);
  return staleJobs.length;
}
```

**Triggered by:**
- Background maintenance loop (every 30s)
- Visible when job.processing.time > visibilityTimeout

### Failure Isolation

```typescript
// Batch processing with fault isolation
const_jobs = await queue.dequeueBatch(1000);

for (const job of jobs) {
  try {
    await processJob(job);
    await queue.complete(job.id);
  } catch (err) {
    // Job-level failure: individual retry
    await queue.fail(job.id, err.message);
  }
}
```

**Failure Types:**
1. **Job-level**: Individual retry (up to max attempts)
2. **Batch-level**: All failed jobs in batch sent to DLQ
3. **Worker-level**: Agent crashes → worker restarts → no data loss

Recovery happens via:
- Stale job reclaim
- Automatic retry on re-enqueue
- Mapper crash recovery (last known state from DB)

---

## 8. Performance Optimization

### Choose the Right Batch Size

```typescript
// High latency handler (e.g., HTTP requests)
const queue = new SqliteQueue({
  pollIntervalMs: 10,      // Wait longer for large batches
  batchSize: 100          // Single batch, then process
});

// Low latency handler (e.g., simple logging)
const queue = new SqliteQueue({
  pollIntervalMs: 1,       // Poll frequently
  batchSize: 1000         // Many small batches
});
```

### Coalesce Increments

```typescript
// ✅ Good: Increment coalescing
const updates = jobs.map(job => ({
  type: 'update',
  table: 'counts',
  values: { processed: dbPool.increment(1) },
  where: { column: 'id', value: job.userId }
}));
await dbPool.pushBatch(updates); // 1 flush, coalesced

// ❌ Bad: Separate updates
for (const job of jobs) {
  await dbPool.push({
    type: 'update',
    table: 'counts',
    values: { processed: job.count },
    where: { column: 'id', value: job.userId }
  });
} // N flushes
```

### Use Chunked Raw SQL

```typescript
// Level 3: Operations > 100 insert automatically use chunked raw SQL
// 100 ops per chunk, 2000 pre-allocated parameters
// Avoids Kysely query planning overhead
```

### Warm Up Critical Tables

```typescript
// Level 9: Preload indexes on startup
async function warmup() {
  const queue = new SqliteQueue({ concurrency: 500 });
  
  // Warm queue_jobs table for "pending" status
  const pendingCount = await dbPool.warmupTable(
    'queue_jobs',
    'status',
    'pending'
  );
  
  console.log(`Warmed ${pendingCount} pending jobs for O(1) queries`);
}
```

**Benefits:**
- No DB query for pending jobs
- Instant results (in-memory index)
- Reduces query latency to near-zero

### Monitor Metrics

```typescript
const metrics = dbPool.getMetrics();
console.log('Metrics:', {
  buffer: { active: metrics.activeBufferSize },
  inFlight: metrics.inFlightOpsSize,
  transactions: metrics.totalTransactions,
  latencies: metrics.latencies
});
```

**Read from this output:**
- `latencies.p99_proc > 50ms`: Flush bottleneck
- `latencies.p99_enq > 100ms`: Agent contention
- `activeBufferSize > 100K`: Backpressure approaching

---

## 9. Monitoring & Metrics

### BufferState Check

```typescript
setInterval(() => {
  const metrics = dbPool.getMetrics();
  
  if (metrics.activeBufferSize > 100000) {
    console.warn('⚠️ Backpressure warning:', metrics.activeBufferSize);
  }
  
  if (metrics.totalTransactions > 0 && Date.now() % 5000 === 0) {
    console.log(`Throughput: ${metrics.totalTransactions} txs`);
  }
}, 10000);
```

### Queue Metrics

```typescript
const queueMetrics = await queue.getMetrics();
console.log('Queue Status:', {
  pending: queueMetrics.pending,
  processing: queueMetrics.processing,
  done: queueMetrics.done,
  failed: queueMetrics.failed
});

// Total + active (not yet flushed)
const totalSize = await queue.size();
console.log('Total pending:', totalSize);
```

### Latency Tracking

```typescript
const metrics = dbPool.getMetrics();

if (metrics.latencies.p99_proc > 100) {
  console.warn('Flush latency p99 too high');
}

if (metrics.latencies.p99_enq > 50) {
  console.warn('Enqueue latency p99 too high');
}
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Flush latency p95 | 50ms | 100ms |
| Enqueue latency p99 | 100ms | 200ms |
| Backpressure buffer | 50K ops | 100K ops |
| Failed jobs | >100/hour | >1000/hour |

---

## 10. Scaling Strategies

### Vertical Scaling (Single Worker)

```typescript
// Single worker, unlimited concurrency
const db = await BufferedDbPool.initialize();

const queue = new SqliteQueue({
  concurrency: 1000,   // Very high concurrency
  batchSize: 1000
});

await queue.process(handler, {
  concurrency: 1000,
  pollIntervalMs: 1,
  completionFlushMs: 10
});

// Tracks: 1 worker + 1 buffer + 1 flush loop
// Throughput: 10K-50K ops/sec
```

**When to use:**
- Over 10K concurrent operations
- Monolithic application
- Simple deployment

### Horizontal Scaling (Multiple Workers)

```typescript
// Workers using same database file
// Distributed across multiple servers

const workers = [
  { host: 'worker-1', concurrency: 500 },
  { host: 'worker-2', concurrency: 500 },
  { host: 'worker-3', concurrency: 500 }
];

for (const worker of workers) {
  const url = `http://${worker.host}/queue`;
  // Your load balancer distributes jobs to workers
}

// Shared database file addresses:
// - PAUSE ON WAL Lock: Check if SQLite DB is busiest machine
// - Reduce concurrency on high-latency workers
```

### Resource Distribution

```
Worker A (high CPU): concurrency=800, pollIntervalMs=1
Worker B (low CPU):  concurrency=200, pollIntervalMs=10
Worker C (I/O bound):concurrency=1000, batchSize=2000

Result: Distribute load based on worker capabilities
```

### Memory Management

```typescript
// Monitor active buffer size:
const metrics = dbPool.getMetrics();
if (metrics.activeBufferSize > 1000000) {
  // Swallow backpressure:
  await dbPool.flush();
  // Or reduce concurrency:
  queue.stop();
}
```

---

## 11. Troubleshooting

### Issue: Slow Flushes (< 100ms)

**Diagnosis:**
```typescript
const metrics = dbPool.getMetrics();
console.log('Latencies:', metrics.latencies);
```

**Solutions:**
1. **Reduce batch size** (improve Partial Sort performance)
2. **Use chunked raw SQL** (Level 3 optimize)
3. **Check if using WAL mode**: `PRAGMA journal_mode`
4. **Kill blocking transactions**: Look for long-running agent transactions

### Issue: Backpressure Warning

**Symptoms:**
```
[DbPool] CRITICAL backpressure: activeBuffer length is 100050
```

**Solutions:**
1. Increase worker count
2. Reduce operation count per flush
3. Call `dbPool.flush()` manually
4. Add `dbPool.warmupTable()` for read-heavy patterns

### Issue: Jobs Sticking in Processing

**Symptoms:**
```
[SqliteQueue] Reclaiming 125 stale jobs.
```

**Solutions:**
1. Increase `visibilityTimeoutMs` (jobs processed slowly)
2. Process stalled jobs with `await queue.reclaimStaleJobs()`
3. Check worker health (crashed workers)

### Issue: High GC Overhead

**Symptoms:**
- >5% CPU used for GC
- Slow enqueue latency

**Solutions:**
1. Use `pushBatch` instead of multiple `push` calls
2. Reuse parameter buffer (automatic at Level 3)
3. Reduce memory-first buffer size: `maxMemoryBufferSize = 100000`

### Issue: Transaction Deadlocks

**Symptoms:**
```
Error: SQLITE_BUSY (database is locked)
```

**Solutions:**
1. Reduce concurrency
2. Use single-agent transactions (no cross-agent contention)
3. Increase `visibilityTimeoutMs`
4. Check for sequential parallel updates (should be batched)

---

## 12. Advanced Patterns

### Pattern: Computed Fields

```typescript
async function processEvents(events: Event[]) {
  // Aggregate into single batch
  const updates = events.map(event => ({
    type: 'update',
    table: 'gauges',
    values: {
      currentValue: dbPool.increment(1)
    },
    where: { column: 'name', value: event.name }
  }));
  
  await dbPool.pushBatch(updates);
}
```

### Pattern: Time-Series Aggregation

```typescript
// Batch写入当前时间窗口
const windowId = Math.floor(Date.now() / 3600000); // Hourly
const updates = [
  {
    type: 'insert',
    table: 'hourly_stats',
    values: {
      id: `${windowId}-hourly`,
      interval: 'hour',
      startAt: windowId * 3600000
    }
  },
  {
    type: 'update',
    table: 'hourly_stats',
    values: { total_values: dbPool.increment(1) },
    where: { column: 'id', value: `${windowId}-hourly` }
  }
];
```

### Pattern: Conflict Resolution

```typescript
// Use conflictTarget for idempotent updates
await dbPool.push({
  type: 'upsert',
  table: 'upsert_test',
  values: { id: 'key-1', value: 'new value' },
  conflictTarget: 'id',
  where: { column: 'id', value: 'key-1' }
});

// If key-1 exists: update value
// If key-1 doesn't exist: insert new row
```

### Pattern: Audit Trail

```typescript
async function updateAsset(assetId: string) {
  const oldState = await dbPool.selectOne('assets', { column: 'id', value: assetId });
  
  await dbPool.runTransaction(async (agentId) => {
    // Update asset (infrastructure layer)
    await dbPool.push({
      type: 'update',
      table: 'assets',
      values: { status: 'updated' },
      where: { column: 'id', value: assetId },
      layer: 'infrastructure'
    }, agentId);
    
    // Log audit event (plumbing layer)
    await dbPool.push({
      type: 'insert',
      table: 'audit_log',
      values: {
        timestamp: Date.now(),
        assetId,
        oldStatus: oldState?.status,
        newStatus: 'updated'
      },
      layer: 'plumbing'
    }, agentId);
  });
}
```

---

## Summary

BroccoliQ is designed for **scale-first thinking**:

1. **Write operations that never block** → dual buffer swaps
2. **Read operations that never wait** → memory-first + indexes
3. **Failures that never lose data** → retries + recovery + careful layering
4. **Queues that never idle** → pipeline backpressure + pre-fetching

When you need to process 10K+ operations per second, BroccoliQ is your infrastructure layer.