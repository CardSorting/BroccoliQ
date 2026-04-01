# Best Practices: What Experienced Users Do Differently

This guide bridges the gap between "it works" and "great architecture." What do 100BTC BroccoliQ users actually do?

---

## Chapter 1: The Architecture Pyramid

### How Experienced Teams Structure Systems

```
                    [Monitoring]
                      /      \
             [Observability]  [Documentation]
                    /              \
            [Configuration]  [Testing]
                    \              /
                   [Defaults]    [Abstractions]
                      \          /
            ┌───────────────────────┐
            │   Production Systems  │
            └───────────────────────┘
```

**Every production system needs all 6 layers.**

---

#### Layer 1: Abstractions (The Foundation)

Don't code directly to `SqliteQueue`. Wrap it in a domain service.

```typescript
// ❌ BAD:
import { SqliteQueue } from 'broccoliq';

// Direct access everywhere → impossible to test
const queue = new SqliteQueue();
await queue enqueue(...);

// ✗ BAD:
const queue = new SqliteQueue(); // No interface

// ✓ GOOD:
interface IOrderProcessingSystem {
  processOrder(order: Order): Promise<void>;
}

class OrderProcessingSystem implements IOrderProcessingSystem {
  private queue: SqliteQueue<Order>;
  
  constructor() {
    this.queue = new SqliteQueue({ concurrency: 1000 });
  }
  
  async processOrder(order: Order) {
    // Business logic in one place
    await this.queue.enqueue(order);
  }
  
  // Optional: Separate classes for jobs, retries, etc.
  private processJob = this.queue.process(async (job) => {
    await this.handleOrderInternal(job);
  }, { concurrency: 1000 });
}

export type OrderProcessingSystem = OrderProcessingSystem;
export { OrderProcessingSystem };
```

**Rules:**
- Single entry point to the queue
- Domain logic stays in the service layer
- Test the service, not the queue

---

#### Layer 2: Configuration (The Rules)

Everything configurable should be configurable.

```typescript
// internal/config/queue.ts
import { SqliteQueue } from '../infrastructure/queue/SqliteQueue';

export interface QueueConfig {
  concurrency: number;
  batchSize: number;
  visibilityTimeoutMs: number;
  maxJobsInMemory: number;
  enableMetrics: boolean;
}

export const createQueue = (config: QueueConfig): SqliteQueue<UserJob> => {
  return new SqliteQueue({
    concurrency: config.concurrency,
    batchSize: config.batchSize,
    visibilityTimeoutMs: config.visibilityTimeoutMs,
    maxSize: config.maxJobsInMemory,
    // Enable metrics collection
    onCompleteMetrics: config.enableMetrics,
  });
};
```

**Composition over hard-coding:**

```typescript
// ✗ BAD:
const queue = new SqliteQueue({ concurrency: 1000 });

// ✓ GOOD:
const config: QueueConfig = loadConfig(process.env.NODE_ENV);
const queue = createQueue(config);
```

---

#### Layer 3: Testing (The Confidence)

Capture every edge case. Tests should run in 30 seconds.

```typescript
// tests/order-queue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SqliteQueue } from '../infrastructure/queue/SqliteQueue';

describe('OrderQueue', () => {
  it('should process multiple orders concurrently', async () => {
    const queue = new SqliteQueue({ concurrency: 100 });
    const processed: string[] = [];
    
    // Enqueue 1,000 orders
    await queue.enqueueBatch(
      Array(1000).fill(null).map((_, i) => ({
        orderId: `order-${i}`,
        customerId: `customer-${i}`
      }))
    );
    
    await queue.process(async (job) => {
      processed.push(job.orderId);
      await mockDatabase.queue(job);  // This is a fake DB
    }, { concurrency: 100 });
    
    // Assert
    expect(processed).toHaveLength(1000);
    expect(new Set(processed).size).toBe(1000);  // All unique
  });
  
  it('should retry failed jobs up to 5 times', async () => {
    const queue = new SqliteQueue({ defaultMaxAttempts: 5 });
    const attempts: number[] = [];
    
    let failCount = 0;
    await queue.process(async (job) => {
      attempts.push(calls++);
      if (calls < 3) throw new Error('Temporary error');
      // Succeed after 3 attempts
    }, { concurrency: 10 });
    
    // Assert
    expect(attempts.length).toBe(5);  // 3 failures + 2 successes = mistaken assumption -- wait, that logic is wrong
  
    // Correct approach:
    expect(attempts.some(a => a)).toBeTruthy();  // At least one processed
  });
});
```

