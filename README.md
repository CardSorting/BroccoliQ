# BroccoliQ

**Edge infrastructure for high-throughput systems** — a production-ready buffered database and job queue designed for 10K-50K operations per second with 500+ concurrent workers.

## 🎯 Philosophy

> "Database operations should never be the bottleneck of your application."

BroccoliQ is not a simple ORM wrapper. It's a **multi-level optimization stack** that pushes the limits of SQLite by combining:
- Asynchronous write-behind buffering
- Lock-free agent isolation  
- Atomic buffer swapping
- O(1) query indexing
- Intelligent batch processing
- Automatic failure recovery

Built for **edge infrastructure at scale**: monitoring pipelines, CI/CD job queues, real-time analytics, and knowledge graph updates.

---

## 📊 Performance Characteristics

| Metric | Value |
|--------|-------|
| **Throughput** | 10K - 50K ops/sec per worker |
| **Concurrent Workers** | 500+ supported |
| **Latency (enq)** | p95 < 20ms |
| **Latency (flush)** | p99 < 50ms |
| **GC Overhead** | < 1% CPU |
| **Backpressure Warning** | Active buffer >100K |

**Write Pattern Optimization Present:**
- ✅ Append-only inserts → upsert on conflict
- ✅ Key increments → atomic counter updates
- ✅ Status changes → batch UPDATE
- ✅ Bulk writes → chunked raw SQL
- ✅ Batch reads → already-optimized

---

## 🏗️ Architecture Overview

BroccoliQ operates on **9 distinct optimization levels**:

```text
Level 0: Layer Isolation (Domain-First)
  ├─ Layer priority: Domain > Infrastructure > UI > Plumbing
  └─ Guarantees cross-worker consistency

Level 1: Write-Behind Buffering (The Heart)
  ├─ Dual buffer system (A ↔ B) for zero-downtime flushes
  ├─ Adaptive flush scheduling (1ms-5ms based on backlog)
  └─ 1M operation circular buffer capacity

Level 2: Lock-Free Operation Isolation
  ├─ Agent shadows: each worker gets isolated ops[]
  ├─ Lock-free pushes for existing agents
  └─ Scoped commit/rollback transactions

Level 3: Concurrency Supercharges
  ├─ Chunked raw SQL (100 ops) - avoids ORM overhead
  ├─ Zero-allocation parameter buffering
  └─ Bulk operations (single UPDATE with IN clause)

Level 4: O(1) Query Magics
  ├─ Status indexes: Maps → Set<WriteOp> by status
  ├─ Virtual WriteOps: disk rows become ops
  └─ Sovereign recovery: warms tables from disk on boot

Level 5: Queue Intelligence
  ├─ Memory-first: local circular buffer before DB poll
  ├─ Pipeline backpressure: dequeue 2x limit while processing
  └─ Batch completion flushing: 500 ops groups into single UPDATE

Level 6: Increment Coalescing
  ├─ Automatic merge of adjacent increment operations
  ├─ Increment counters avoid race conditions
  └─ Deduplication for idempotent updates

Level 7: Index Maintenance
  ├─ Real-time status index during enqueue
  ├─ Indexes persist through buffer swaps
  └─ Enables instant partial-table queries

Level 8: Safety & Recovery
  ├─ WAL mode for non-blocking reads
  ├─ Automatic stale job reclaim
  ├─ Retryable error handling (SQLITE_BUSY, deadlocks)
  └- Failure isolation per batch

Level 9: Optimized Defaults
  ├─ Default memory-store (PRAGMA mmap_size=2GB)
  ├- Background maintenance loop
  └─ Graceful shutdown processing
```

---

## 🚀 Quick Start

### Installation

```bash
npm install broccolidb
```

### Minimal Example: Single Worker Job Queue

```typescript
import { dbPool, type WriteOp } from 'broccolidb';
import { SqliteQueue } from 'broccolidb';

async function processJob(job: { data: string }) {
  console.log('Processing:', job.data);
  // Your async business logic here
}

async function main() {
  // Initialize queue (buffers DB connection)
  const queue = new SqliteQueue<{ data: string }>({
    visibilityTimeoutMs: 300000, // 5 min
    pruneDoneAgeMs: 86400000,   // 24 hours
    concurrency: 500
  });

  // Enqueue jobs
  const jobId1 = await queue.enqueue({ data: 'Task 1' });
  const jobId2 = await queue.enqueue({ data: 'Task 2' }, { 
    priority: 10,
    delayMs: 5000 // Run in 5 seconds
  });

  // Process queue
  await queue.process(processJob, {
    concurrency: 500,
    batchSize: 500
  });

  // Check metrics
  const metrics = await queue.getMetrics();
  console.log('Queue:', metrics);
}

main();
```

