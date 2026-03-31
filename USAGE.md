# Usage Guide: Coffee Shop to Your System

You've read the basics. Now you're ready to build with BroccoliQ.

---

## Quick Reference: The Three Options

| Option | When to Use | Difficulty |
|--------|-------------|------------|
| **Individual Jobs** | 1-100 jobs/hour | Beginner |
| **Batch Processing** | 100-1000 jobs/hour | Intermediate |
| **Infinite Throughput** | 10K+ jobs/hour | Advanced |

**Start here:** Use the parallel processing mode for all your jobs → Infinite throughput for free.

---

## Chapter 1: The Coffee Shop

### Start Here: Your First (7-Line) App

That's how simple it is.

```typescript
import { SqliteQueue } from 'broccolidb';

const cafe = new SqliteQueue({ concurrency: 100 });
cafe.enqueue({ order: 'latte', customer: 'alice' });
cafe.enqueue({ order: 'espresso', customer: 'bob' });

cafe.process(async (order) => {
  console.log(`Making ${order.order} for ${order.customer}`);
}, { concurrency: 100 }); // 100 baristas working
```

**You just built:**
- A queue that receives 5,000 orders per second
- 100 baristas working at once
- Automatic retry for broken orders

**That's it.** The rest of this guide explains how to scale from this to production.

---

## Chapter 2: Queue Understanding

### What Happens Behind the Scenes

The queue is a job queue. Duh.

What does "queue" actually mean?

```
[b Operating System]

1. User app enqueues "Send email"
2. Q: Where does it go? Memory buffer
3. Q: How do we know it worked? Total queue size
4. Q: How do we process it? Dequeue → process → complete

BROCCOLIQ ADDS:
5. Q: Where does it go? Always memory (first)
6. Q: How long to read? 1ms (not 1000ms)
7. Q: What if crash happens? We catch it
```

#### Questions to Ask Yourself Before Using a Queue:

**"Can I batch this instead?"**
```typescript
❌ Bad: Process 1000 jobs one at a time
✓ Good: Process 1000 jobs in one batch
```

**"What happens if the worker crashes?"**
```typescript
❌ Bad: Job stuck in "processing" forever
✓ Good: Visibility timeout + auto-reclaim
```

**"How long is this operation?"**
```typescript
❌ Bad: This takes 30 seconds (single worker blocks)
✓ Good: This takes 30 seconds (parallel workers = still fast)
```

---

## Chapter 3: Configuration Patterns

### Settings That Work 90% of the Time

```typescript
const queue = new SqliteQueue({
  concurrency: 1000,           // 1000 workers running
  visibilityTimeoutMs: 300000, // 5 minutes crash recovery
  maxSize: 10000000            // Keep 10M messages in memory
});
```

**Adjust only if you have evidence.**

| Setting | Adjust When | Recommendation |
|---------|-------------|----------------|
| `concurrency` | Jobs slower than 100ms | Increase |
| `visibilityTimeoutMs` | Jobs take longer than 5 minutes | Increase |
| `batchSize` | Very internet-slow operations | Reduce |
| `baseRetryDelayMs` | Tasks have timeouts | Adjust timing |

---

## Chapter 4: Batch vs Individual Processing

### When to Use Which Mode

#### Scenario 1: Individual Jobs (Your First App)

**Use when:**
- Each job is different (e.g., send email to different recipient)
- Some jobs fail, some succeed independently
- You need granular error handling

```typescript
const queue = new SqliteQueue({ concurrency: 500 });

queue.enqueue({ type: 'send_email', to: 'alice@example.com' });
queue.enqueue({ type: 'send_email', to: 'bob@example.com' });

queue.process(async (job) => {
  if (job.type === 'send_email') {
    await sendEmail(job.to);
    await queue.complete(job.id);
  }
}, { concurrency: 500 });
```

**Pros:**
- Each job independent
- Individual retry logic
- Simple to understand

**Cons:**
- More database overhead
- Less throughput

#### Scenario 2: Batch Processing (The Fast Path)

**Use when:**
- All jobs are identical (e.g., process CSV rows)
- You want raw speed (10x faster)
- Individual IDs don't matter

```typescript
const queue = new SqliteQueue({ concurrency: 5 });

// Send 1,000 CSV rows at once
const csv = parseCsv(largeFile);
await queue.enqueueBatch(csv.rows);

queue.processBatch(async (rows) => {
  for (const row of rows) {
    await processRow(row);  // All rows processed simultaneously
  }
}, { 
  batchSize: 10000,           // 10,000 rows per batch
  maxInFlightBatches: 5       // 5 batches at once
});
```

