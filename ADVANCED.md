# Advanced Performance & Scaling Strategies

You know the basics now. This guide is for when you want to squeeze every drop of performance out of BroccoliQ.

---

## Chapter 1: Beyond the Defaults

### The "Default Settings Are Good" Myth

Let's bust the myth: default settings work for small systems, but pro-level performance requires tuning.

```typescript
// This is "good enough" (for 100 tasks/second)
const queue = new SqliteQueue();

// This is "production ready" (for 10,000+ tasks/second)
const queue = new SqliteQueue({
  concurrency: 5000,            // More workers (increase based on job duration)
  batchSize: 10000,            // Larger batches (reduce if DB is slow)
  visibilityTimeoutMs: 600000, // 10 minutes (adjust to your max job time)
  baseRetryDelayMs: 500,       // 0.5s buffer (lower = faster retry)
  pruneDoneAgeMs: 86400000     // Prune old jobs after 24 hours
});
```

---

## Chapter 2: Micro-Benchmarking Guide

### How to Measure Your Performance

**Philosophy:** Don't guess. Measure. Optimize.

#### Test 1: Enqueue Throughput

```typescript
const queue = new SqliteQueue({ concurrency: 1000 });

console.time('enqueue');
for (let i = 0; i < 100000; i++) {
  await queue.enqueue({ task: `process-${i}` });
}
console.timeEnd('enqueue');  // Should be < 100ms

console.time('enqueueBatch');
await queue.enqueueBatch(
  Array(100000).fill({ task: 'process' })
);
console.timeEnd('enqueueBatch');  // Should be < 10ms
```

**Good results:**
- `enqueue`: < 100ms for 100,000 jobs
- `enqueueBatch`: < 10ms for 100,000 jobs
- Both are **write operations** → no network latency

---

#### Test 2: Process Throughput

```typescript
const queue = new SqliteQueue({ concurrency: 1000 });

// Enqueue 100,000 jobs
await queue.enqueueBatch(Array(100000).fill({ task: 'process' }));

console.time('process');
let completed = 0;
await queue.process(async (job) => {
  completed++;
  await new Promise(r => setTimeout(r, 1)); // 1ms operation
}, { 
  concurrency: 1000, 
  completionFlushMs: 10 
});

console.timeEnd('process');  // Should be < 100s for 100k jobs

// Calculate: 100,000 jobs / 100s = 1000 jobs/sec
console.log(`Throughput: ${completed.toLocaleString()} jobs/second`);
```

**Good results:**
- 100ms job duration: ~10,000 jobs/second
- 10ms job duration: ~100,000 jobs/second
- 1ms job duration: ~1,000,000 jobs/second

---

#### Test 3: Memory Usage

```typescript
const queue = new SqliteQueue({ 
  maxMemoryBufferSize: 1000000  // 1M in-memory max
});

// Add 500,000 jobs
for (let i = 0; i < 500000; i++) {
  await queue.enqueue({ task: `test-${i}` });
}

// Monitor memory
const v8 = require('v8');
const used = process.memoryUsage().heapUsed / 1024 / 1024;
console.log(`Memory usage: ${Math.round(used * 100) / 100} MB`);

// Expected: 50-200MB for 500k jobs (varies by payload size)
```

---

## Chapter 3: Scaling Horizontally

### Multiple Processes, One Queue

BroccoliQ isn't just one process. It's **multiple processes sharing one database file**.

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│ Process A   │◄────►│ Queue DB    │◄────►│ Process B   │
│   Worker 1  │      │ .db file    │      │   Worker 5  │
│   Worker 2  │      └─────────────┘      │   Worker 9  │
└─────────────┘                              └─────────────┘
```

#### Technique 1: Worker Pool Scaling

Start multiple processes, point them to the same database:

```typescript
// worker1.js
import { SqliteQueue } from 'broccolidb';

const queue = new SqliteQueue();  // Uses default dbPath

