import { sql } from "kysely";
import { logger } from "../../util/Logger.js";
import type { IBufferedDbPool } from "./types.js";

/**
 * Level 8: Distributed Lock Manager.
 * Uses the 'claims' table for cross-process mutual exclusion.
 */
export class Locker {
	private activeLocks = new Map<string, { expiresAt: number; interval: NodeJS.Timeout }>();

	constructor(private pool: IBufferedDbPool) {}

	public async acquireLock(
		resource: string,
		author: string,
		shardId: string = "main",
		ttlMs: number = 30000,
	): Promise<boolean> {
		const db = await this.pool.getDb(shardId);
		const now = Date.now();
		const expiresAt = now + ttlMs;

		try {
			// 1. Clean up expired locks first
			await sql`DELETE FROM claims WHERE expiresAt < ${now}`.execute(db);

			// 2. Atomic claim attempt
			await this.pool.push({
				type: "insert",
				table: "claims",
				values: {
					path: resource,
					author,
					timestamp: now,
					expiresAt,
					repoPath: "global",
					branch: "main",
				},
				shardId,
			});

			await this.pool.flush();

			// 3. Verify ownership
			const claim = await this.pool.selectOne(
				"claims",
				[
					{ column: "path", value: resource },
					{ column: "author", value: author },
				],
				undefined,
				{ shardId },
			);

			if (claim) {
				const interval = setInterval(() => this.heartbeatLock(resource, author, shardId, ttlMs), ttlMs / 2);
				this.activeLocks.set(`${shardId}:${resource}`, { interval, expiresAt });
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	private async heartbeatLock(resource: string, author: string, shardId: string, ttlMs: number) {
		const lock = this.activeLocks.get(`${shardId}:${resource}`);
		if (!lock) return;

		const now = Date.now();
		const nextExpires = now + ttlMs;

		try {
			await this.pool.push({
				type: "update",
				table: "claims",
				values: { expiresAt: nextExpires, timestamp: now },
				where: [
					{ column: "path", value: resource },
					{ column: "author", value: author },
				],
				shardId,
			});
			lock.expiresAt = nextExpires;
		} catch (e) {
			logger.error(`[Locker] Heartbeat failed for ${resource}`, e);
		}
	}

	public async releaseLock(resource: string, author: string, shardId: string = "main") {
		const lock = this.activeLocks.get(`${shardId}:${resource}`);
		if (lock) {
			clearInterval(lock.interval);
			this.activeLocks.delete(`${shardId}:${resource}`);
		}

		await this.pool.push({
			type: "delete",
			table: "claims",
			where: [
				{ column: "path", value: resource },
				{ column: "author", value: author },
			],
			shardId,
		});
		await this.pool.flush();
	}

	public destroy() {
		for (const lock of this.activeLocks.values()) {
			clearInterval(lock.interval);
		}
		this.activeLocks.clear();
	}
}