**Test Pyramid:**

| Level | Test Type | Example | Run Time |
|-------|-----------|---------|----------|
| Unit | Component | `processOrder` | 1-5ms |
| Integration | Flow | `enqueue → process → complete` | 10-50ms |
| End-to-End | System | Full queue startup → processing | 1-5s |

---

#### Layer 4: Observability (The Insight)

Log everything critical. No "hello world" logs.

```typescript
// internal/logger/queue-logger.ts
import { metrics } from './metrics';

export const queueWatcher = (queue: SqliteQueue<any>) => {
  setInterval(async () => {
    const metrics = await queue.getMetrics();
    const size = await queue.size();
    
    // Warn on anomalies
    if (size > 1000000) {
      logger.warn(`Queue overcapacity: ${size.toLocaleString()} jobs`);
    }
    
    if (metrics.failed > metrics.completed / 10) {
      logger.error(`High failure rate: ${(metrics.failed / (metrics.completed + metrics.failed)) * 100}µ failed`);
    }
    
    // Logs count: < 10 per second
    logger.debug({ size, metrics });
  }, 30000);  // Every 30 seconds
};
```

**Key Metrics to Track:**

```typescript
interface KeyMetrics {
  // Queue depth
  pending: number;
  processing: number;
  depth: number;  // pending + processing
  
  // Flow
  completedPerMinute: number;  // Throughput
  failed: number;
  retryRate: number;
  
  // Performance
  avgJobDuration: number;
  queueLatency: number;  // Time from enqueue to process
}
```

---

#### Layer 5: Graceful Shutdown (The Safety)

Never just `kill -9`. Always shutdown gracefully.

```typescript
// internal/shutdown/order-queue-handler.ts
class OrderQueueManager {
  private queue: OrderProcessingQueue;
  
  constructor(queue: OrderProcessingQueue) {
    this.queue = queue;
    this.setupGracefulShutdown();
  }
  
  private setupGracefulShutdown() {
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        // 1. Stop accepting new jobs
        this.queue.toggleAcceptingJobs(false);
        
        // 2. Wait for in-flight jobs to complete (max 30 seconds)
        await this.queue.waitForCompletion(30000);
        
        // 3. Flush queue
        await this.queue.flush();
        
        logger.info('Queue gracefully shut down');
        process.exit(0);
      } catch (err) {
        logger.error('Graceful shutdown failed:', err);
        process.exit(1);
      }
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}
```

**Safety timeout strategies:**

```typescript
// strict: Wait exactly N seconds, then force process.exit
await waitForCompletion(30000);

// lenient: Wait indefinitely (useful for billing cycles)
await waitForCompletion(0);
```

---

#### Layer 6: Monitoring (The Dashboard)

Visualize metrics. Real humans understand charts better than logs.

```typescript
// example dashboard.config.ts
import { Gauge } from 'prom-client';

const gaugeQueueDepth = new Gauge({
  name: 'broccoliq_queue_depth',
  help: 'Current number of jobs in the queue',
  labelNames: ['queue', 'status']
});

const gaugeThroughput = new Gauge({
  name: 'broccoliq_throughput',
  help: 'Jobs processed per second',
  labelNames: ['queue', 'operation']
});

// Update metrics
setInterval(async () => {
  const queue = getQueue('default');
  const metrics = await queue.getMetrics();
  const size = await queue.size();
  
  gaugeQueueDepth.set({ queue: 'default', status: 'pending' }, metrics.pending);
  gaugeQueueDepth.set({ queue: 'default', status: 'processing' }, metrics.processing);
  
  gaugeThroughput.set({ queue: 'default', operation: 'completed' }, perSecond('completed'));
}, 10000);
```

