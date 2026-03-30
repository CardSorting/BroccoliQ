import { dbPool, BufferedDbPool } from '../infrastructure/db/BufferedDbPool.js';
import { SqliteQueue } from '../infrastructure/queue/SqliteQueue.js';
import { setDbPath } from '../infrastructure/db/Config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BENCH_DB = path.resolve(process.cwd(), 'benchmark.db');
const NUM_OPS = 100000;
const BATCH_SIZE = 10000;

async function runBenchmark() {
  console.log('🚀 Starting BroccoliDB High-Performance Benchmark');
  console.log(`📊 Parameters: ${NUM_OPS.toLocaleString()} ops, Batch Size: ${BATCH_SIZE.toLocaleString()}`);

  // 0. Cleanup and Init
  if (fs.existsSync(BENCH_DB)) fs.unlinkSync(BENCH_DB);
  if (fs.existsSync(`${BENCH_DB}-wal`)) fs.unlinkSync(`${BENCH_DB}-wal`);
  if (fs.existsSync(`${BENCH_DB}-shm`)) fs.unlinkSync(`${BENCH_DB}-shm`);
  
  setDbPath(BENCH_DB);
  console.log(`📂 Database: ${BENCH_DB}`);

  // --- TEST 1: BufferedDbPool Raw Throughput ---
  console.log('\n--- PHASE 1: BufferedDbPool Raw Throughput ---');
  const start1 = performance.now();
  
  for (let i = 0; i < NUM_OPS; i += BATCH_SIZE) {
    const ops = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      ops.push({
        type: 'insert' as const,
        table: 'knowledge' as const,
        values: {
          id: `bench-node-${i + j}`,
          userId: 'bench-user',
          type: 'benchmark_data',
          content: JSON.stringify({ data: 'x'.repeat(100) }), // 100 bytes of content
          createdAt: Date.now(),
        },
        layer: 'infrastructure' as const,
      });
    }
    await dbPool.pushBatch(ops);
  }

  console.log('⏳ Waiting for final flush...');
  await dbPool.flush();
  const end1 = performance.now();
  const duration1 = (end1 - start1) / 1000;
  const throughput1 = Math.round(NUM_OPS / duration1);

  console.log(`✅ Phase 1 Complete: ${NUM_OPS.toLocaleString()} ops in ${duration1.toFixed(2)}s`);
  console.log(`📈 BufferedDbPool Throughput: ${throughput1.toLocaleString()} ops/sec`);

  // --- TEST 2: SqliteQueue Enqueue Speed ---
  console.log('\n--- PHASE 2: SqliteQueue Enqueue Speed ---');
  const queue = new SqliteQueue<any>();
  const start2 = performance.now();

  for (let i = 0; i < NUM_OPS; i += BATCH_SIZE) {
    const items = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      items.push({
        payload: { task: i + j, timestamp: Date.now() },
        id: `job-${i + j}`,
      });
    }
    await queue.enqueueBatch(items);
  }

  await dbPool.flush();
  const end2 = performance.now();
  const duration2 = (end2 - start2) / 1000;
  const throughput2 = Math.round(NUM_OPS / duration2);

  console.log(`✅ Phase 2 Complete: ${NUM_OPS.toLocaleString()} jobs enqueued in ${duration2.toFixed(2)}s`);
  console.log(`📈 SqliteQueue Enqueue Throughput: ${throughput2.toLocaleString()} jobs/sec`);

  // --- TEST 3: SqliteQueue Processing Speed ---
  console.log('\n--- PHASE 3: SqliteQueue Processing Speed ---');
  let processedCount = 0;
  const start3 = performance.now();

  const processPromise = new Promise<void>((resolve) => {
    queue.processBatch(async (jobs) => {
      processedCount += jobs.length;
      if (processedCount >= NUM_OPS) {
        resolve();
      }
    }, { batchSize: 2000, maxInFlightBatches: 10 });
  });

  await processPromise;
  const end3 = performance.now();
  const duration3 = (end3 - start3) / 1000;
  const throughput3 = Math.round(NUM_OPS / duration3);
  
  queue.stop();

  console.log(`✅ Phase 3 Complete: ${NUM_OPS.toLocaleString()} jobs processed in ${duration3.toFixed(2)}s`);
  console.log(`📈 SqliteQueue Processing Throughput: ${throughput3.toLocaleString()} jobs/sec`);

  // --- REPORT ---
  const metrics = dbPool.getMetrics();
  console.log('\n--- FINAL PERFORMANCE REPORT ---');
  console.log(`Avg Raw DB Throughput:    ${throughput1.toLocaleString()} ops/sec`);
  console.log(`Avg Queue Enqueue:        ${throughput2.toLocaleString()} jobs/sec`);
  console.log(`Avg Queue Processing:     ${throughput3.toLocaleString()} jobs/sec`);
  console.log(`p95 Enqueue Latency:     ${metrics.latencies.enqueue.p95.toFixed(3)}ms`);
  console.log(`p99 Enqueue Latency:     ${metrics.latencies.enqueue.p99.toFixed(3)}ms`);
  console.log(`p95 Processing Latency:  ${metrics.latencies.processing.p95.toFixed(2)}ms`);
  console.log(`p99 Processing Latency:  ${metrics.latencies.processing.p99.toFixed(2)}ms`);

  // Final Cleanup
  await dbPool.stop();
  process.exit(0);
}

runBenchmark().catch((err) => {
  console.error('❌ Benchmark Failed:', err);
  process.exit(1);
});
