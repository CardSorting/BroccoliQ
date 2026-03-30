# 🧠 BroccoliDB Knowledgebase

Welcome to the internal documentation for BroccoliDB. This document provides a deep dive into the architecture, data models, and service patterns that power our high-performance infrastructure.

---

## 📑 Table of Contents
1. [Core Philosophy](#core-philosophy)
2. [The Knowledge Graph](#the-knowledge-graph)
   - [Nodes (Knowledge)](#nodes-knowledge)
   - [Edges (Relationships)](#edges-relationships)
3. [Database Schema Reference](#database-schema-reference)
   - [System Tables](#system-tables)
   - [Domain Tables](#domain-tables)
4. [Performance Internals](#performance-internals)
   - [BufferedDbPool: Batching & Coalescing](#buffereddbpool-batching--coalescing)
   - [SqliteQueue: Hybrid Memory/Disk Strategy](#sqlitequeue-hybrid-memorydisk-strategy)
5. [Service Integrations](#service-integrations)
   - [SpiderService: Structural Analysis](#spiderservice-structural-analysis)
   - [GraphService: Traversal & Consistency](#graphservice-traversal--consistency)
6. [Best Practices](#best-practices)

---

## 🏛️ Core Philosophy

BroccoliDB is built on the premise that **SQLite is fast enough for production**, provided it is treated with care. By using an asynchronous write-behind layer, we can absorb bursts of activity that would normally cause `SQLITE_BUSY` errors, while still providing a synchronous-like consistency model for readers.

Our three pillars:
1. **Asynchrony by Default**: All writes are buffered and flushed in bulk.
2. **Agent Isolation**: "Agent Shadows" allow for complex, isolated scratchpads.
3. **Graph-First**: Data is treated as a network of interconnected points of knowledge.

---

## 🕸️ The Knowledge Graph

At its heart, BroccoliDB is a knowledge graph. We use two primary tables to represent this: `knowledge` and `knowledge_edges`.

### Nodes (Knowledge)
A knowledge item (`KnowledgeBaseItem`) is the atomic unit of the graph. It contains:
- **`type`**: The category of information (e.g., `structural_snapshot`, `telemetry`, `decision`).
- **`content`**: The raw data or visualization (e.g., a Mermaid string).
- **`confidence`**: A scale from `0.0` to `1.0` representing the AI's certainty.
- **`hubScore`**: Automatically managed based on the number of inbound and outbound edges.
- **`metadata`**: Extensible JSON for service-specific structured data.

### Edges (Relationships)
Edges represent semantic or structural links between knowledge items.
- **`sourceId` & `targetId`**: The IDs of the connected nodes.
- **`type`**: The nature of the link (e.g., `references`, `derived_from`, `violates`).
- **`weight`**: The strength of the connection, used for traversal prioritizing.

---

## 📊 Database Schema Reference

### System Tables
| Table | Purpose | Key Columns |
| :--- | :--- | :--- |
| `settings` | Global configuration and feature flags. | `key`, `value` |
| `queue_jobs` | Background tasks awaiting processing. | `status`, `payload`, `runAt` |
| `audit_events` | Immutable log of user and agent actions. | `type`, `userId`, `data` |
| `telemetry` | Usage metrics for LLM calls and performance. | `totalTokens`, `cost`, `modelId` |

### Domain Tables
| Table | Purpose | Key Columns |
| :--- | :--- | :--- |
| `repositories` | Tracked source code repositories. | `repoPath`, `defaultBranch` |
| `branches` | Snapshots of repository states. | `repoPath`, `name`, `head` |
| `files` | Content-addressable storage (CAS) for file versions. | `id` (hash), `content` |
| `decisions` | Documented reasoning steps by AI agents. | `decision`, `rationale` |

---

## ⚙️ Performance Internals

### BufferedDbPool: Batching & Coalescing
The `BufferedDbPool` doesn't just queue operations; it optimizes them.
- **Coalescing**: If multiple updates are pushed for the same record, they are merged into a single final update.
- **Bulk Inserts**: Inserts are grouped by table and type, then executed as a single `INSERT INTO ... VALUES (...), (...);` statement.
- **O(1) Status Indexing**: We maintain `activeIndex` and `inFlightIndex` (Map<string, Set<WriteOp>>). This allows `selectWhere` to retrieve indexed items (like `status: pending`) in constant time, even when the buffer contains millions of ops.
- **Pipelined Correctness**: When performing an in-memory `selectWhere`, the engine applies all pending updates and filters out rows that no longer match the query criteria, ensuring atomic-like consistency for uncommitted data.

### SqliteQueue: Event Horizon Strategy
To achieve zero-latency enqueuing at scale:
1. **1M Slot Circular Buffer**: Jobs are added to a fixed-size array (`pendingMemoryBuffer`) using head/tail pointers. This eliminates $O(N)$ overhead from `shift()` or `splice()`.
2. **Background Persistence**: The buffer is flushed to the `queue_jobs` table asynchronously.
3. **Pipelined Dequeue**: While one batch of jobs is being processed, the queue is already pre-fetching the next batch using the `activeIndex`. This allows for a sustained throughput of **4.4M jobs/sec**.

---

## 🛠️ Service Integrations

### SpiderService: Structural Analysis
The `SpiderService` uses BroccoliDB to store "Structural Snapshots."
- **Serializing Graphs**: It converts a complex code-relationship graph into a serialized string for storage in the `knowledge` table.
- **Bootstrap Cache**: It uses the `knowledge` table to store a "warm" cache of the project structure, allowing for sub-second re-initialization on large codebases.

### GraphService: Traversal & Consistency
The `GraphService` provides high-level APIs for interacting with the knowledge graph.
- **BFS Traversal**: Provides breadth-first search through nodes based on edge types and weights.
- **Centrality Calculation**: Uses `inboundEdges` and `outboundEdges` to determine the "Hub Score" of a node, helping agents identify critical pieces of information.
- **Knowledge Merging**: Specifically handles the merging of two nodes while preserving edge relationships.

---

## 🏛️ Advanced Service Patterns (Expert Level)

For power users building sovereign AI agents, these advanced services provide the logic layer on top of BroccoliDB's raw storage.

### `ReasoningService`: The "Truth" Layer
The `ReasoningService` is responsible for epistemic evaluation and contradiction detection.
- **`verifySovereignty(nodeId)`**: Uses age decay, churn, and evidence discounting to calculate a node's probability of being "true" in the current repository state.
- **`detectContradictions(startIds, depth)`**: Performs a multi-hop BFS traversal looking for nodes connected by `contradicts` edges.
- **`getReasoningPedigree(nodeId)`**: Recovers the "lineage" of a fact, showing which supporting nodes were used to derive the current belief.
- **`selfHealGraph()`**: Runs a **HITS-like algorithm** (Hubs and Authorities) across the entire graph to prune weak or disconnected nodes.

### `AuditService`: Structural & Logical Governance
The `AuditService` ensures the database and codebase remain in a healthy state.
- **`checkConstitutionalViolation()`**: Audits code changes against a set of "Constitutional Rules" using the AI service.
- **`addLogicalConstraint(pattern, knowledgeId)`**: Adds a blocking or warning constraint that prevents agents from violating established project patterns.
- **`predictEffect(kbId)`**: Simulates the impact of adding a new piece of knowledge, detecting if it would cause contradictions in the graph before it is ever committed.

### `SpiderService`: Structural Entropy Analysis
The `SpiderService` manages the structural health of the repository.
- **`auditStructure()`**: Computes the **Structural Entropy** of the codebase, tracking depth, naming, and coupling.
- **`bootstrapGraph()`**: Uses a specialized high-speed cache (`structural_snapshot`) in the `knowledge` table to re-initialize the graph analyze across thousands of files in sub-second time.

---

## 📜 Best Practices (Expert Only)

---

*Last Updated: March 2026*
