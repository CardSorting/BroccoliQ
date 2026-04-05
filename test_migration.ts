import { getDb, setDbPath } from "./infrastructure/db/Config.js";
import { dbPool } from "./infrastructure/db/pool/index.js";
import { CompiledQuery } from "kysely";
import * as fs from "node:fs";
import * as path from "node:path";

async function runTest() {
    const testDbPath = path.resolve(process.cwd(), "test_migration.db");
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    
    setDbPath(testDbPath);
    
    const isBun = !!(globalThis as { Bun?: unknown }).Bun;

    // 1. Manually create a legacy table without 'id'
    if (isBun) {
        // @ts-ignore
        const { Database } = await import("bun:sqlite");
        const rawDb = new Database(testDbPath);
        rawDb.run("CREATE TABLE settings (key TEXT NOT NULL UNIQUE, value TEXT, updatedAt BIGINT)");
        rawDb.close();
    } else {
        const Database = (await import("better-sqlite3")).default;
        const rawDb = new Database(testDbPath);
        rawDb.exec("CREATE TABLE settings (key TEXT NOT NULL UNIQUE, value TEXT, updatedAt BIGINT)");
        rawDb.close();
    }
    
    console.log("Created legacy 'settings' table without 'id' column.");
    
    // 2. Initialize schema via BroccoliQ
    const db = await getDb("main");
    
    // 3. Verify 'id' column exists now
    const info = await db.executeQuery(CompiledQuery.raw("PRAGMA table_info(settings)"));
    const hasId = info.rows.some((row: any) => row.name === "id");
    
    if (hasId) {
        console.log("✅ Success: 'id' column was automatically added to 'settings' table.");
    } else {
        console.error("❌ Failure: 'id' column is still missing.");
        process.exit(1);
    }
    
    // 4. Verify upsert works with 'key' as conflict target (automatic hardening)
    // Using dbPool which uses Operations.ts
    try {
        await dbPool.push({
            type: "upsert",
            table: "settings",
            values: {
                id: "1",
                key: "test_key",
                value: "value1",
                updatedAt: Date.now()
            },
            layer: "infrastructure"
        });
        
        await dbPool.flush(); // Force write to disk
        
        // This should trigger the hardened conflictTarget logic in Operations.ts
        await dbPool.push({
            type: "upsert",
            table: "settings",
            values: {
                id: "2",
                key: "test_key",
                value: "value2",
                updatedAt: Date.now()
            },
            layer: "infrastructure"
        });
        
        await dbPool.flush(); // Force write to disk
        
        const result = await dbPool.selectOne("settings", { column: "key", value: "test_key" });
        if (result && result.value === "value2") {
            console.log("✅ Success: Upsert works on table with injected 'id' using hardened defaults.");
        } else {
            console.error("❌ Failure: Upsert did not update correctly or row missing.");
            process.exit(1);
        }
    } catch (e) {
        console.error("❌ Failure: Upsert failed:", e);
        process.exit(1);
    }
    
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    process.exit(0);
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
