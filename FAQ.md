# Deep Dive: FAQ

You've read the basics. Now the nuanced questions. These answers include real code and deep technical insights.

---

## Questions About Basics

### Q: Why does the queue queue jobs instead of just going to the database?

**A:** Two reasons: **latency** and **cost**.

```typescript
// Without queue:
await db.insert({ job: 'process' });  // 10ms DB write
await processJob();                    // 100ms processing
await db.insert({ result: 'done' });    // 10ms DB write

// With queue (parallel):
await queue.enqueue({ job: 'process' });  // 1ms memory write
// ... workers process (while other operations happen)
await queue.complete(job.id);           // 1ms flush

# Total time: 100ms (parallel)
# Previous total: 120ms (sequential)
```

**The hidden cost:**
- Without queue, every job requires **3 database operations** (enqueue, process, complete)
- With queue, one job is enqueued (memory), processed (parallel), completed (flush)
- For 100,000 jobs: 300,000 DB ops → 100,000 DB ops
- **3× throughput improvement, simply by ordering operations differently.**

---

### Q: Does BroccoliQ replace a database?

**A:** No. BroccoliQ **uses** a database. It doesn't replace it.

**Analogy:**
- **Database:** The warehouse where you store finished goods
- **Queue:** The conveyor belt that moves items from warehouse to factory floor

You still need the warehouse (database). The queue is the shipping mechanism.

---

### Q: How do I query the queue programmatically?

**A:** The queue has a built-in query system:

```typescript
// Get pending jobs by ID
const job = await db.selectOne('queue_jobs', { column: 'id', value: jobId });

// Get all pending jobs
const pending = await db.selectWhere('queue_jobs', [
  { column: 'status', value: 'pending' }
]);

// Get jobs with conditions
const urgent = await db.selectWhere('queue_jobs', [
  { column: 'status', value: 'pending' },
  { column: 'priority', value: 50, operator: '>' }
], null, { limit: 100 });

// Update in-bulk
await db.update('queue_jobs', {
  status: 'failed',
  error: 'timeout'
}, { column: 'id', value: jobIds, operator: 'IN' });
```

**Query best practices:**
- Use `WHERE status = 'pending'` for polling (e.g., monitoring dashboard)
- Don't query inside job handler (slow, high contention)
- Always use `limit` in queries to prevent query storms

---

## Questions About Performance

### Q: What's the optimal concurrency?

**A:** Measure. Then double. Then measure again.

**Formula:**
```
concurrency = 1000ms / averageJobDurationMs
```

Examples:
- 100ms job → concurrency = 10
- 10ms job → concurrency = 100
- 1ms job → concurrency = 1000

**Calculation example:**
```typescript
// Step 1: Measure your job duration
const queue = new SqliteQueue({ concurrency: 100 });

console.time('measure');
const runtime = await measureJobDuration();
console.timeEnd('measure');  // e.g., 85ms

// Step 2: Calculate ideal concurrency
const idealConcurrency = Math.floor(1000 / runtime);
console.log(`Ideal concurrency: ${idealConcurrency}`);  // e.g., 11

// Step 3: Test
await queue.process(async (job) => {
  await job.doWork();
}, { concurrency: idealConcurrency });
```

**Rule of thumb:**
- If concurrency doesn't increase throughput after 2x ideal, you hit a bottleneck (database, network, or CPU)
- If throughput doesn't increase after 10x ideal, you hit a different bottleneck (memory, I/O)

---

### Q: Why do I hit disk I/O bottlenecks?

**A:** Disks are orders of magnitude slower than RAM. Here's the math:

```
RAM access:        100ns
SSD write:         100μs = 1000x slower
HDD write:         10ms    = 100,000x slower
```

**The problem:**
```typescript
// Bad: Query inside job handler
queue.process(async (job) => {
  const data = await db.query('SELECT * FROM table WHERE id = ?', [job.id]);  // 50ms
  await process(data);  // 100ms
}, { concurrency: 100 });

// How many queries per second?
// 100 workers × 50ms latency = 2 queries/training? WRONG

// Actually: 1 worker processes 100ms job → 10 jobs/sec
// 100ms latency adds 5 seconds to total job time
```