queue.process(async (job) => {
  console.log('Worker processing:', job.task);
  await doWork(job);
}, { concurrency: 100 });

console.log('Worker 1 started. PID:', process.pid);
```

**Start 10 workers:**
```bash
# Terminal 1
node worker1.js &

# Terminal 2
node worker1.js &

# ... repeat for 10 terminals
```

**Result:** 10 processes × 100 workers = 1,000 workers, 1 queue.

---

#### Technique 2: Auto-Scaling Workers

Don't manually start workers. Write a scaling script:

```typescript
// scaler.js
import { spawn } from 'child_process';
import fs from 'fs';

const MAX_WORKERS = 20;
const WORKER_PATH = './worker.js';

console.log('Starting worker pool...');

for (let i = 0; i < MAX_WORKERS; i++) {
  const worker = spawn('node', [WORKER_PATH], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  worker.unref();
  console.log(`Started worker ${i}, PID: ${worker.pid}`);
}

console.log(`Waiting... Press Ctrl+C to stop all workers.`);
```

**Start in background:**
```bash
node scaler.js &
# To stop: pkill -f "node worker1.js" (kill all workers)
```

---

#### Technique 3: Database Sharding (Advanced)

For 100K+ tasks per second, split writes across multiple databases:

```typescript
class ShardedQueue {
  private shards: SqliteQueue[] = [];
  private shardCount = 10;

  constructor() {
    for (let i = 0; i < this.shardCount; i++) {
      this.shards.push(new SqliteQueue({
        dbPath: `./broccolidb-shard-${i}-${Date.now()}.db`
      }));
    }
  }

  private getShard(payload: any) {
    // Hash-based distribution
    const hash = (str: string) => 
      str.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0);
    return this.shards[hash(JSON.stringify(payload)) % this.shardCount];
  }

  async enqueue(payload: any) {
    return this.getShard(payload).enqueue(payload);
  }

  async process(handler: any, options: any) {
    // Start all shards
    await Promise.all(this.shards.map(q => q.process(handler, options)));
  }
}
```

**Impact:**
- 10 databases = 10× write throughput
- Requires load balancer for distribution

---

## Chapter 4: Throughput Optimization

### Reach 10,000+ Ops/Sec (Maybe 100,000)

#### Technique 1: The 3R Rule

**Review** your operations for these three R's:

| R | Question | Impact |
|---|----------|--------|
| **Read** | Can data be pre-loaded? | 10ms → 1ms |
| **Reduce** | Can we batch operations? | 1,000 DB writes → 1 |
| **Reorder** | Can we parallelize independent tasks? | Serial → Parallel |

**Example:**
```typescript
❌ BAD:
queue.process(async (job) => {
  // Database query EVERY job (100ms)
  const user = await db.query('SELECT * FROM users WHERE id = ?', job.userId);
  const orders = await db.query('SELECT * FROM orders WHERE userId = ?', job.userId);
  await process(user, orders);
});

✓ GOOD:
// Pre-load once using Agent Shadows
await dbPool.runTransaction('preload', async () => {
  const users = await db.selectWhere('users', { id: jobIds });
  const orders = await db.selectWhere('orders', { userId: userIds });
  orders[user.id] = orders;
});

// Process from memory
queue.process(async (job) => {
  const user = users[job.userId];
  const orders = orders[job.userId];  // O(1) access
  await process(user, orders);
});
```

**Impact:**
- 100ms query成本 → 0ms memory access
- 100× throughput improvement

---

#### Technique 2: The 1-10-100 Rule

For every operation, optimize in this order:

**Cost 1:** CPU (fast)
**Cost 10:** Network (slow)
**Cost 100:** Disk I/O (slower)
**Cost 1000:** Database Lock (blocking)

```typescript
// Optimization cascade:
// 1. Reduce object size (CPU)
const { id, task } = job.payload;  // Instead of entire payload

