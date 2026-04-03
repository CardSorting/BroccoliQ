# Deep Dive: The Sovereign FAQ 🥦

This document addresses the nuanced technical questions regarding the **BroccoliQ Level 10 Hive**. It covers sharding, agent autonomy, and professional-grade persistence patterns.

---

## 🏛️ General Hive Questions

### Q: Why move from a monolithic pool to a modular sharded architecture?
**A:** Scalability and maintainability. A single `BufferedDbPool.ts` was an IO bottleneck and a "type hazard." By modularizing into `ShardState`, `QueryEngine`, and `Operations`, we achieved:
1. **Level 8 Sharding**: Horizontal partition across multiple WAL journals.
2. **Level 10 Hardening**: Strict, zero-`any` type safety.
3. **Operational Clarity**: Separation of Concern between buffer management and SQL generation.

### Q: Does BroccoliQ replace my primary database?
**A:** No. BroccoliQ is a **High-Performance Ingestion and Coordination Hive**. It sits in front of your long-term storage, absorbing 1,000,000+ ops/sec and serializing them into durable SQLite shards. Think of it as the "Adrenal Gland" of your infrastructure.

---

## 🚀 Performance & Sharding (Level 8)

### Q: When should I start sharding?
**A:** **Shard early, shard often.** While a single shard can handle ~50,000 ops/sec, sharding allows you to bypass the physical IO limit of the filesystem. If you have naturally isolated domains (e.g., separate projects or users), give them each a `shardId`.

### Q: What is the "Quantum Boost" (Level 3)?
**A:** It is our internal high-scale ingestion engine. When a flush cycle exceeds 100 operations, the `Operations.ts` component bypasses standard ORM logic for **Chunked Raw SQL** using pre-allocated parameter buffers. This reduces GC pressure and maximizes CPU-to-Disk throughput.

---

## 🛡️ Agent Autonomy & Shadows

### Q: Why was `runTransaction` removed in favor of Agent Shadows?
**A:** The legacy `runTransaction` shim was opaque and often led to long-held database locks. **Agent Shadows** (`beginWork`/`commitWork`) provide explicit autonomy:
- Agents compute in their own private memory space.
- They only interact with the Hive during the `commitWork` phase.
- This ensures **Zero-Contention** during 99% of the agent's lifecycle.

### Q: How do I handle cross-shard transactions?
**A:** Each shard is a sovereign persistence boundary. For cross-shard consistency, use the **Sovereign Locking** protocol (`Locker.ts`) to coordinate agents before they commit their respective shadows to different shards.

---

## 💎 Integrity & Sustainability

### Q: How does the "Self-Healing" mechanism work?
**A:** The **Integrity Worker** performs periodic **Physical Audits**. It scans shards for corruption, reclaims orphans from crashed agents (via `visibilityTimeoutMs`), and prunes stale telemetry based on your `pruneDoneAgeMs` policy.

### Q: Is BroccoliQ really "Zero-Shim"?
**A:** Yes. We have removed all transitional compatibility layers. The API now forces you to use granular, modern primitives, ensuring your implementation is as high-performance as the core engine.

---
**Status**: `Sovereign FAQ Hardened` | **Level**: `10` | **Version**: `Zero-Shim`