**The fix:**
```typescript
// Good: Preload data, use memory
const allData = await db.selectAll('table');  // 500ms (start-up)

// Cache in memory
const cache = new Map(allData.map(item => [item.id, item]));

queue.process(async (job) => {
  const data = cache.get(job.id);  // 1ms (RAM)
  await process(data);  // 100ms
}, { concurrency: 100 });

// Job latency: 100ms total → 10K+ jobs/sec
```

---

### Q: How do I optimize read latency?

**A:** **Preload or use indexes**. That's it.

**Option 1: Preload on startup**
```typescript
// Load once (100 items = 100ms)
const items = await db.selectWhere('items', { status: 'active' });

// Cache in local memory
const cache = new Map(items.map(i => [i.id, i]));

// Workers read from cache
queue.process(async (job) => {
  const item = cache.get(job.itemId);  // O(1)
  await process(item);
});
```

**Option 2: Use indexes**
```typescript
// ❌ BAD: Full table scan
SELECT * FROM orders WHERE userId = '12345';

// ✓ GOOD: Index on userId
CREATE INDEX idx_users ON orders(userId);

SELECT * FROM orders WHERE userId = '12345';  // 10x faster
```

**Option 3: Pagination**
```typescript
// Not 100,000 items
const items = await db.selectWhere('items', [], null, { limit: 100 });
```

---

### Q: Why does my memory usage grow over time?

**A:** Two possibilities:

**1. Jobs not completing**
```typescript
❌ BAD:
queue.process(async (job) => {
  await longProcess(job);  // Hangs
}, { concurrency: 1 });

// Memory: 100MB at startup → 500MB after 5 minutes
// Reason: Jobs stuck in 'processing'
```

**2. Circular buffer garbage**
```typescript
queue.dequeueBatch(1000);  // Takes 1000 from buffer
// Does not delete from memory
```

**Fix:**
```typescript
✓ GOOD:
queue.process(async (job) => {
  await longProcess(job);
}, { concurrency: 1000 });  // Process in batches
```

Or manually manage buffer:

```typescript
const queue = new SqliteQueue({ maxSize: 1000000 });

// Periodically flush buffer
setInterval(() => {
  queue.doneBuffer.length = 0;  // Clear done jobs from memory
}, 5000);
```

**Memory management rule:**
- Backend should be at least 2× expected max memory
- With max 1M jobs @ 100KB each → 100GB RAM
- Production: Use dynamic scaling (add workers, monitor memory)

---

## Questions About Architecture

### Q: Should I use Redis or BroccoliQ?

**A:** Use BroccoliQ if:
- You already use SQLite
- You need crash resilience
- You want 100% local deployment (no Redis server)

**Use Redis if:**
- You use Redis for caching
- You need Redis pub/sub features
- You need real-time notifications

**Hybrid approach:**
```typescript
// Main queue: BroccoliQ (persistence)
const broccoli = new SqliteQueue();

// Real-time notifications: Redis pub/sub
redis.subscribe('broccoliq:jobs', (message) => {
  console.log('Job created:', message);
});
```

---

### Q: Can multiple processes share one queue?

**A:** **Yes.** That's how horizontal scaling works.

**Architecture:**
```
┌───┐
│ W1│◄───┐     ┌───────────────┐
│   │    │     │  queue.db     │
│ W2│◄───┼────►│ (.db file)    │
│   │    │     └───────────────┘
│ W3│◄───┘
└───┘
   3 workers, 1 queue
```

**Implementation:**
```typescript
// worker1.js
const queue = new SqliteQueue();  // Same dbPath

queue.process(async (job) => {
  await processJob(job);
});

// worker2.js
const queue = new SqliteQueue();  // Same dbPath

queue.process(async (job) => {
  await processJob(job);
});
```

**Result:**
- 3 processes, 300 workers (configurable)
- Total throughput = sum of all processes
- Queue handles contention automatically

---

### Q: What's the difference between `process` and `processBatch`?

**A:** Type of concurrency, not speed.

**`process` (parallel workers):**
```typescript
queue.process(async (job) => {
  await processJob(job);
}, { concurrency: 1000 });
```

**What happens:**
```
Job 1 → Worker 1 (100ms)
Job 2 → Worker 2 (100ms)
Job 3 → Worker 3 (100ms)
...
Job 1000 → Worker 1000 (100ms)
```

**Throughput:**
- 1000 jobs in parallel
- If each takes 100ms → 10,000 jobs/sec

---

