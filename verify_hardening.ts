import * as fs from 'node:fs';
import * as path from 'node:path';
import { setDbPath, getDb, getRawDb } from './infrastructure/db/Config.js';
import { dbPool } from './infrastructure/db/pool/index.js';
import { IntegrityWorker } from './infrastructure/db/IntegrityWorker.ts';
import { SqliteQueue } from './infrastructure/queue/SqliteQueue.ts';

async function verifyHardening() {
    console.log('--- STARTING SOVEREIGN HARDENING VERIFICATION ---');
    const dbPath = path.resolve(process.cwd(), 'hardening_verify.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    setDbPath(dbPath);
    
    await getDb('main');
    
    try {
        // 1. Verify Schema Unification (Composite PKs)
        console.log('\n[1] Verifying Composite PK Schema...');
        const rawDb = await getRawDb('main') as { prepare: (s: string) => { get: () => { sql: string }, run: (...args: unknown[]) => void } };
        const branchesSchema = rawDb.prepare("SELECT sql FROM sqlite_master WHERE name='branches'").get().sql;
        console.log('Branches Schema:', branchesSchema);
        if (!branchesSchema.includes('PRIMARY KEY("repoPath","name")') && !branchesSchema.includes('PRIMARY KEY(repoPath, name)')) {
            throw new Error('Branches table does not use composite Primary Key');
        }
        console.log('✅ Composite PK verified.');

        // 2. Verify Scalable Integrity (Orphans Repair)
        console.log('\n[2] Verifying Scalable Integrity Audit...');
        // Insert some orphaned nodes
        for (let i = 0; i < 50; i++) {
            await dbPool.push({
                type: 'insert',
                table: 'nodes',
                values: {
                    id: `node_${i}`,
                    repoPath: 'test',
                    parentId: 'non_existent_parent',
                    message: `Test node ${i}`
                }
            });
        }
        await dbPool.flush();
        
        const worker = new IntegrityWorker(0);
        await worker.runAudit();
        
        const repairedNode = await dbPool.selectOne('nodes', { column: 'id', value: 'node_0' });
        console.log('Repaired Node sample:', repairedNode);
        if (!repairedNode || repairedNode.parentId !== null || !repairedNode.message.includes('[AUTO-REPAIRED]')) {
            throw new Error('Orphan repair failed');
        }
        console.log('✅ Scalable Integrity verified.');

        // 3. Verify Queue Resiliency (Corrupt Payload)
        console.log('\n[3] Verifying Queue Resiliency...');
        // Insert corrupt JSON via raw execute to bypass safety if any
        rawDb.prepare("INSERT INTO queue_jobs (id, payload, status, priority, attempts, maxAttempts, runAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)").run(
            'bad_job',
            '{corrupt_json',
            'pending',
            0, 0, 5, Date.now(), Date.now(), Date.now()
        );
        
        const queue = new SqliteQueue<unknown>({ shardId: 'main' });
        const jobs = await queue.dequeueBatch(10);
        console.log('Dequeued jobs count:', jobs.length);
        const badJob = jobs.find(j => j.id === 'bad_job');
        if (!badJob) throw new Error('Bad job not dequeued');
        console.log('Bad job payload type:', typeof badJob.payload);
        if (typeof badJob.payload !== 'string') throw new Error('Corrupt payload should have remained a string');
        console.log('✅ Queue Resiliency verified.');

        console.log('\n🏆 ALL SOVEREIGN HARDENING CHECKS PASSED!');

    } catch (e) {
        console.error('\n❌ VERIFICATION FAILED:', e);
        process.exit(1);
    } finally {
        await dbPool.stop();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
}

verifyHardening();
