# How BroccoliQ Actually Works

This guide explains the mechanics of BroccoliQ in plain English. No technical jargon. No optimization levels. Just how it works and why it matters.

---

## Chapter 1: Concurrent Bookkeepers (Level 1)

### The Problem: The Lonely Bookkeeper

Imagine a library where one person must check every book out and back in.

```
Customer 1: Enter → Book checked out
            → Wait → Book returned

Customer 2: Enter → Book checked out
            → Wait → Book returned
```

**The bottleneck:** Each book takes 2 seconds. 1,000 books = 2,000 seconds = 33 minutes.

The library is full. The next customer waits forever. That's a database at 100% usage.

### The Solution: Two Bookkeepers

BroccoliQ uses **dual buffers**—two buffers instead of one.

```
[Buffer A] ← 1,000 books selected
           → Time passes
           → Swap Buffer A ↔ Buffer B
           → Buffer A writes to shelves (slow)
           → Buffer B is ready for next 1,000 books
```

**How it works:**

1. **Write Phase:** You send 1,000 operations to Buffer A
2. **Swap Phase:** After 10ms, swap Buffer A ↔ Buffer B
3. **Flush Phase:** Buffer A writes to disk (slow, nobody sees)
4. **Repeat:** While Buffer A writes, Buffer B receives new operations

**The magic:**
- Writing to Buffer A takes **0ms** (in-memory swap)
- Buffer A flushes total time = 10-20ms (background)
- You keep writing instantly!

**Result:** After 10ms, you're still receiving 1,000 operations per second. The previous 1,000 are finishing with zero overhead.

---

## Chapter 2: Private Offices (Level 2)

### The Problem: The Open Office

Imagine 500 people working in an open floor. Every decision is a meeting. Every write is a conversation.

```
Worker A: "I think this value should be 5" 
        → Worker B: "I disagree, 10 is better"
        → Worker C hears all
        → Lock held: everyone stops

Or worse:
        → A writes to DB
        → B writes to DB
        → Lock loses: transaction loses!
```

**The bottleneck:** 500 workers waiting for one write operation.

### The Solution: Private Offices

BroccoliQ introduces **Agent Shadows**—each worker gets a private buffer.

```
Worker A has private room (agent-1)
Worker B has private room (agent-2)
```

**How it works:**

```typescript
// Worker A writes to its shadow
await dbPool.beginWork('agent-1');
await dbPool.push({ type: 'insert', table: 'orders', values: {...} });
await dbPool.commitWork('agent-1');  // Commit takes total of 1 op

// Worker B writes to its shadow
await dbPool.beginWork('agent-2');
await dbPool.push({ type: 'insert', table: 'orders', values: {...} });
await dbPool.commitWork('agent-2');

// Both are independent! No locks, no collisions.
```

**The magic:**
- Each worker writes to its private shadow buffer
- Commit merges shadow into main buffer (atomic)
- Worker B sees nothing of Worker A's writes until commit
- Worker A sees nothing of Worker B's writes

**Result:** 500 workers work at once, independently. Execution time = 1 write operation per worker, not 500.

---

## Chapter 3: Instant Rejection (Visibility Timeout)

### The Problem: The Ghost Job

Imagine a post office worker falls asleep on the job. Letters continue stacking up.

```
Letter 1: Processed, stamp added
Letter 2: Processed, stamp added
...
Letter 127: Stamp added, worker sleeps
Letter 128+: Stack grows indefinitely

At worker's death: Who knows how many letters?!
```

**The issue:** Process crashes, jobs stuck in 'processing'. They're never recovered.

### The Solution: Time Limit = Automatic Rejection

BroccoliQ introduces **visibility timeout**—jobs higher than this are reclaimed.

```typescript
const queue = new SqliteQueue({ 
  visibilityTimeoutMs: 300000  // 5 minutes
});
```

**How it works:**

Every job added to the queue gets a timestamp:

```
Job: "Send email" ← 14:00:00 (entered queue)
Job: "Process payment" ← 14:00:01

At 14:05:00 (5 minutes later):
  • Reclaim old jobs that never "processed"
  • Job from 14:00:01 jumps back to "pending"
  • Worker picks it up again
```

**The magic:**

```typescript
// Process crashes at 14:00:10 (0.1 seconds after starting)
// User restarts application at 14:10:00 (10 minutes later)

await queue.reclaimStaleJobs();  // Check visibility timeout

// Output: [SqliteQueue] Reclaiming 127 stale jobs.
```

**Result:** Jobs that were processing 10 minutes ago are now pending. No lost work. No intervention.

---

## Chapter 4: Increment Merging (Level 6)

### The Problem: The Counter Fight

You're counting apples. One guy says "one." Another says "one." Another says "one."

Implementation: 
```
Transaction 1: UPDATE counters SET count = count + 1
Transaction 2: UPDATE counters SET count = count + 1  
Transaction 3: UPDATE counters SET count = count + 1
```

**The bottleneck:** 3 transactions, 3 database writes.

### The Solution: Builder's Punch

BroccoliQ merges consecutive increments—like a builder punching nails.