**`processBatch` (parallel batches):**
```typescript
queue.processBatch(async (jobs) => {
  await processJobs(jobs);  // All at once
}, { batchSize: 1000 });
```

**What happens:**
```
Jobs 1-1000 → Layer 1
Jobs 1001-2000 → Layer 2
Jobs 2001-3000 → Layer 3
```

**Throughput:**
- 1000 jobs as one batch
- If each takes 100ms, batch takes 100ms total
- 10,000 jobs/sec (same as `process`)

**Difference:**
- `process`: 1000 individual workers
- `processBatch`: 1000 jobs as one work unit

**Use `processBatch` when:**
- Jobs are related (e.g., all for same user)
- You want to batch insert all results

---

## Questions About Failure Handling

### Q: When should I fail a job?

**A:** Two scenarios:

**1. Permanently failed (lore beyond retries)**
```typescript
queue.process(async (job) => {
  if (job.type === 'update_password') {
    // Cannot retry - wrong password
    await queue.fail(job.id, 'Invalid password');
    await slack.notify('Password update failed');
  }
}, { concurrency: 100 });
```

**2. Temporarily failed (retry is okay)**
```typescript
queue.process(async (job) => {
  try {
    await externalAPI.fetch(job.url);
  } catch (err) {
    // Network glitch? Retry
    if (err.type === 'network') {
      await queue.fail(job.id, err.message);
      await queue.enqueue(job, { delayMs: 1000 });  // Retry in 1s
    } else {
      // Permanent error
      await queue.fail(job.id, err.message);
    }
  }
}, { 
  defaultMaxAttempts: 5,
  baseRetryDelayMs: 1000
});
```

---

### Q: Does the queue auto-retry failed jobs?

**A:** **Yes.** Up to `defaultMaxAttempts`.

```typescript
const queue = new SqliteQueue({ defaultMaxAttempts: 5 });

queue.process(async (job) => {
  await processJob(job);  // Might fail
}, { concurrency: 100 });
```

**How retry works:**
```
Attempt 1:  0s   → fails (network)
            → retry in 1s (baseRetryDelayMs)
            
Attempt 2:  1s   → fails (timeout)  
            → retry in 2s (2^1 = 2x)

Attempt 3:  3s   → succeeds!
```

**Auto-retry logic is built-in.** No manual implementation needed.

---

### Q: How do I implement exponential backoff?

**A:** It's already built-in (see above). But you can customize:

```typescript
const queue = new SqliteQueue({ 
  baseRetryDelayMs: 500  // 500ms instead of 1000ms
});

queue.process(async (job) => {
  await processJob(job);
}, { 
  defaultMaxAttempts: 10,
  baseRetryDelayMs: 500
});
```

**Cycle time for custom backoff:**
- Attempt 1: 0ms
- Attempt 2: 500ms
- Attempt 3: 1s
- Attempt 4: 2s
- Attempt 5: 4s
- Attempt 6: 8s
- Attempt 7: 16s
- Attempt 8: 32s
- Attempt 9: 64s
- Attempt 10: 128s

**Rule of thumb:**
- `defaultMaxAttempts = 5`: Fast retries for transient failures
- `defaultMaxAttempts = 10`: Aggressive retries for tough tasks
- `defaultMaxAttempts = 20`: Slow retries for expensive operations

---

## Questions About Storage

### Q: Can I store large objects in the queue?

**A:** Yes, up to 1MB per job.

```typescript
const largeJob = {
  id: '1234',
  data: generateLargeData(900 * 1024),  // 900KB JSON
  metadata: { ... }
};

await queue.enqueue(largeJob);  // ✓ Works
```

**Tradeoffs:**
- Larger jobs = more memory usage
- Serialization/deserialization cost = O(payloadSize)
- DB file size grows with queue size

**Best practice:**
- Store only essential data
- Reference external storage (e.g., S3) for large assets
- Keep job payload to < 100KB for optimal performance

---

### Q: Does the queue affect database file size?

**A:** **Yes.** Every job is stored.

```typescript
// After processing 1,000,000 jobs:
// queue_jobs table: ~1GB (1000 rows × 1MB each)
// Done jobs: Optionally cleaned up
```

**Managing size:**
```typescript
// Clean up done jobs after 24 hours
const queue = new SqliteQueue({ 
  pruneDoneAgeMs: 86400000  // 24 hours
});

setInterval(() => {
  queue.performMaintenance();
}, 3600000);  // Run every hour
```

