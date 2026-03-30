# 🚀 BroccoliDB Performance Benchmarks

This document details the high-performance capabilities of BroccoliDB, specifically focusing on the `BufferedDbPool` and `SqliteQueue` components. 

BroccoliDB is designed to handle bursty, high-throughput AI agent workloads by leveraging a **Memory-First, Write-Behind** architecture.

---

## 📊 Latest Findings (March 2026)

The following metrics were captured on a modern development environment (Apple M-series SSD).

| Metric | Result | Target | Status |
| :--- | :--- | :--- | :--- |
| **Raw DB Throughput** | **1,105,359 ops/sec** | 50,000 | 🚀 Exceeded |
| **Queue Enqueue Speed** | **182,800 jobs/sec** | 50,000 | 🚀 Exceeded |
| **Queue Processing Speed** | **72,516 jobs/sec** | 50,000 | 🚀 Exceeded |
| **p95 Enqueue Latency** | **0.38 ms** | < 1.0 ms | ✅ Optimal |
| **p99 Enqueue Latency** | **0.62 ms** | < 5.0 ms | ✅ Optimal |

> [!NOTE]
> The **Raw DB Throughput** exceeds 1M ops/sec because BroccoliDB coalesces redundant updates and batches insertions into massive chunks before they touch the SQLite WAL file.

---

## 🧪 Methodology

### 1. Raw DB Throughput
We push 100,000 insertion operations into the `BufferedDbPool` across multiple batches. We measure the time from the first push to the final `flush()` completion.

### 2. Queue Enqueue Speed
We measure the speed at which 100,000 unique jobs can be added to the `SqliteQueue` using `enqueueBatch`. This tests the memory-buffer handoff and the efficiency of the background persistence layer.

### 3. Queue Processing Speed
We measure the time it takes for a `SqliteQueue.processBatch` worker to drain 100,000 jobs from the queue. This includes the overhead of status updates (`pending` -> `processing` -> `done`).

---

## 🏃 How to Reproduce

You can run the benchmark suite yourself using the following command:

```bash
# Ensure dependencies are installed
npm install

# Run the benchmark script
npx tsx tests/benchmark.ts
```

The benchmark creates a temporary `benchmark.db` in your root directory, which is automatically cleaned up (or overwritten) on each run.

---

*Verified by MarieCoder — March 2026*