// 2. Batch writes (Disk I/O)
await queue.enqueueBatch(operations);

// 3. Use indexes (Disk I/O)
db.query('SELECT * FROM jobs WHERE id = ?', [id]);

// 4. Use shadows (Disk I/O)
await dbPool.runTransaction('shadow', ...);
```

---

#### Technique 3: The Tail wastage Elimination

Jobs that take 100x longer than the average get dropped:

```typescript
const queue = new SqliteQueue({ 
  concurrency: 1000,
  maxSize: 10000000
});

let slowJobCount = 0;
let start = Date.now();

queue.process(async (job) => {
  const start = Date.now();
  await longOperation();
  const duration = Date.now() - start;
  
  if (duration > 1000) {  // > 1 second
    slowJobCount++;
    console.warn(`Slow job (${duration}ms) - dropping`);
  }
}, { 
  completionFlushMs: 100  // Only flush every 100ms
});

// After 1 minute:
const avg = (Date.now() - start) / slowJobCount;
console.log(`Avg job time: ${avg}ms`);
console.log(`Throughput: ${1000 / avg} jobs/sec`);
```

**Result:** If average job is 50ms, you get 20,000 jobs/sec. Never waste time on slow jobs.

---

## Chapter 5: Advanced Queue Patterns

### Patterns for Complex Systems

#### Pattern 1: DAG (Directed Acyclic Graph)

Some jobs depend on other jobs:

```typescript
class DAGQueue {
  private queue = new SqliteQueue();
  
  async addWorkflow(steps: Step[]) {
    // DAG structure: step1 → step2 → step3
    const currentId = await this.queue.enqueue({
      type: 'workflow',
      steps,
      startedAt: Date.now()
    });
    
    return currentId;
  }

  async processDecisionPoint(job) {
    if (job.type === 'workflow') {
      // Start first non-successful step
      const nextStep = job.steps.find(s => s.status !== 'done');
      
      if (nextStep) {
        nextStep.status = 'processing';
        await this.queue.enqueue(nextStep);
      }
    }
  }
}
```

---

#### Pattern 2: Fan-Out/Fan-In

Multiple workers process a batch, then merge results:

```typescript
const queue = new SqliteQueue({ concurrency: 100 });
const mergeQueue = new SqliteQueue({ concurrency: 1 });

async function fanOut(job) {
  // Decide which workers to use
  const workers = job.tasks.map(task => task.workerId);
  
  // Enqueue unique tasks per worker
  const tasks = workerTaskGrouping(workers);
  
  await queue.enqueueBatch(tasks);
}

async function fanIn() {
  await queue.processBatch(async (jobs) => {
    // Wait for all tasks to complete
    const results = jobs.map(j => j.result);
    
    // Merge results
    await mergeQueue.enqueue({ type: 'merge', results });
  }, { batchSize: 10 });
}
```

---

#### Pattern 3: Retry Backoff Strategies

Custom retry strategies: exponential, linear, jittered:

```typescript
const STUBORN_RETRIES = 10;

// Fail job stubbornly after 10 attempts
queue.process(async (job) => {
  let attempts = 0;
  
  while (attempts < STUBORN_RETRIES) {
    try {
      const result = await retryableOperation(job);
      await queue.complete(job.id, result);
      break;
    } catch (err) {
      attempts++;
      const delay = 2 ** attempts * 1000; // Exponential
      
      console.log(`Retry ${attempts}/${STUBORN_RETRIES} in ${delay}ms`);
      
      if (attempts < STUBORN_RETRIES) {
        await queue.fail(job.id, err);
        await queue.enqueue(job, { delayMs: delay });
      } else {
        throw err;  // Failed after max retries
      }
    }
  }
}, { concurrency: 100 });
```

---

## Chapter 6: Persistence & Replication

### Multiple Processes, One DB

#### Querying from Multiple Workers

```typescript
// What happens when 10 workers query at once?