**Rule of thumb:**
- With 1MB jobs × 1M jobs = 1TB total queue storage
- Use `pruneDoneAgeMs` to manage
- Consider sharding if approaching disk limits

---

## Questions About Integration

### Q: How do I integrate with an Express.js API?

**A:**
```typescript
// server.js
import express from 'express';
import { SqliteQueue } from 'broccoliq';

const app = express();
const orderQueue = new SqliteQueue({ concurrency: 100 });

// Enqueue route
app.post('/orders', async (req, res) => {
  const order = req.body;
  const jobId = await orderQueue.enqueue(order);
  res.json({ jobId });
});

// Start processing engine
orderQueue.process(async (job) => {
  await processOrder(job);
}, { concurrency: 100 });

app.listen(3000);
```

**No special integration needed.** Just enqueue from your API handlers.

---

### Q: How do I integrate with Cron jobs?

**A:** API-driven CRON:

```typescript
// cron-job.process-monthly.ts
const queue = new SqliteQueue();

// Monthly billing
queue.enqueue({
  type: 'billing',
  month: '2024-02'
});

// Daily analytics
setInterval(() => {
  queue.enqueue({
    type: 'analytics',
    date: new Date().toISOString().split('T')[0]
  });
}, 86400000);  // Once per day
```

**Meaning:** Queue becomes your CRON database.

---

### Q: How do I migrate from a different queue (RabbitMQ, Beanstalk)?

**A:** Migrate data, not system.

```typescript
// Step 1: Read existing queue
const existingJobs = await readOldQueue();

// Step 2: Enqueue into BroccoliQ
const queue = new SqliteQueue();
await queue.enqueueBatch(existingJobs);

// Step 3: Test processing
await queue.process(async (job) => {
  await processJob(job);
}, { concurrency: 100 });

// Step 4: Slowly degrade old queue
// ... (2 days of overlap)
```

**Config migration:**
```typescript
// RabbitMQ: 50 concurrent
// BeanstalkD: 200 concurrency

// migrate to BroccoliQ:
const queue = new SqliteQueue({
  concurrency: 200,  // Match maximum
  batchSize: 1000
});
```

---

## Questions About Data Integrity

### Q: What happens if my worker crashes mid-processing?

**A:** **Jobs are reclaimed** automatically.

```typescript
queue.process(async (job) => {
  await heavyOperation(job);  // Process crashes at 10%
}, { 
  visibilityTimeoutMs: 300000  // 5 minutes
});

// At 5:10 PM, after worker crash:
await queue.reclaimStaleJobs();
// Output: [SqliteQueue] Reclaiming 500 stale jobs.
```

**How it works:**
1. Jobs marked 'processing' timestamped
2. When we reclaim, jobs older than timestamp shift to 'pending'
3. New workers pick them up

**Result:**
- Zero lost jobs
- Max 5-minute delay before recovery
- No manual intervention needed

---

### Q: Can the queue guarantee ACID transactions?

**A:** **Yes, for write operations.**

```typescript
await dbPool.runTransaction('agent-1', async () => {
  await dbPool.push({ type: 'insert', ... });  // Operation 1
  await dbPool.push({ type: 'update', ... });  // Operation 2
  
  // All commit together, or none
});
```

**Transaction rules:**
- Use `runTransaction()` for multi-step operations
- Each worker gets its own transaction buffer
- Transactions are invisible to other workers during execution

**What is NOT ACID:**
- Job processing (intermediate state)
- Final job completion (result storage)
- Concurrent enqueue (possible race condition)

**Best practice:**
```typescript
// Use queue for persistence
await queue.enqueue({ task: 'process' });

// Use transaction for multi-step processing
await dbPool.runTransaction('agent-1', async () => {
  await dbPool.push({ type: 'mark_processing', ... });
  await dbPool.push({ type: 'start_worker', ... });
  // ... intermediate steps
});
```

---

### Q: How do I handle race conditions?

**A:** **Don't put them in the queue.** Transactions handle everything else.

```typescript
❌ BAD:
queue.process(async (job) => {
  const job = await db.selectOne('jobs', { id: job.id });
  job.status = 'processing';
  await db.update('jobs', job);  // Race condition here!
  await process(job);
});

✓ GOOD:
queue.process(async (job) => {
  await dbPool.runTransaction('processing', async () => {
    // Read-then-execute is atomic
    const toProcess = await db.selectOne('jobs', { id: job.id });
    toProcess.status = 'processing';
    await db.update('jobs', toProcess);
    
    await process(toProcess);
  });
});
```

