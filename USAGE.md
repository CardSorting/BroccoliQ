# Usage Guide: From First Order to Total Sovereignty 🥦

You've read the manifesto. Now you're ready to build with BroccoliQ. This guide takes you from a basic 7-line setup to a horizontally sharded Level 10 Hive.

---

## 1. Quick Reference: The Escalation Path

| Level | Scale | Implementation |
| :--- | :--- | :--- |
| **Simple Queue** | < 10k ops/sec | Standard `SqliteQueue` (Single Shard) |
| **High Throughput** | 10k - 100k ops/sec | Optimized `concurrency` + `batchSize` |
| **Sovereign Hive** | 1,000,000+ ops/sec | **Level 8 Sharded Partitioning** |

---

## 2. Environment Setup (Bun Native)

BroccoliQ is a **Bun-native** infrastructure layer. While it maintained Node.js compatibility for stability, the system is uniquely optimized for the **Bun engine's zero-latency N-API integration**.

### 🔥 High-Performance Bun Setup (Recommended)
```bash
bun add broccoliq
bun run index.ts
```

### Universal Node.js Setup
```bash
npm install broccoliq better-sqlite3
node index.js
```

---

## 3. Your First Sovereign Queue (7 Lines)

The complexity of Level 10 is hidden behind a simple, authoritative API.

```typescript
import { SqliteQueue } from 'broccoliq';

// Initialize with 100 parallel workers
const hive = new SqliteQueue({ concurrency: 100 });

// 0ms Latency Memory-First Enqueue
await hive.enqueue({ task: 'synthesize_knowledge', priority: 10 });

// Start the Hive Processor
hive.process(async (job) => {
  console.log(`[Hive] Processing job ${job.id}`);
}, { concurrency: 100 });
```

---

## 4. Scaling Horizontally: Level 8 Sharding

When you hit the physical IO limits of a single SQLite file (~50k-70k writes/sec), it's time to **Shard**.

```typescript
// Shard your workload by domain or project
const projectAlpha = new SqliteQueue({ shardId: 'alpha', concurrency: 500 });
const projectBeta = new SqliteQueue({ shardId: 'beta', concurrency: 500 });

// Each shard creates its own physical WAL journal:
// ./broccoliq_alpha.db
// ./broccoliq_beta.db

await projectAlpha.enqueue({ type: 'signal' });
await projectBeta.enqueue({ type: 'signal' });
```

**Why Shard?**
- **Independent WAL Journals**: One shard's disk flush never blocks another's memory injection.
- **Linear Bandwidth Scale**: 10 Shards = 10x the physical IO bandwidth of your NVMe drive.

---

## 5. Agent Shadows & Atomic Autonomy

For complex operations that require multi-step integrity, use the underlying **Agent Shadow** primitives.

```typescript
import { BufferedDbPool } from 'broccoliq/pool';

const pool = new BufferedDbPool();

async function complexTransaction(agentId: string) {
  // 1. Enter Sovereign Autonomy
  await pool.beginWork(agentId);

  // 2. Perform various isolated modifications
  await pool.push({ table: 'state', type: 'update', values: {...} }, agentId);
  await pool.push({ table: 'audit', type: 'insert', values: {...} }, agentId);

  // 3. Atomic Commit to Shard Buffers
  await pool.commitWork(agentId);
}
```

---

## 6. Pro-Grade Configuration Patterns

### The "High-Burst" Sink (100k+ ops/sec)
```typescript
const queue = new SqliteQueue({
  concurrency: 2000,
  batchSize: 10000,           // Dequeue in large chunks
  maxMemoryBufferSize: 5M,    // 5 million jobs in RAM
  shardId: 'ingest-shard-1'
});
```

### The "Steady State" Processor
```typescript
const queue = new SqliteQueue({
  concurrency: 50,            // Low parallel pressure
  pollIntervalMs: 100,        // Conservative polling
  visibilityTimeoutMs: 10m    // Long reclamation window
});
```

---

## 7. The Production Checklist

- [ ] **Graceful Shutdown**: Always call `await queue.stop()` to flush in-flight shards.
- [ ] **Type Hardened**: Payloads are strictly typed (Level 10 Hardening).
- [ ] **Shard Monitored**: P99 enqueue latency is < 1ms.
- [ ] **Integrity Audited**: `IntegrityWorker` is active for periodic physical repairs.

---
**Status**: `Usage Guide Hardened` | **Level**: `10` | **Philosophy**: `Latency is a Choice`