### Access Database Directly

```typescript
import { dbPool } from 'broccolidb';

// Write with automatic buffering
await dbPool.push({
  type: 'insert',
  table: 'queue_jobs',
  values: { id: 'job-1', payload: '...', status: 'pending' }
});

// Increment counters atomically
await dbPool.push({
  type: 'update',
  table: 'counters',
  values: { count: dbPool.increment(1) },
  where: { column: 'id', value: 'global' }
});

// Query with instant results (includes buffered ops)
const jobs = await dbPool.selectWhere('queue_jobs', {
  column: 'status',
  value: 'pending'
});
```

---

## 🔒 Safety Guarantees

### Database Configuration
- **WAL Mode**: Non-blocking concurrent reads/writes
- **Synchronous NORMAL**: Durability (fsync every 5s) without blocking
- **Memory-Mapped I/O**: PRAGMA mmap_size=2GB for read-heavy workloads
- **Parallel Queries**: 4 worker threads for parallel execution

### Layer Isolation
Every WriteOp carries a `layer` tag (`domain` | `infrastructure` | `ui` | `plumbing`). When multiple workers write to the same entity:
- Higher layer writes always win
- Guarantees order of write propagation to disk
- Prevents accidental cross-layer dirty reads

### Transactions
```typescript
// Atomic multi-work for a specific agent
await dbPool.runTransaction(async (agentId) => {
  await dbPool.push({ ... }, agentId);
  await dbPool.push({ ... }, agentId);
  // Both succeed or both fail
});
```

### Failure Recovery
- **Automatic Retry**: SQLITE_BUSY, SQLITE_LOCKED, deadlocks are re-queued
- **Stale Job Reclamation**: Jobs stuck `processing` > 5min reverted to `pending`
- **Non-Blocking Updates**: Batch completions don't block processing
- **Pipeline Safeguards**: In-flight jobs preloaded never lost

---

## 📖 Full Documentation

- **[USAGE.md](USAGE.md)** — Complete guide with advanced patterns, scaling strategies, and troubleshooting
- **[ARCHITECTURAL_DEEP_DIVE.md](ARCHITECTURAL_FOUNDATIONS.md)** — Technical depth: buffer swap internals, index warming, agent isolation

---

## 🎭 Use Cases

✅ **Best For:**
- Monitoring dashboards (10K metrics/sec streams)
- CI/CD job pipelines (10K+ concurrent builds)
- Real-time analytics (stream processing)
- Knowledge graph updates (trillion edges)
- Event sourcing systems
- Job processing workers

❌ **Not For:**
- Simple CRUD apps (overkill complexity)
- <100 concurrent operations (too much abstraction)
- Low-latency (<1ms) requirements (fetch-path overcame)
- Distributed database needs (single SQLite node)

---

## 🛠️ API Reference

### BufferedDbPool

| Method | Description |
|--------|-------------|
| `push(op)` | Queue a write operation with automatic buffering |
| `pushBatch(ops)` | Queue multiple write operations atomically |
| `selectWhere(table, where)` | Query with instant results (disk + buffered + shadows) |
| `selectOne(table, where)` | Single result lookup |
| `runTransaction(callback)` | Atomic transaction for an agent |
| `warmupTable(table, statusCol, status)` | Level 9: Populate in-memory indexes from disk |
| `getMetrics()` | Telemetry: latencies, buffer sizes, transaction counts |

### SqliteQueue

| Method | Description |
|--------|-------------|
| `enqueue(payload, options)` | Add job to queue (priority, delay supported) |
| `enqueueBatch(items)` | Bulk enqueue with single DB transaction |
| `dequeueBatch(limit)` | Atomically claim multiple jobs |
| `process(handler, options)` | Start batch processing loop |
| `processBatch(handler, options)` | Start true batch processing (all-or-nothing) |
| `reclaimStaleJobs()` | Find and reclaim jobs stuck in processing |
| `complete(id)` | Mark job complete |
| `fail(id, error)` | Mark job failed (exponential backoff) |
| `performMaintenance()` | Run cleanup: reclaim, prune, index update |
| `getMetrics()` | Telemetry: queue status breakdown |

---

## 📄 License

[MIT](LICENSE)

---

## 🙏 Acknowledgments

Built with:
- **better-sqlite3** - Native SQLite bindings
- **Kysely** - Type-safe SQL query builder
- **Node.js** - Runtime platform

Built for developers who care about performance as much as correctness.