// Worker 1: SELECT * FROM jobs WHERE status = 'pending' (100 jobs)
// Worker 2: SELECT * FROM jobs WHERE status = 'pending' (100 jobs)
// ...

// Problem: Database poll, more workers = slower queries
```

**Solution: Pre-load + Local Cache**

```typescript
// Load once (initialize phase)
const allJobs = await dbPool.selectWhere('jobs', {
  status: 'pending'
});

// Cache in local memory
const cache = new Map();
allJobs.forEach(job => cache.set(job.id, job));

// All workers read from local cache
queue.process(async (job) => {
  const cached = cache.get(job.id);  // O(1) access
  await process(cached);
});
```

---

#### Push vs Pull

**Pull (current mode):** Workers ask for jobs when needed
```
Worker: "Do you have work?"
Queue: "Here's 100 jobs"
Worker: "Thanks. Let others know I'm busy"
```

**Good for:** Load balancing, passive scaling
**Bad for:** Minimal RTT, reduced cache efficiency

**Pull Performance:**
- 100 workers at once = 100 network requests
- Each query: 10-50ms

---

#### Push Mode (Custom Implementation)

**Push Mode:** Queue pushes jobs when available
```
Worker: "Ready"
Queue: "Here's 100 jobs, now wait"
Queue: "Here's 100 more, now wait"
```

**Good for:** Low latency, predictable throughput
**Bad for:** Need to manage concurrency manually

---

## Chapter 7: Advanced Failure Handling

### Beyond Visibility Timeout

#### Custom Crashed Job Handlers

```typescript
queue.process(async (job) => {
  try {
    await processJob(job);
    await queue.complete(job.id);
  } catch (err) {
    // Could retry immediately, or drop, or escalate
    if (job.attempts > 5) {
      // Critical failure: Send to human
      await slack.notify('Critical fail:', job);
      throw err;  // Already failed due to retry limit
    }
  }
}, { concurrency: 100 });
```

---

#### Dead Letter Queue (DLQ)

Separate failed jobs:

```typescript
queue.process(async (job) => {
  try {
    await processJob(job);
    await queue.complete(job.id);
  } catch (err) {
    // Move to DLQ instead of infinite retry
    await dbPool.push({
      type: 'insert',
      table: 'dead_letter_queue',
      values: {
        jobPayload: JSON.stringify(job.payload),
        error: err.message,
        failedAt: Date.now()
      }
    });
    
    // Optionally retry later
    // await queue.enqueue(job, { maxAttempts: 1 });
  }
}, { concurrency: 100 });
```

---

## Chapter 8: Monitoring & Observability

### Track Everything

#### Custom Metrics Collector

```typescript
class MetricsCollector {
  private startedAt = Date.now();
  private processedCount = 0;
  private failedCount = 0;
  private durationCache = new Map<string, number>();

  async startJob(job: QueueJob) {
    this.durationCache.set(job.id, Date.now());
  }

  async completeJob(jobId: string) {
    const duration = Date.now() - (this.durationCache.get(jobId) || 0);
    this.durationCache.delete(jobId);
    this.processedCount++;
    
    return {
      processed: this.processedCount,
      failed: this.failedCount,
      successRate: (this.processedCount / (this.processedCount + this.failedCount)) * 100,
      avgDuration: this.getAverageDuration()
    };
  }