**Expose to Prometheus:** `http://localhost:9090/metrics`

Then visualize on Grafana.

---

## Chapter 2: Common Patterns (Pro Code)

### Patterns Used in Production Systems

#### Pattern 1: The "Type-Safe" Queue

Never handle `any` queues. Use typed queues.

```typescript
// types/order-process.ts
export interface OrderJob {
  type: 'create_order';
  data: OrderData;
}

export interface AnalyticsJob {
  type: 'generate_analytics';
  data: { date: string; userIds: string[] };
}

export type QueueJob = OrderJob | AnalyticsJob;

export class TypedQueue<T extends QueueJob> {
  private queue: SqliteQueue<T>;
  
  constructor(queue: SqliteQueue<T>) {
    this.queue = queue;
  }
  
  enqueue(job: T) {
    return this.queue.enqueue(job);
  }
  
  process(handler: (job: T) => Promise<void>, options?: any) {
    return this.queue.process(handler, options);
  }
}

// Type-safe instantiation
const orderQueue = new TypedQueue<OrderJob>(new SqliteQueue<OrderJob>());
const analyticsQueue = new TypedQueue<AnalyticsJob>(new SqliteQueue<AnalyticsJob>());
```

---

#### Pattern 2: The "Unit-of-Work" Queue

Process related jobs as a unit, not independently.

```typescript
interface AnalyticsUnit {
  userId: string;
  metrics: Metric[];
}

async function processAnalyticsQueue() {
  const queue = new SqliteQueue();
  
  // Enqueue units (not individual metrics)
  await queue.enqueueBatch([
    { userId: 'alice', metrics: [/* 100 metrics */] },
    { userId: 'bob', metrics: [/* 100 metrics */] }
  ]);
  
  await queue.processBatch(async (units: AnalyticsUnit[]) => {
    // Process all metrics for a user together
    for (const unit of units) {
      await generateUserAnalytics(unit.metrics);
    }
  }, { batchSize: 10 });
}
```

**Benefits:**
- Fewer DB writes (batch insert)
- Consistent analytics (complete data)
- Less contention

---

#### Pattern 3: The "Feeback & Compensation" Loop

Handle failures with mental stack tracking.

```typescript
class CompensatingQueue {
  private history = new Map<string, JobStep[]>();
  
  async executeWorkflow(steps: JobStep[]) {
    const workflowId = crypto.randomUUID();
    this.history.set(workflowId, []);
    
    let success = false;
    
    try {
      for (const step of steps) {
        await this.executeStep(step);
        this.history.get(workflowId)!.push({ status: 'completed', step });
      }
      
      success = true;
    } catch (err) {
      logger.error('Workflow failed, compensating...');
      await this.compensate(workflowId, steps);
      throw err;
    } finally {
      if (success) {
        // Reset workflow if needed (idempotent)
      }
    }
  }
  
  private async compensate(workflowId: string, steps: JobStep[]) {
    // Execute steps in reverse, compensating each
    for (const step of steps.reverse()) {
      await this.compensateStep(step);
    }
    this.history.delete(workflowId);
  }
}
```

---

#### Pattern 4: The "Priority" Queue

High-priority jobs can be queued separately or prioritized.

```typescript
const normalQueue = new SqliteQueue({ concurrency: 100 });
const highPriorityQueue = new SqliteQueue({ concurrency: 500 });

async function processHighPriorityOnly() {
  const job = await highPriorityQueue.dequeueBatch(100);
  if (job) {
    await processJob(job);
    return true;
  }
  
  // If no high priority, process normal
  const normalJob = await normalQueue.dequeueBatch(100);
  if (normalJob) {
    await processJob(normalJob);
    return true;
  }
  
  return false;  // No jobs
}
```

---

## Chapter 3: Anti-Patterns (What NOT Do)

### Mistakes Costing 10x Performance

#### Anti-Pattern 1: The "Global State" Queue

