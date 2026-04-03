import { sql } from "kysely";
import { logger } from "../util/Logger.js";
import { dbPool } from "./pool/index.js";
import { getActiveShards, getDb } from "./Config.js";

interface PragmaResult {
	integrity_check?: string;
	page_count?: number;
	freelist_count?: number;
}

/**
 * IntegrityWorker provides autonomous data validation and self-healing for the Sovereign Swarm.
 * It periodically audits all database shards for corruption and logical inconsistencies.
 */
export class IntegrityWorker {
	private interval: NodeJS.Timeout | null = null;
	private isProcessing = false;

	constructor(private checkIntervalMs = 600000) {} // Default 10 minutes

	start() {
		if (this.interval) return;
		this.interval = setInterval(() => this.runAudit(), this.checkIntervalMs);
		// Initial run
		setTimeout(() => this.runAudit(), 5000);
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	async runAudit() {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			logger.info("Starting swarm-wide integrity audit...");

			const shards = getActiveShards();

			for (const shardId of shards) {
				await this.auditShard(shardId);
			}

			logger.info("Audit complete.");
		} catch (e) {
			logger.error("Audit failed", e);
		} finally {
			this.isProcessing = false;
		}
	}

	private async auditShard(shardId: string) {
		const db = await getDb(shardId);

		// 1. Physical Integrity
		const integrityResult = await sql`PRAGMA integrity_check;`.execute(db);
		const row = integrityResult.rows[0] as PragmaResult | undefined;
		const status = row?.integrity_check;

		if (status !== "ok") {
			logger.error(`CRITICAL: Shard ${shardId} corruption detected`, {
				status,
			});
			// Recovery: Attempt to fix via PRAGMA fix_db or similar if supported,
			// but usually requires manual intervention or failover.
		}

		// 2. Logical Consistency: Dangling Nodes & Partial Deletes
		const danglingNodes = await dbPool.selectWhere("nodes", [], undefined, {
			shardId,
			limit: 1000,
		});
		const nodeIds = new Set(danglingNodes.map((n) => n.id));
		const orphans = danglingNodes.filter(
			(n) => n.parentId && !nodeIds.has(n.parentId),
		);

		if (orphans.length > 0) {
			logger.warn(
				`Shard ${shardId}: Found ${orphans.length} orphaned nodes. Repairing...`,
			);
			for (const orphan of orphans) {
				await dbPool.push({
					type: "update",
					table: "nodes",
					values: {
						parentId: null,
						message: `[AUTO-REPAIRED] ${orphan.message}`,
					},
					where: { column: "id", value: orphan.id },
					shardId,
				});
			}
			await dbPool.flush();
		}

		// 3. Telemetry Pruning (Self-Healing Storage)
		const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		await dbPool.push({
			type: "delete",
			table: "telemetry",
			where: { column: "timestamp", value: weekAgo, operator: "<" },
			shardId,
		});

		// 4. Maintenance: Fragmentation Check & Index Rebuild
		const pageCount = await sql`PRAGMA page_count;`.execute(db);
		const freelistCount = await sql`PRAGMA freelist_count;`.execute(db);

		const pCountRow = pageCount.rows[0] as PragmaResult | undefined;
		const fCountRow = freelistCount.rows[0] as PragmaResult | undefined;

		const pCount = Number(pCountRow?.page_count || 0);
		const fCount = Number(fCountRow?.freelist_count || 0);

		if (pCount > 1000 && fCount / pCount > 0.3) {
			logger.info(
				`Shard ${shardId}: Fragmentation high (${((fCount / pCount) * 100).toFixed(1)}%). Rebuilding indices...`,
			);
			await sql`REINDEX;`.execute(db);
			await sql`VACUUM;`.execute(db);
		}
	}
}

export const integrityWorker = new IntegrityWorker();