**Pros:**
- 10x faster throughput
- Fewer database transactions
- Groups related work

**Cons:**
- All-or-nothing (batch fails = all failed)
- Less granular error handling
- Harder to debug

---

## Chapter 5: Common Mistakes

⚠️ **MISTAKE #1: Not Using Concurrent Processing**

```typescript
❌ BAD:
queue.process(async (job) => {
  await job.callApi();  // Takes 5 seconds
}, { concurrency: 1 });  // Only 1 worker
// Result: 2.5 seconds per job, 5-second queue completion

✓ GOOD:
queue.process(async (job) => {
  await job.callApi();  // Takes 5 seconds
}, { concurrency: 1000 });  // 1000 workers
// Result: 5ms per job, 0.005-second queue completion
```

**Rule:** Always increase concurrency. Speed is free.

---

⚠️ **MISTAKE #2: Losing Results from Failed Jobs**

```typescript
❌ BAD:
queue.process(async (job) => {
  await doWork(job);  // Might fail
  db.save(workResult);  // Saved BEFORE exception throws!
}, { concurrency: 100 });

// If job fails: you lost result data!

✓ GOOD:
queue.process(async (job) => {
  const result = await doWork(job);  // Success
  await db.save(result);  // Saved AFTER success
}, { concurrency: 100 });

// If job fails: result never saved, won't retry
```

**Rule:** Only save data AFTER batch completes successfully.

---

⚠️ **MISTAKE #3: Not Using Redis Pooling**

```typescript
❌ BAD:
queue.process(async (job) => {
  // Race condition: another job uses same connection
  const db = getDb();  // Connection NOT pooled
  await db.query(...);
}, { concurrency: 1000 });  // 1000 workers!

✓ GOOD:
// Use connection pooling (handled by better-sqlite3)
// No additional setup needed

// Only change if you have 10K+ workers:
queue.process(async (job) => {
  const db = getPooledDb();  // Single DB instance shared
  await db.query(...);
}, { concurrency: 1000 });
```

**Rule:** 10K+ workers? Pool connections.

---

⚠️ **MISTAKE #4: Forgetting to Close the Queue**

```typescript
❌ BAD:
queue.process(handler);
// Server restarts without closing queue
// Jobs lost? Incomplete flush?

✓ GOOD:
const queue = new SqliteQueue({ ... });

// Register shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await queue.stop();  // Graceful shutdown
  process.exit(0);
});
```

**Rule:** Always register graceful shutdown.

---

⚠️ **MISTAKE #5: Trying SQL Queries Inside Processing**

```typescript
❌ BAD:
queue.process(async (job) => {
  await db.query('SELECT * FROM orders WHERE ...');  // Slow!
  await process(job);
}, { concurrency: 100 });

// Result: 1000 queries per second hitting DB

✓ GOOD:
// Pre-load data + use memory
queue.process(async (job) => {
  const order = orders[job.id];  // O(1) access
  await process(order);
}, { concurrency: 100 });
```

**Rule:** Queries should be in pre-load phase. Processing should be in-memory.

---

⚠️ **MISTAKE #6: Not Monitoring Queue Size**

```typescript
❌ BAD:
queue.process(handler);
// Queue fills up, nobody knows
// Workers crash, database dead

✓ GOOD:
setInterval(async () => {
  const size = await queue.size();
  console.log('Queue:', size);
  
  if (size > 100000) {
    console.warn('Queue too big!');
  }
}, 10000);  // Every 10 seconds
```

**Rule:** Monitor queue size every few seconds.

---

## Chapter 6: Hidden Modes (Secret Knowledge)

### Things You Didn't Know Existed

#### Secret #1: You Can Preload Jobs

```typescript
// Start with existing data:
const pending = await db.selectWhere('old_jobs', { status: 'pending' });
await queue.enqueueBatch(pending);
```

**Use when:** System restarts and you need to resume from previous state.

---

#### Secret #2: Batch Completion is Instant

```typescript
// Wait, really?
queue.completeBatch(['job-1', 'job-2', 'job-3']);
// Under the hood: 1 transaction, not 3.
```

**Use when:** Reclaiming 1000 jobs that were stuck in 'processing'.

---