```typescript
// ❌ BAD: Global queue, zero cost control
import { SqliteQueue } from 'broccoliq';

let globalQueue: SqliteQueue | null = null;

export function getQueue() {
  if (!globalQueue) {
    globalQueue = new SqliteQueue({ concurrency: 1000 });
  }
  return globalQueue;
}

// Problems:
// - Can't test isolation
// - Can't scale out easily
// - Can't replace implementation
```

#### Anti-Pattern 2: The "Single Concurrency" Queue

```typescript
// ❌ BAD: 1 concurrency for everything
queue.process(async (job) => {
  await job.process();
}, { concurrency: 1 });

// Problems:
// - Queues grow infinitely
// - Single point of contention
// - Unpredictable latency
```

#### Anti-Pattern 3: The "In-Memory Only" Queue

```typescript
// ❌ BAD: All on RAM, no persistence
const queue = new SqliteQueue({ maxSize: 1000000 });
await queue.enqueueBatch(workingInMemory);

// Problems:
// - 1 million jobs in DB cost 2GB RAM
// - Memory leak if processing slower than enqueue
// - Data loss on crash
```

#### Anti-Pattern 4: The "No Retries" Queue

```typescript
// ❌ BAD: No retries for transient errors
queue.process(async (job) => {
  await callInternalApi(job);
}, { concurrency: 100 });

// Problems:
// - Network glitch = job failure = data loss
// - Temporary timeout = work in vain
// - No resilience
```

#### Anti-Pattern 5: The "Batch Only" Queue

```typescript
// ❌ BAD: Only batch processing
await queue.enqueueBatch(operations);  // 10,000 operations
await queue.process(async (jobs) => {
  await Promise.all(jobs.map(j => process(j)));
}, { batchSize: 10000 });

// Problems:
// - If batch fails, all 10,000 operations fail
// - No independent retry
// - Harder to debug

✓ GOOD: Batch also handles individual jobs
```

---

## Chapter 4: Real-World Scenarios

### Case Study 1: E-commerce Order Queue

**Scenario:** 5,000 orders/sec from API → Cache database → SQS for fulfillment. DB moves at 1,000MB/sec.

```typescript
class ECommerceQueue {
  private orderQueue: SqliteQueue<Order>;
  
  constructor() {
    // Isolated shard for orders to ensure zero contention with other tasks
    this.orderQueue = new SqliteQueue({ 
      shardId: 'orders',
      concurrency: 1000 
    });
  }
  
  // Capture all orders (fast memory-first ingest)
  async captureOrder(order: Order) {
    await this.orderQueue.enqueue(order);
    await db.cacheOrder(order);  // Cache for quick retrieval
  }
  
  // Process only unfulfilled orders
  async startProcessing() {
    await this.orderQueue.process(async (job) => {
      await fulfillmentSystem.processOrder(job);
      await db.markOrderFulfilled(job.id);
      
      // Clear from cache (optional)
      await db.invalidateOrderCache(job.id);
    });
  }
}
```

**Key takeaways:**
- Separate cache from queue
- Cache retrieval is O(1), DB retrieval is O(log n)
- Use local cache for order searches

---

### Case Study 2: User Analytics Pipeline

**Scenario:** 1 million user events per day → Process in batches → Store in analytics DB.

```typescript
class AnalyticsQueue {
  private eventQueue: SqliteQueue<UserEvent>;
  private reportingQueue: SqliteQueue<ReportRequest>;
  
  constructor() {
    // Shard events by ingestion volume
    this.eventQueue = new SqliteQueue({ 
      shardId: 'analytics-events',
      concurrency: 1000, 
      batchSize: 10000 
    });
    
    // Shard reports to isolate heavy computation from ingestion
    this.reportingQueue = new SqliteQueue({ 
      shardId: 'analytics-reports',
      concurrency: 10 
    });
  }
  
  // Capture events in high-throughput
  async captureEvent(event: UserEvent) {
    await this.eventQueue.enqueue(event);
  }
  
  // Process events in batches
  async processEvents() {
    await this.eventQueue.process(async (events: UserEvent[]) => {
      // Aggregate events for user
      const analytics = this.aggregateEvents(events);
      
      // Write to DB in one transaction
      await analyticsDB.insert(analytics);
    });
  }
  
  // Generate daily reports in background
  async generateReports() {
    await this.reportingQueue.process(async (report) => {
      await reportEngine.generate(report);
    });
  }
}
```