```typescript
// These three calls:

await dbPool.push({
  type: 'update',
  table: 'counters',
  values: { count: dbPool.increment(1) }  // +1
});

await dbPool.push({
  type: 'update',
  table: 'counters',
  values: { count: dbPool.increment(1) }  // +1
});

await dbPool.push({
  type: 'update',
  table: 'counters',
  values: { count: dbPool.increment(2) }  // +2
});

// In Level 6:
// Storage: { count: +4 }

// Transaction: 1 instead of 3
```

**How it works:**

1. **Detect:** See three 'increment' operations
2. **Merge:** Accumulate values: +1 +1 +2 = +4
3. **Output:** One transaction: UPDATE counters SET count = count + 4

**The magic:**
- 1,000 people increment by +1
- In old system: 1,000 transactions
- In BroccoliQ: 1 transaction

**Result:** 1000x more throughput for counters.

---

## Chapter 5: Circular Buffers (Memory-First)

### The Problem: The Line at the Breeze

Imagine a coffee shop queue. Customer enters → we write to database.

```
Queue: [Customer 1] → [Customer 2] → [Customer 3] → ... → [Customer 1000]

Each Customer write = 10ms database operation
Queue completion time = 10,000ms = 10 seconds
```

**The bottleneck:** Writing to database takes 10ms per customer.

### The Solution: The Breeze Down the Hallway

BroccoliQ introduces **circular buffers**—store jobs in memory first.

```typescript
const buffer = new Array(1000000).fill(null);
let head = 0;  // Where are we taking from?
let tail = 0;  // Where are we adding to?
```

**How it works:**

1. **Add job:** Place at buffer[tail], increment tail
2. **Read job:** Take from buffer[head], increment head
3. **Loop:** head at end? head = 0 (circular)

**The magic:**
```typescript
// Add 1000 jobs
buffer[tail] = job1; tail++
buffer[tail] = job2; tail++
// ... 999 more times

// Read 1000 jobs
const head = 0;
job1 = buffer[head]; head++
job2 = buffer[head]; head++
// ... read, then clear

// Transaction: 1ms read operation
// Previous: 10,000ms database operation
```

**Result:**
- Even 1,000,000 jobs wait in memory
- Only if RAM is empty do we query database
- Read latency: 1ms, not milliseconds

---

## Chapter 6: Pipeline Workers

### The Problem: The One-Barista Shop

Single worker processes jobs one by one.

```
Orders: [1] → [2] → [3] → ... → [100]

Worker: Processing [1] ... 5 seconds ...
       Worker: Processing [2] ... 5 seconds ...
       Worker: Processing [3] ... 5 seconds ...
```

**The bottleneck:** Worker is idle while processing one job.

### The Solution: The Multi-Barista Crisis

BroccoliQ introduces **pipeline concurrency**—start new worker before old finishes.

```typescript
const queue = new SqliteQueue({ concurrency: 500 });
```

**How it works:**

1. **Dequeue:** Get 500 jobs
2. **Fire:** 500 workers process simultaneously
3. **Wait:** While workers process, start next 500

**The magic:**
```
Time 0ms:    Dequeue 500 jobs
Time 1ms:    500 workers running
             Queue empties
Time 10ms:   Background theft: steal another 500
Time 11ms:   500 more workers running
Time 20ms:   Queue empties again...
```

**Result:**
- 100 bars running at once
- Never idle while workers process
- Throughput = 500 jobs simultaneously

---

## Chapter 7: Transaction Isolation (Agent Shadows)

### The Problem: The Shaky Foundation

Three builders building the same table. One piece of wood falls off, table crashes, all three undo everything.

```typescript
Transaction 1: Add leg 1 (successful)
Transaction 2: Add leg 2 (oops!)
```

**The issue:** If Transaction 2 fails, Transaction 1 is lost.

### The Solution: The Team Meeting

BroccoliQ groups writes into **transactions**—only all work or none work.

```typescript
await dbPool.runTransaction(async (agentId) => {
  await dbPool.push({ type: 'insert', table: 'orders', ... });  // Leg 1
  await dbPool.push({ type: 'insert', table: 'orders', ... });  // Leg 2
  await dbPool.push({ type: 'insert', table: 'orders', ... });  // Leg 3
  // All 3 committed as ONE transaction
});
```

**How it works:**

1. **Start Transaction:** Create shadow buffer
2. **Write Operations:** Mark operations as "in transaction"
3. **Commit:** Merge shadow into main buffer (single flush)
4. **Rollback:** If any op fails, drop all (like nothing happened)

**The magic:**
- 1,000 operations in transaction
- Only 1 database transaction
- 0 partial commits

**Result:**
- Consistency: All or nothing
- Speed: 1 transaction instead of 1,000
- Safety: Never lose part of a batch

---

## Chapter 8: Retry Logic (Exponential Backoff)

### The Problem: The Broken Nail

A hammer falls, breaks, hammer tried again and again and again.

**Result:**

```
Attempt 1:  ERROR
Attempt 2:  ERROR
Attempt 3:  ERROR
...
Attempt 10: ERROR (give up)
```