**Rule:** Any database operation should be in a transaction buffer.

---

## Questions About Scaling

### Q: How do I scale to 100K+ ops/sec?

**A:** 4 levels of scaling:

**Level 1: More concurrency**
- Single process → 2K ops/sec
- 50 processes × 1000 concurrency = 50K ops/sec

**Level 2: Built-in Sharding**
```typescript
// Split load across physical files effortlessly
const shardA = new SqliteQueue({ shardId: 'shard-a' });
const shardB = new SqliteQueue({ shardId: 'shard-b' });

await shardA.enqueueBatch(batch1);
await shardB.enqueueBatch(batch2);
```

**Level 3: Distributed Partitioning**
Initialize shards on different physical NVMe drives to bypass hardware IO limits.

**Level 4: Massive horizontal scaling**
Deploy 10+ shards across 10+ worker processes for linear performance gains.

**Strategy 4: Smaller jobs**
```typescript
❌ BAD:
await queue.enqueue({
  data: generateReport(1000000)  // 1MB job
});

✓ GOOD:
await queue.enqueue({
  reportId: crypto.randomUUID(),
  data: { /* shallow copy */ }
});

// Process splits report into 10 parts
```

**Rule of thumb:**
- 10K ops/sec = Use `process`, 1000 concurrency
- 100K ops/sec = Use 50 processes × 1000 concurrency
- 1M ops/sec = Use sharding + 10 processes × 10,000 concurrency

---

### Q: How do I handle bursts of traffic?

**A:** The queue naturally absorbs bursts.

```typescript
// Pre-load burst
async function handleTrafficBurst(requestsPerSecond: number) {
  const queue = new SqliteQueue();
  
  // Enqueue 1000 jobs every 100ms
  const burst = Array(1000).fill(null).map((_, i) => ({
    type: 'request',
    id: crypto.randomUUID()
  }));
  
  setInterval(() => {
    queue.enqueueBatch(burst);
  }, 100);
}

// Workers consume at steady rate (1000 jobs/sec)
// Queue absorbs excess (100K → 100 jobs per burst)
```

**Result:**
- Queue holds up to 1M jobs
- Burst pattern doesn't affect steady-rate processing
- Jobs process in order of arrival

**Rules:**
- Set realistic `concurrency` based on job duration
- Don't limit burst intake (queue handles it)
- Monitor queue depth, not burst rate

---

## Questions About specific features

### Q: How does priority work?

**A:** `priority` is simply a sorting factor.

```typescript
await queue.enqueue({
  task: 'send_email',
  priority: 10  // High priority
}, { priority: 10 });

await queue.enqueue({
  task: 'cleanup',
  priority: 1   // Low priority
}, { priority: 1 });
```

**In dequeue:**
```typescript
// Priority queries sort DESC
SELECT * FROM queue_jobs 
WHERE status = 'pending' AND runAt <= NOW()
ORDER BY priority DESC  -- 10 first, 1 last
```

**Rule of thumb:**
- Priority difference matters: use 1, 10, 100, etc.
- Don't use 1-10 for fine-grained control (just sort)
- Lower number = higher priority

---

### Q: How do I handle time delays?

**A:** Use `delayMs`.

```typescript
await queue.enqueue({
  task: 'send_report',
  recipient: 'ceo@example.com'
}, { 
  delayMs: 3600000  // Send in 1 hour
});
```

**How it works:**
```typescript
// Job stored with runAt timestamp now + 1 hour
// Dequeue only processes jobs where runAt <= NOW
```

**Use cases:**
- Prefetching (process 10 minutes before user visits)
- Batch billing (charge at 3am UTC)
- Rate limiting (wait 5 minutes before retrying)

---

### Q: Can I pause and resume processing?

**A:** Use `stop()` and manual control:

```typescript
const queue = new SqliteQueue();

// Currently processing X jobs

// Pause new jobs
queue.stop();  // Newest jobs stuck in 'pending'

// Resume
// queue.stopRequested = false;  // Equivalent to queue = new SqliteQueue()
```

