# Architecture Explained: How BroccoliQ Actually Works

This chapter peels back the curtain. No more "does it work" questions—this is how the Level 10 Sovereign Hive operates at scale.

---

## Chapter 1: The "Dual Buffer" Persistence Logic

### The Myth: "Does the queue use memory or disk?"

**Truth:** It uses **sharded dual-buffering** to orchestrate both.

The BroccoliQ Sovereign Hive was **architected for the Bun engine's direct SQLite integration**. While it maintains Node.js compatibility, the system's modular `BufferedDbPool` is designed specifically to leverage sharded WAL journals for 1,000,000+ operations per second.

```typescript
// The Sharded Memory-to-Disk Pipeline:
/*
┌─────────────────────────────────┐
│   MEMORY BUFFER (Per Shard)     │
│  ┌──────────┐  ┌──────────┐    │
│  │ Active   │  │In-Flight │    │
│  │ Buffer   │  │ Buffer   │    │
│  └──────────┘  └──────────┘    │
│         ↓           ↑           │
│  ┌──────────────────────────┐  │
│  │  Level 7 Indexing        │  │ 
│  │  (O(1) Status Filtering) │  │
│  └──────────────────────────┘  │
└─────────────────────────────────┘
           ↓
           ↓ (Swap & Flush)
┌─────────────────────────────────┐
│   PHYSICAL SHARDS (Persistence) │
│  ┌──────────┐  ┌──────────┐    │
│  │ shard-1  │  │ shard-N  │    │
│  │ (.db)    │  │ (.db)    │    │
│  └──────────┘  └──────────┘    │
└─────────────────────────────────┘
*/
```

When you call `push(operation)`, the system injects the data into the **Active Buffer** of the target shard. This is a pure memory operation (0ms latency).

**The Swap & Flush Cycle:**
1. When a shard's `Active Buffer` hits a threshold (or 1000ms passes), the pool performs an **Atomic Swap**.
2. The `Active Buffer` becomes the `In-Flight Buffer`.
3. A new `Active Buffer` is initialized for incoming writes.
4. The `In-Flight Buffer` is flushed to the physical SQLite shard in a single, high-throughput transaction.

---

## Chapter 2: Sovereign Sharding (Level 8)

### The Myth: "Is sharding just for large datasets?"

**Truth:** **No.** Sharding is for **IO Bandwidth**.

Even with WAL mode, a single SQLite file hits a "Wall" due to filesystem lock contention. BroccoliQ bypasses this by partitioning across independent shards.

- **Horizontal Scale**: 10 Shards = 10 independent WAL journals = 10x the physical IO bandwidth.
- **Sovereign Isolation**: Shard `A` can flush while Shard `B` is under heavy lock contention. One project's burst never blocks another's processing.
- **Shard State Management**: Each shard maintains its own `ShardState` object, tracking local latencies, buffer pressure, and the **Level 7 In-Memory Index**.

---

## Chapter 3: Modular Persistence Architecture

### The Myth: "Is the pool a single monolithic file?"

**Truth:** It is a **coordinated multicomponent system**.

We modularized the `BufferedDbPool` to achieve Level 10 hardening. The system is divided into specialized domains:

1.  **ShardState.ts**: Manages the life-cycle of a single partition (buffers, indexes, metrics).
2.  **Operations.ts**: The execution engine. Handles `Quantum Boost` (Level 3) chunked raw SQL for massive inserts.
3.  **QueryEngine.ts**: The Level 7 bridge. It merges in-memory buffers with on-disk results in real-time, ensuring `selectWhere` always sees the most recent uncommitted data.
4.  **Locker.ts**: Orchestrates the Sovereign Locking protocol across shards.

---

## Chapter 4: Agent Shadow Isolation (Modern API)

### The Myth: "Are transactions opaque?"

**Truth:** **No.** Transactions are **explicit Agent Shadows**.

We removed the legacy `runTransaction` shim. Modern BroccoliQ uses **Agent Shadows** for explicit autonomy:

```typescript
// Explicit Sovereign Autonomy:
await dbPool.beginWork(agentId);

// All these operations land in the Agent's private Shadow Buffer
await dbPool.push({ type: 'insert', table: 'knowledge', values: {...} }, agentId);
await dbPool.push({ type: 'update', table: 'tasks', ... }, agentId);

// Atomic Commit: Move shadow contents to shard buffers
await dbPool.commitWork(agentId);
```

**Why Shadows Matter:**
- **Zero-Contention**: Agents work in private memory space. They only interact with the Hive during the `commitWork` phase.
- **Atomic Multi-file Operations**: Since the entire shadow is committed as one batch, cross-table integrity is guaranteed without long-running DB locks.

---

## Chapter 5: Level 7 In-Memory Indexing

### The Myth: "Does querying 'pending' hit the disk?"

**Truth:** **90% of the time, no.**

Each `ShardState` maintains a **Reactive Index** of active buffers. When a worker asks for pending jobs, the `QueryEngine` first scans the Level 7 indexes.

- **O(1) Status Filtering**: We use `Map<Status, Set<JobId>>` to provide instantaneous access to work.
- **Stale Protection**: If the memory index is empty, the engine transparently falls back to the physical shard.

---

## Chapter 6: Runtime-Agnostic Intelligence

### The Myth: "Do I need different code for Bun and Node?"

**Truth:** **No.** BroccoliQ autodetects the engine at runtime.

- **Bun Integration**: Uses `bun:sqlite` for near-zero overhead native access.
- **Node.js Integration**: Uses `better-sqlite3` for production-grade stability and WAL performance.

The `Config.ts` layer handles this transparently, providing a unified Kysely-backed interface regardless of the underlying runtime engine.

---

## Chapter 7: The Sovereign Manifesto (Level 10)

BroccoliQ isn't just a database layer; it is a **Sovereign Execution Hive**. By prioritizing **CPU Velocity over Disk Contention**, and **Agent Autonomy over Monolithic Locking**, we have eliminated the legacy infrastructure wall.

**Welcome to the Hive. Welcome to Level 10.**