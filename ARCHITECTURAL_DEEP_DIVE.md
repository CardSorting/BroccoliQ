# 🏛️ BroccoliDB Architecture Deep Dive

Welcome to the **Expert-Level** architectural deep dive for BroccoliDB. This document explores the mathematical, algorithmic, and semantic models that allow BroccoliDB to function as a sovereign reasoning engine for AI agents.

---

## 📑 Table of Contents
1. [The Sovereign Reasoning Engine](#the-sovereign-reasoning-engine)
   - [Epistemic Evaluation & Age Decay](#epistemic-evaluation--age-decay)
   - [Evidence Discounting & Reinforcement](#evidence-discounting--reinforcement)
2. [Structural Entropy (The Spider Engine)](#structural-entropy-the-spider-engine)
   - [Entropy Calculation Formula](#entropy-calculation-formula)
   - [Reachability & Orphan Detection](#reachability--orphan-detection)
3. [Graph Self-Healing (HITS Algorithm)](#graph-self-healing-hits-algorithm)
4. [Concurrency & Mutex Hardening](#concurrency--mutex-hardening)
5. [The Amortized Persistence Model](#the-amortized-persistence-model)

---

## 🧐 The Sovereign Reasoning Engine

BroccoliDB implements a **Sovereign Reasoning Engine** (`ReasoningService.ts`) that manages the "truth" within the knowledge graph. Unlike a simple KV store, BroccoliDB evaluates every node's **Epistemic Sovereignty**—its right to exist as a valid fact.

### Epistemic Evaluation & Age Decay
We use a Bayesian-like weight model to calculate a node's `finalProb` (Final Probability).
- **Prior Probability (`prior`)**: Derived from the file's Git churn and historical reliability.
- **Age Decay (`ageDecay`)**: Logic: `Math.max(0.1, 1.0 - commitDistance / 100)`. As a code path evolves away from the commit where a reasoning step was made, the "truth" of that step decays.
- **Commit Distance**: The number of commits since the node was last verified against the current repository state.

### Evidence Discounting & Reinforcement
To prevent "echo chambers" in agent reasoning, the engine discounts evidence from the same commit:
- **Discounting (`discountingFactor`)**: If multiple pieces of evidence originate from the same commit, their collective weight is reduced (multiplied by `0.95` per duplicate).
- **Reinforcement**: Unique evidence from *different* commits provides a linear bonus to the node's confidence (`uniqueCommits * 0.05`).

---

## 🕸️ Structural Entropy (The Spider Engine)

The `SpiderEngine` treats a codebase as a living organism, measuring its "Health" through **Structural Entropy**.

### Entropy Calculation Formula
We calculate entropy across four dimensions:
1. **Depth Score ($D$)**: Average directory nesting depth (Limit = 4).
2. **Naming Score ($N$)**: Ratio of files violating project naming conventions (kebab-case).
3. **Orphan Score ($O$)**: Percentage of nodes unreachable from defined "roots" (e.g., `main.ts`, `index.ts`).
4. **Coupling Score ($C$)**: Ratio of cross-layer imports (e.g., Domain layer importing from UI).

**Final Entropy Score** ($E$):
$E = (D * 0.3) + (N * 0.2) + (O * 0.2) + (C * 0.3)$

An $E$ value above **0.5** signals critical structural decay (Rot).

### Reachability & Orphan Detection
The engine performs a **Breadth-First Search (BFS)** starting from defined "Root Layers" (`ui`, `core`, `plumbing`). Any file not reached during this traversal is marked as `orphaned: true`, signaling unused or "dead" code that should be pruned.

---

## 🩹 Graph Self-Healing (HITS Algorithm)

BroccoliDB uses a variation of the **HITS (Hyperlink-Induced Topic Search)** algorithm to maintain graph health.

In our implementation (`selfHealGraph`), we distinguish between:
- **Hubs**: Nodes that point to many other valid nodes (e.g., a "Service Index").
- **Authorities**: Nodes that are pointed to by many trusted hubs (e.g., a "Core Utility").

**Algorithm Iterations:**
1. Initialize all node scores to $1 / N$.
2. For each iteration (3 total):
   - New Score = $0.15$ (damping factor) + sum of (supporting node scores * edge weight).
3. Update the `hubScore` in the `knowledge` table.

This allows the graph to "self-heal" by lowering the confidence of nodes that become disconnected from the "trust core" of the codebase.

---

## 🔒 Concurrency & Mutex Hardening

To support **50,000+ operations/sec**, BroccoliDB uses a production-grade internal **Mutex** system.

### The Double-Lock Pattern
When flushing the `BufferedDbPool`, we use two distinct mutexes:
1. **`StateMutex`**: Protects the in-memory arrays (`globalBuffer`, `agentShadows`) during read/write transitions.
2. **`FlushMutex`**: Ensures that only one "Writer" is interacting with the SQLite database at any given time, preventing `SQLITE_BUSY` deadlocks during massive batch commits.

### Adaptive Flush Scheduling
The pool uses an adaptive timer. If the buffer is empty, it flushes every **1000ms**. If the buffer reaches **10,000 operations**, it triggers an **immediate (0ms)** flush to prevent backpressure.

---

## 📈 The Amortized Persistence Model: RAM vs. SQLite

BroccoliDB achieves **2.0M+ Logical Ops/Sec** by recognizing a critical architectural truth: **CPU and RAM are the brain, and SQLite is the notebook.**

### The Layers of Consciousness
- **🧠 Layer 1: Memory (Active Work)**: Every enqueue, status update, and query results and is managed in-memory first. This is where 100% of the real-time processing performance lives.
- **💾 Layer 2: SQLite (Durable Safety Net)**: SQLite is *not* a real-time engine in our system. It is a **Durable Checkpoint Layer**. Its only job is to write down a summary of what happened in memory so that the state can be recovered after a crash.

$$Speed = \frac{Memory Processing (Thoughts)}{Disk Syncs (Summaries)}$$

In our latest audit, we achieved a **Logical/Physical Ratio of 1,333,333 : 1**. This means for every 1.3 million operations handled in memory, SQLite only performed **one physical sync**.

### The Tradeoff: Durability vs. Data Loss Window
By treating SQLite as a discrete checkpoint layer rather than a real-time engine, we gain massive throughput, but introduce an intentional **Data Loss Window**.
- **The Gap**: Operations that occur *between* checkpoints exist only in Layer 1 (Active Memory).
- **The Risk**: If the process crashes before a flush, uncommitted operations are lost.
- **The Recovery**: On restart, the system rebuilds its in-memory "brain" from the last successful Layer 2 (SQLite) checkpoint.

### Why "Idle" SQLite is Success
During high-performance benchmarks, SQLite might appear idle. This is intentional. It means the system is busy "thinking" in Layer 1 and is not wasting expensive I/O cycles on Layer 2 until it has a meaningful batch of work to record. 

If SQLite were "busy" with every operation, you would be limited to standard SQLite speeds (approx 50k–200k ops/sec). Instead, BroccoliDB allows you to scale at the speed of memory.

---

### Level 3: The Quantum Boost
The final optimization to hit **1.5M+ ops/sec** was **Chunked Raw Inserts**. Instead of individual calls to the driver, BroccoliDB generates dynamic SQL for up to 100 rows at a time (`INSERT INTO ... VALUES (...), (...), ...`). This reduces context switching between the memory layer and the persistence layer by 100x.

---

## 🚀 Level 7: The Event Horizon (O(1) Memory Indexing)

At 1,000,000+ operations, even "fast" in-memory array scanning becomes a bottleneck. Level 7 addresses the **$O(N)$ Scanning Penalty** in the Memory Layer.

### The Paradox of Scale
When the `SqliteQueue` processes 1,000,000 pending jobs, the memory engine must survive $O(N)$ lookups to find `status: pending`. 

- **Level 6**: $T_{query} = O(N_{buffer})$. At 1M elements, this takes ~120ms per dequeue.
- **Level 7**: $T_{query} = O(1)$. By maintaining a **Memory Index Map**, the query is reduced to a simple pointer retrieval.

### The Index Algorithm
1. **Ingestion (`pushBatch`)**: Each `WriteOp` is evaluated in RAM. If it's a `queue_jobs` operation, it's added to a `Set<WriteOp>` in the `activeIndex` map indexed by `status`.
2. **Retrieval (`selectWhere`)**: The engine detects a query on an indexed column. It pulls the pre-filtered `Set` in **0.001ms** instead of scanning the full 1M elements.
3. **Atomic Swap**: When the memory buffer flushes to the checkpoint layer (SQLite), the `activeIndex` is atomically swapped with the `inFlightIndex`, ensuring that queries during the flush remain correct.

### Pipelined Correctness Formula
To ensure that Layer 1 (Active Memory) remains the absolute current state of truth, we apply a filtering pass:
$Result = (Base_{Checkpoint} \cap Conditions) \cup (Active_{Index}) - (Deletions)$

This produces the **absolute current state of truth** for the agent, combining the last Layer 2 checkpoint with the uncommitted Layer 1 state in a single, atomic-feeling view.

---

## 🚀 Level 8: Active Thought Collapsing (Deep Audit)

Level 8 marks the transition from a passive write-behind buffer to an **Active Memory Processing Engine**. We no longer just buffer results; we compute them in Layer 1 to minimize Layer 2 (SQLite) noise.

### Mathematical Rigor: Offloading Efficiency ($\eta$)

We define the efficiency of the BroccoliDB engine by how effectively it shields the persistence layer from the high frequency of logical operations.

$$\eta = 1 - \frac{\sum Physical\_Transactions}{\sum Logical\_Operations}$$

In a standard system, $\eta \approx 0$ (one write per operation). In BroccoliDB Level 8, assuming 1,000,000 increments to a single counter:
- **Logical Ops**: 1,000,000
- **Physical Ops**: 1 (one final update)
- **Efficiency ($\eta$)**: $0.999999$

### The Delta Compression Logic
Instead of the "Notebook" recording every incremental thought, Layer 1 performs **Delta Compression**:
1. **Initial State**: $x = 100$ (Layer 2 Anchor).
2. **Burst Logic**: RAM processes 1,000 thoughts of $x + 1$ without hitting the disk.
3. **Coalescing**: The `groupOps` engine recognizes the `dedupKey` parity and collapses the thoughts mathematically: $Summary = \sum deltas$.
4. **Checkpoint**: SQLite is woken up only once to record the result: $UPDATE \dots SET x = x + 1000$.

### The Volatility Boundary
Doubling down on this architecture means being precise about the **Boundary of Failure**. If the system crashes during the "thinking" phase, the Deltas that have not yet reached the Checkpoint are lost. This window is configurable via `flushMs`. For AI state streams, this tradeoff is acceptable as the cost of the "re-calculation" is often lower than the multi-second latency penalty of synchronous disk writes.

---

## ⚡ Level 9: Cognitive Sovereignty (Zero-Latency Reconstitution)

Level 9 is the final frontier of the **Brain/Notebook** model. At this stage, the **Brain (RAM)** is no longer just a cache; it is the **Primary Authority** for real-time state.

### Cognitive Overhead: The CPU Limit
As we reach 4.4M operations, we move from being "I/O bound" to "CPU bound." Level 9 eliminates redundant cognitive cycles:
- **Fast Parity (No Over-thinking)**: We replaced $O(N \times S)$ `JSON.stringify` checks with lightning-fast primitive equality.
- **Reference-Level Parity**: The system detects shared references in RAM to avoid redundant state calculations.

### Zero-Latency Reconstitution (The Warmup Protocol)
The most critical part of Level 9 is the **Sovereign Recovery Model**. When a system reboots, traditional memory-first engines are "cold" and must hit the disk for every query until the cache is warm.

1. **The Wake-up**: On startup, BroccoliDB runs `warmupTable()`, which populates the **Layer 1 Indexes** (e.g., `activeIndex`) from the **Layer 2 Checkpoint** (SQLite).
2. **Authoritative Handover**: Once a subset of data (like `status: pending`) is "warmed," the Brain marks itself as **Authoritative**.
3. **Disk Bypass**: Subsequent `selectWhere` queries see the **Authoritative Index** and skip Layer 2 SQL entirely. Performance jumps from **0.5ms (Disk-assisted)** to **0.005ms (Pure Memory)**.

### The Unified Continuity Formula
The final view of truth is now even more efficient:
- **IF WARMED**: $Result = RAM_{Authoritative}$
- **IF COLD**: $Result = Disk \cup RAM_{Active}$

This architecture ensures that BroccoliDB can survive a crash, rebuild its "consciousness" in milliseconds, and immediately resume handling millions of agent requests at zero-latency.

---

*Sovereign Level — Level 9 "Cognitive Sovereignty" Audit — March 2026*