**Better approach:**
```typescript
class ManagedQueue {
  private processing = false;
  
  async start() {
    if (this.processing) return;
    this.processing = true;
    
    queue.process(async (job) => {
      await processJob(job);
    }, { concurrency: 1000 });
  }
  
  async pause() {
    this.processing = false;
    queue.stop();
  }
}
```

**Rules:**
- Don't just `kill` workers (jobs lost)
- Use `queue.stop()` to pause
- Remember to resume before restart

---

### Q: How do I monitor live performance?

**A:**
```typescript
setInterval(async () => {
  const metrics = await queue.getMetrics();
  const size = await queue.size();
  
  console.log({
    pending: metrics.pending,
    processing: metrics.processing,
    done: metrics.done,
    failed: metrics.failed,
    total: size
  });
}, 5000);
```

**Dashboarding:**
```typescript
// Push metrics to InfluxDB/Grafana
await influx.write({
  measurement: 'queue_metrics',
  tags: { name: 'default' },
  fields: metrics,
  timestamp: Date.now()
});
```

**Critical metrics:**
- `pending`: Queue depth
- `processing`: System load
- `throughput`: Jobs/sec (calc manually)
- `failure_rate`: Failed / (finished)
- `latency_average`: Time from enqueue to process

---

## Questions About Edge Cases

### Q: What happens if the DB file is corrupted?

**A:** Depends on severity.

**Minor corruption:**
```bash
# SQLite can often recover some data
sqlite3 broccoliq.db "PRAGMA integrity_check;"

# Recovery
sqlite3 broccoliq.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

**Major corruption:**
```bash
# Backup the corrupted file
cp broccoliq.db.backup.broken broccoliq.db

# Restore from backup
cp broccoliq.db.backup.wal broccoliq.db.wal
```

**Prevention:**
```bash
# Daily script
crontab -e
0 0 * * * cp broccoliq.db /backups/$(date +%Y%m%d).db
```

**BroccoliQ doesn't protect against corruption.** That's the database's job.

---

### Q: Can I run on different DB backends?

**A:** **No.** BroccoliQ uses SQLite only.

If you need Postgres/MySQL, build a wrapper:

```typescript
class PostgresQueue {
  private queue: Redis | RabbitMQ;
  
  enqueue(job) {
    return this.queue.publish('jobs', job);
  }
  
  process(handler) {
    return this.queue.subscribe('jobs', job => handler(job));
  }
}
```

**BroccoliQ value:**
- Pure SQLite optimizations (memory-first, agent shadows)
- Simple (no external dependencies)
- No migration needed

---

### Q: What's the maximum queue size?

**A:** Practically unlimited. Let's do the math:

```
RAM: 128GB × 10,000 jobs/GB = 1,280,000 jobs in memory

Disk: 10TB × 1GB/job = 10,000,000 jobs on disk

Constraints become:
- Time: 10,000 jobs @ 100ms = 1000 seconds = 17 minutes
- Memory: 1M jobs = 100GB
- Disk: 10M jobs = 10TB storage
```

**Realistic configuration for 100K ops/sec:**
- 10,000 jobs in memory (startup)
- 500 buffer jobs (intermediate)
- Clean up after 1 hour: `pruneDoneAgeMs: 3600000`

---

## Summary: The Final FAQ

| Question | Answer |
|----------|--------|
| **Does BroccoliQ replace a database?** | No, it uses one (SQLite). |
| **Best concurrency number?** | Measure: `concurrency = 1000 / avgJobTimeMs`. |
| **How to optimize reads?** | Preload or use indexes. |
| **What causes memory growth?** | Jobs not completing or circular buffer not GC'd. |
| **Can multiple processes share queue?** | Yes, that's how scaling works. |
| **Difference between process & processBatch?** | process: 1000 individual workers. processBatch: 1000 jobs as one batch. |
| **Does queue auto-retry?** | Yes, up to `defaultMaxAttempts`. |
| **How to handle large objects?** | Keep payload < 100KB, reference external storage. |
| **GC works when crash happens?** | ReclaimStaleJobs() handles it. |
| **Does queue guarantee ACID?** | Yes for writes via transactions. |
| **Max queue size?** | Unlimited, unless RAM/Time constraints. |
| **How to handle bursts?** | The queue naturally absorbs bursts. |

---

**You have everything now.** README → CONCEPTS → USAGE → ADVANCED → BEST_PRACTICES → FAQ.

Good luck building.