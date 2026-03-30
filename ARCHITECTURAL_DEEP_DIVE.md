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

*Expert Guide Produced by MarieCoder — March 2026*