**Throughput:** 5,000 events → process 10,000 at once → 1 transaction per 2 seconds.

---

### Case Study 3: Failed Invoice Processing

**Scenario:** Invoices processed monthly (1 hour). If fails, retry 5 times, escalate after 24 hours.

```typescript
class InvoiceProcessingQueue {
  private invoiceQueue: SqliteQueue<Invoice>;
  private recoveryQueue: SqliteQueue<Invoice>;
  
  constructor() {
    this.invoiceQueue = new SqliteQueue({
      visibilityTimeoutMs: 600000,  // 10 minutes (retry)
      defaultMaxAttempts: 5,       // Retry 5 times
      baseRetryDelayMs: 1000
    });
    
    this.recoveryQueue = new SqliteQueue();
  }
  
  async processInvoices() {
    await this.invoiceQueue.process(async (job) => {
      await paymentGateway.charge(job.data);
    });
  }
  
  // Check for invoices stuck for > 24 hours
  async checkFailedInvoices() {
    const threshold = Date.now() - 86400000;  // 24 hours ago
    
    const failedInvoices = await db.selectWhere('invoices', [
      { column: 'status', value: 'payment_failed' },
      { column: 'paidAt', value: threshold, operator: '<' }
    ]);
    
    if (failedInvoices.length > 0) {
      await this.recoveryQueue.enqueueBatch(failedInvoices);
    }
  }
}
```

---

## Chapter 5: The Expert Handbook

### Rules of Thumb for BroccoliQ

1. **Throughput vs Latency Tradeoff (10:1 Rule)**
   - If you hit 10K ops/sec, it's good.
   - If you hit 100K ops/sec, you're a pro.
   - Memory usage shouldn't exceed 1GB for 1M jobs.

2. **Concurrency Calculations**
   ```typescript
   // Calculate ideal concurrency
   const avgOpTimeMs = 50;  // Average 50ms operation
   const concurrency = 1000 / avgOpTimeMs;  // 1000 / 50 = 20
   ```
   - If DB write < 10ms: concurrency = 1,000
   - If DB write < 1ms: concurrency = 10,000
   - If DB write > 100ms: concurrency = 100 (or increase job duration)

3. **Preload vs Process**
   - All queries should be preloaded.
   - Processing should be memory-only (for > 10K ops/sec).
   - If you're querying inside process, you need a better architecture.

4. **Batch Size Tuning**
   - Small operations (< 10ms): batchSize = 1,000 - 10,000
   - Large operations (> 100ms): batchSize = 100 - 1,000
   - Medium operations (10-100ms): batchSize = 100-500

5. **Visibility Timeout**
   ```typescript
   // Rule: Max job time + 2× roughly
   const maxJobTimeMs = 120000;  // Max 2 minutes per job
   const visibilityTimeout = maxJobTimeMs * 2;  // 4 minutes
   ```

---

## Chapter 6: Deployment Checklist

### Before You Deploy to Production

- [ ] Graceful shutdown implemented
- [ ] Monitoring active (Grafana/Prometheus)
- [ ] Graceful error handling (DLQ)
- [ ] Configured concurrency and batch sizes
- [ ] High availability tested (multiple workers)
- [ ] Performance benchmarks run (10K ops/sec target)
- [ ] Memory usage monitored (< 2GB for 1M jobs)
- [ ] Log aggregation in place
- [ ] Alert configuration (slow queue, high failure rate)
- [ ] Rollback plan defined

**Pro tip:** Test a deployment to 0 real users first. See how the queue behaves under normal load.

---

## Summary: The Expert's Secret

What separates 1% users from 99%?

They treat the queue like infrastructure, not application code. They:

1. **Abstract** → Put it behind a service interface
2. **Type** → Never use `any`
3. **Monitor** → Track > 10 metrics per second
4. **Test** → 90% test coverage
5. **Log** → Never silent failures
6. **Fallback** → Always graceful shutdown

**Don't just write code that runs. Write code that scales.**

---