**The issue:** Even reliable tasks fail sometimes (timeout, network glitch). We give up too early.

### The Solution: Buried Soldiers

BroccoliQ uses **exponential backoff**—retry waiting longer each time.

```typescript
const queue = new SqliteQueue({ 
  baseRetryDelayMs: 1000  // 1 second base
});
```

**How it works:**

```
Attempt 1:  ERROR at 0s → Retrying in 1s
Attempt 2:  ERROR at 1s → Retrying in 2s
Attempt 3:  ERROR at 3s → Retrying in 4s
Attempt 4:  ERROR at 7s → Retrying in 8s
Attempt 5:  SUCCESS at 15s
```

**The magic:**

```typescript
// Job fails at 0s
await queue.fail('job-123', 'timeout');

// Job replays at:
// 1s, 2s, 4s, 8s, 16s = 31 seconds total

// Eventually succeeds when network stabilizes
```

**Result:**
- Unreliable tasks eventually succeed
- Reputations not ruined by temporary failures
- Automatic retries, no intervention

---

---

## Chapter 9: Sovereign Locking (Global Permission)

### The Problem: The Shared To-Do List

Imagine a team of 10 people working on the same kitchen. Two people try to chop the same onion at the same time.

Implementation:
1. Agent A: "I'm starting the onion."
2. Agent B: "I'm starting the onion."
3. Result: Two people, one onion, and a mess.

**The issue:** Standard locks only work inside one person's head (one process). Agents in different rooms (processes) don't know what others are doing.

### The Solution: The Master Key

BroccoliDB introduces **Sovereign Locking**—a global permission system that uses the database as the source of truth.

**How it works:**
1. **Try to Claim:** Agent A asks: "Can I have the Master Key for 'chopping-onions'?"
2. **Atomic Write:** The system tries to write Agent A's name in the "Master Key" office.
3. **Winner Takes All:** If Agent A gets it, anyone else asking is told "Access Denied."
4. **Heartbeat:** Agent A keeps telling the office "I'm still here!" every few seconds.

**The magic:**
- If Agent A falls asleep, the office notices they haven't checked in.
- The Master Key is automatically taken back and given to the next person who asks.
- No two people ever chop the same onion.

**Result:** Global coordination across hundreds of independent agents without a central supervisor.

---

## Chapter 10: Autonomous Integrity (Self-Cleaning)

### The Problem: The Messy Workshop

A workshop where sawdust builds up, tools break, and parts get lost under the table. Eventually, you can't find anything and the floor is dangerous.

**The issue:** Most systems just let data rot. Corrupted files stay corrupted. Dead records stay forever.

### The Solution: The Invisible Assistant

BroccoliDB has an **Autonomous Integrity Worker**—a background assistant that never sleeps.

**How it works:**
1. **Physical Audit:** Check every shelf (file) for damage or dust.
2. **Logical Repair:** Find a spare part? Put it back where it belongs. Find a broken tool? Throw it out.
3. **Space Management:** Sweep the floor (Vacuum) and reorganize the bins (Reindex) so you can find things faster.

**The magic:**
- You don't have to hire a librarian (DBA).
- The system keeps itself fast and healthy while you work.
- It prunes old memories (telemetry) so you never run out of room.

**Result:** A database that stays as fast as day one, forever.

---

## Chapter 11: Sharded Concurrency (Scaling Out)

### The Problem: The Single Door

A massive stadium with 100,000 people, but only one entrance. No matter how fast people walk, the door is the limit.

**The issue:** A single database file has a limit on how much "work" it can handle at once.

### The Solution: The Ten-Door Stadium

BroccoliDB supports **Sharding**—splitting the database into multiple independent "doors."

**How it works:**
1. **Partition:** Instead of one massive file, create 10 smaller ones.
2. **Route:** Give 10,000 people Ticket A (Shard A) and 10,000 people Ticket B (Shard B).
3. **Parallelism:** All 10 doors operate at the same time.

**The magic:**
- 10x more people can enter at once.
- If one door gets stuck, the other 9 keep working.
- You can add more doors as the crowd grows.

**Result:** Horizontal growth without hitting the "single door" bottleneck.

---

## Summary: The What That Matters

| Mechanism | Why It Matters | Real-World Analogy |
|-----------|----------------|-------------------|
| **Dual Buffers** | Infinite write parallelism | Two baristas, no line |
| **Agent Shadows** | Lock-free worker independence | Private offices, not open floor |
| **Visibility Timeout** | Never lose jobs to crashes | Post office reclaiming old letters |
| **Sovereign Locking** | Global swarm coordination | The Master Key system |
| **Autonomous Integrity** | Self-healing and auto-cleanup | The Invisible Assistant |
| **Sharded Concurrency** | Scale beyond single file limits | The Ten-Door Stadium |

---

## Next Steps

1. **guide.md** (1 hour) → Coffee shop to your system
2. **architecture_explained.md** (2 hours) → The deep math
3. **usage.md** (15 min) → Copy-paste patterns

**BroccoliDB: Your infrastructure should be as smart as your agents.**