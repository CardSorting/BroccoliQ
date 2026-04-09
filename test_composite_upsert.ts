import * as fs from 'node:fs';
import * as path from 'node:path';
import { setDbPath, getDb } from './infrastructure/db/Config.js';
import { dbPool } from './infrastructure/db/pool/index.js';

async function testCompositeUpsert() {
    console.log('--- TESTING COMPOSITE PK UPSERT (Hardened Operations) ---');
    const dbPath = path.resolve(process.cwd(), 'composite_test.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    setDbPath(dbPath);
    
    // 1. Initialize DB
    await getDb('main');
    
    try {
        const repoPath = '/Users/bozoegg/test-repo';
        const name = 'main-branch';
        
        // 2. First Upsert (Insert)
        console.log('Step 1: Inserting branch...');
        await dbPool.push({
            type: 'upsert',
            table: 'branches',
            values: {
                repoPath,
                name,
                head: 'sha123',
                isEphemeral: 0,
                createdAt: Date.now()
            }
        });
        
        // Wait for buffer flush
        await new Promise(r => setTimeout(r, 1500));
        
        let branch = await dbPool.selectOne('branches', [
            { column: 'repoPath', value: repoPath },
            { column: 'name', value: name }
        ]);
        
        console.log('Initial branch data:', branch);
        if (!branch || branch.head !== 'sha123') throw new Error('First insert failed or branch is null');

        // 3. Second Upsert (Update)
        console.log('\nStep 2: Updating existing branch (Upsert)...');
        await dbPool.push({
            type: 'upsert',
            table: 'branches',
            values: {
                repoPath,
                name,
                head: 'sha456-updated'
            }
        });
        
        await new Promise(r => setTimeout(r, 1500));
        
        branch = await dbPool.selectOne('branches', [
            { column: 'repoPath', value: repoPath },
            { column: 'name', value: name }
        ]);
        
        console.log('Updated branch data:', branch);
        
        if (branch && branch.head === 'sha456-updated') {
            console.log('\n✅ PASS: Composite PK Upsert correctly updated the record!');
        } else {
            console.error('\n❌ FAIL: Composite PK Upsert did not update the record correctly (or branch is null).');
            process.exit(1);
        }

    } catch (e) {
        console.error('\n💥 TEST CRASHED:', e);
        process.exit(1);
    } finally {
        await dbPool.stop();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
}

testCompositeUpsert();
