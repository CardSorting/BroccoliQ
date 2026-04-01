# BroccoliDB: Real-World Scenarios

This guide provides practical architectural patterns for common multi-agent and high-throughput infrastructure challenges.

---

## 🚀 Scenario A: High-Throughput Telemetry Ingest

**Problem:** 100+ agents generating constant logs, token counts, and performance metrics. Writing each one to disk individually would saturate physical IO.

**Solution: Level 3 Quantum Boost**
- **Strategy**: Use specialized batch buffers with chunked raw `INSERT` operations.
- **Workflow**:
    1.  Agents enqueue telemetry into a local in-memory shadow.
    2.  `BufferedDbPool` accumulates 1,000+ entries.
    3.  A single physical transaction writes all telemetry in ~5ms.

**Result**: Throughput exceeds **1.5 Million ops/sec** while maintaining ACID durability.

---

## 👩‍💻 Scenario B: Collaborative Agent Coding

**Problem:** Multiple autonomous agents (e.g., Linter Agent and Refactor Agent) both want to modify `utils.ts` at the same time.

**Solution: Sovereign Locking + Path Mutex**
- **Strategy**: Pessimistic locking on the file path.
- **Workflow**:
    1.  **Refactor Agent** calls `acquireLock('src/utils.ts')`. Success!
    2.  **Linter Agent** calls the same. Access Denied.
    3.  **Linter Agent** waits (or retries) for the lock to be released.
    4.  **Refactor Agent** commits changes and releases the lock.

**Result**: Zero merge conflicts or data loss in collaborative multi-agent environments.

---

## 🛡️ Scenario C: Self-Cleaning Knowledge Graph

**Problem:** A multi-agent swarm generates 10GB of temporary knowledge and telemetry every day. The database slows down as it grows.

**Solution: Autonomous Integrity Worker**
- **Strategy**: Background maintenance without a manual DBA.
- **Workflow**:
    1.  **Integrity Worker** wakes up at midnight.
    2.  **Pruning**: Deletes any `telemetry` or `claims` older than 7 days.
    3.  **Optimization**: Runs `VACUUM` and `REINDEX` to reclaim space.
    4.  **Verification**: Validates every shard for physical corruption.

**Result**: Database remains fast and compact regardless of age or volume.

---

## 🏟️ Scenario D: Massive Horizontal Scaling

**Problem:** You've hit the hardware limit of a single NVMe drive (e.g., 50,000 writes/sec sustained).

**Solution: Sharded Partition Model**
- **Strategy**: Horizontal scaling across multiple physical files.
- **Workflow**:
    1.  Create 10 shards (e.g., `db_0.db` to `db_9.db`).
    2.  Partition work by `agentId` or `projectId`.
    3.  Each shard operates on its own WAL file, allowing parallel disk IO.

**Result**: Scaling capacity increases **linearly** with the number of shards (e.g., 500,000+ ops/sec on 10 shards).