  getAverageDuration() {
    return totalDuration / this.processedCount;
  }
}
```

---

#### Real-Time Dashboard

```typescript
// metrics.js
setInterval(async () => {
  const metrics = await queue.getMetrics();
  const size = await queue.size();
  const ts = Date.now();
  
  console.log(`${ts} | Pending: ${metrics.pending} | Processing: ${metrics.processing} | Queue: ${size}`);
}, 10000);  // Every 10 seconds
```

**Output:**
```
1653643210000 | Pending: 1000 | Processing: 500 | Queue: 1500
1653643220000 | Pending: 800 | Processing: 500 | Queue: 1300
1653643230000 | Pending: 600 | Processing: 500 | Queue: 1100
```

---

## Chapter 9: Advanced Patterns

### Proven Patterns

#### Pattern 1: The "Keep Alive" Loop

Never stop processing. Keep workers alive forever:

```typescript
while (true) {
  await queue.process(handler, {
    concurrency: 100,
    pollIntervalMs: 1,  // Check for work instantly
    completionFlushMs: 10  // Flush completions frequently
  });
  
  // If queue is empty, sleep briefly
  await new Promise(r => setTimeout(r, 100));
}
```

---

#### Pattern 2: The "Batch & Release" Loop

Collect work, release in batches:

```typescript
const accumulator = [];

queue.process(async (job) => {
  accumulator.push(job);
  
  if (accumulator.length >= 1000) {
    await processBatch(accumulator);
    accumulator.length = 0;
  }
}, { concurrency: 1000 });
```

---

#### Pattern 3: The "Hot Spotters"

Identify and handle hot paths:

```typescript
const hotSpots = new Map();  // taskType → count

queue.process(async (job) => {
  const duration = await processJob(job, hotSpots);
  
  if (duration > 100) {
    hotSpots.set(job.type, (hotSpots.get(job.type) || 0) + 1);
    
    // Create a specialized worker for this hot task
    if (hotSpots.get(job.type) > 10) {
      console.log(`Task ${job.type} is hot! Adding dedicated worker.`);
      spawn('node', ['dedicated-worker.js', job.type]);
    }
  }
}, { concurrency: 100 });
```

---

## Chapter 10: The Performance Golden Rule

### If It's Slow, Measure, Don't Guess

```typescript
// ❌ DON'T GUESS

const queue = new SqliteQueue({ concurrency: 1000 }); // Why 1000?

await queue.process(async (job) => {
  await process(job);
});

// ✅ DO MEASURE

const testQueue = new SqliteQueue({ concurrency: 100 });

console.time('process');
for (let i = 0; i < 1000; i++) {
  await testQueue.enqueue({ task: i });
}

const duration = console.timeEnd('process');
const throughput = 1000 / (duration / 1000);

console.log(`Throughput: ${throughput} ops/sec`);

// Now scale up based on data
const scaleFactor = throughput / 100; // Original throughput from baseline
const queue = new SqliteQueue({ concurrency: 100 * scaleFactor });
```

---

## Chapter 11: When to Give Up

### Significantly Lower Performance

If you see any of these, performance is the problem:

**Symptoms:**
- Queue size > 1,000,000 jobs
- Memory usage > 2GB
- Job processing > 100ms (average)
- Drop in 100ms-1s range

**Solutions:**

1. **Reduce job duration:**
   ```typescript
   ❌ BAD:
   await callExternalApi(job.url);  // 1 second
   
   ✓ GOOD:
   await callExternalApiCompact(job.url);  // 100ms
   ```

2. **Batch operations:**
   ```typescript
   ❌ BAD:
   for (const user of users) {
     await db.insert({ user });
   }
   
   ✓ GOOD:
   await db.insertBatch(users);
   ```

3. **Scale out:**
   - Add more workers
   - Add more processes
   - Use multiple databases (sharding)

---

## Summary: The Advanced Checklist

- [ ] Micro-benchmark current performance
- [ ] Optimize the 3R rule (Read, Reduce, Reorder)
- [ ] Implement batch processing where possible
- [ ] Use pre-loading for expensive queries
- [ ] Scale horizontally (multiple processes)
- [ ] Monitor queue size and throughput
- [ ] Add custom failure handling
- [ ] Implement dead letter queue

**Pro tip:** The top 1% perform 100× faster than the bottom 50%—not because they use better code, but because they optimize to measure.

---

**Ready to go pro? The pro-level guide ends here. Go build something extraordinary.**