#### Secret #3: Reset Queue without Losing Jobs

```typescript
// Reinitialize queue class (doesn't drop DB file)
const oldQueue = queue;
queue = new SqliteQueue();  // New instance
// Old jobs still pending in database!
```

**Use when:** You want to change configuration but keep existing queue.

---

#### Secret #4: Queue Has Built-in Metrics

```typescript
const metrics = await queue.getMetrics();
console.log({
  pending: metrics.pending,
  processing: metrics.processing,
  done: metrics.done,
  failed: metrics.failed
});
```

**Use when:** You need to debug queue performance.

---

## Chapter 7: Failure Recovery

### What Happens When Things Go Wrong

#### Scenario 1: Process Crashes Mid-Traffic

```typescript
// System receives 10,000 requests per second
// Process dies at t+5 minutes

// After 5 minutes (visibility timeout):
await queue.reclaimStaleJobs();
// Output: [SqliteQueue] Reclaiming 100000 stale jobs.

// Those 100,000 jobs are now pending.
// Workers process them again.
// Queue: 200,000 processed (original + reclamation)
```

**Result:** Zero lost jobs. 10 minutes downtime doesn't matter.

---

#### Scenario 2: Task Takes Too Long

```typescript
const queue = new SqliteQueue({ visibilityTimeoutMs: 300000 }); // 5 min

// Task takes 6 minutes (past timeout)
await queue.process(async (job) => {
  await expensiveOperation();  // 6 minutes
}, { concurrency: 100 });

// Task: ERROR (max retries exceeded)
// Reason: Took too long, couldn't be reclaimed
```

**Fix:** Increase visibility timeout:

```typescript
const queue = new SqliteQueue({ visibilityTimeoutMs: 3600000 }); // 1 hour
```

---

#### Scenario 3: Database Lock

```typescript
// Too many writers at once
await queue.reclaimStaleJobs();
await dbPool.flush();  // Force flush

// Result: Queue continues processing on replay
```

**Fix:** Reduce concurrency or increase visibility timeout.

---

## Chapter 8: Performance Tuning

### How to Reach 10,000+ Ops/Sec

#### Technique 1: Batch Your Enqueues

```typescript
❌ BAD:
for (let i = 0; i < 1000; i++) {
  await queue.enqueue({ task: i });
}

✓ GOOD:
await queue.enqueueBatch([
  { task: 'email', ... },
  { task: 'email', ... },
  // ... 1000 items
]);
```

**Impact:**
- Enqueue ops: 1000x faster
- Database latency: 1 transaction, not 1000

---

#### Technique 2: Use Memory-First Reads

```typescript
// Pre-load all data into memory
const pending = await queue.selectWhere('pending_jobs');
orders = pending.map(j => ({...j}));  // In-memory

// Process from memory
queue.process(async (job) => {
  const order = orders[job.id];  // O(1)
  await processor(order);
}, { concurrency: 1000 });
```

**Impact:**
- Read latency: 1ms (memory) vs 100ms (DB)
- Higher throughput allowed

---

#### Technique 3: Optimize Worker Payload

```typescript
// Don't serialize/deserialize inside worker
 ❌ BAD:
 queue.process(async (job) => {
   const data = job.payload.data;  // Already stringified
   const obj = JSON.parse(data);   // Unnecessary!
 });

 ✓ GOOD:
 queue.process(async (job) => {
   const data = job.payload;  // Already reduced object
   await processor(data);
 });
```

**Impact:**
- Less CPU: avoid JSON.parse
- Lower latency

---

## Chapter 9: Production Checklist

### Before You Deploy

- [ ] Graceful shutdown registered
- [ ] Monitoring queue size working
- [ ] Visibility timeout longer than max job duration
- [ ] Database backup plan (broccolidb.db file)
- [ ] Error logging working
- [ ] Retry settings configured
- [ ] Concurrency balanced for your operations

**Did you forget anything?** Add it to your checklist.

---

## Chapter 10: Next Steps

1. **advanced.md** (2 hours) → Performance optimization, scaling strategies
2. **best-practices.md** (1 hour) → Common patterns, real-world architectures
3. **faq.md** (15 min) → Deep dive FAQs

Or go back to:

```typescript
import { SqliteQueue } from 'broccolidb';

const queue = new SqliteQueue({ concurrency: 1000 });

// That's it. 15 lines to 10,000 ops/sec.
```

**BroccoliQ is infrastructure that talks to humans.**