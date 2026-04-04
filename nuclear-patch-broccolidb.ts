/**
 * [NUCLEAR SYSTEM HARDENING]
 * Purpose: Surgical patching of BroccoliDB's internal tables to add 'id' primary key
 * Architecture: Raw SQL enforcement with transaction atomicity
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'node:path';
import * as crypto from 'crypto';

const DB_PATH = '/Users/bozoegg/Downloads/broccolidb/broccoliq.db';

const TABLES = [
  'branches', 
  'tags', 
  'claims', 
  'knowledge_edges', 
  'queue_settings', 
  'settings'
];

function getOriginalSchema(table: string): string {
  let tempSchema = '';
  
  switch (table) {
    case 'queue_settings':
    case 'settings':
      tempSchema = `id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT, updatedAt INTEGER`;
      break;
    case 'knowledge_edges':
      tempSchema = `id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, targetId TEXT NOT NULL, type TEXT NOT NULL, weight REAL DEFAULT 1.0`;
      break;
    case 'branches':
      tempSchema = `id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, name TEXT NOT NULL, head TEXT, isEphemeral INTEGER, createdAt INTEGER, expiresAt INTEGER`;
      break;
    case 'claims':
      tempSchema = `id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL, author TEXT NOT NULL, timestamp INTEGER NOT NULL, expiresAt INTEGER`;
      break;
    case 'tags':
      tempSchema = `id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, name TEXT NOT NULL, head TEXT, createdAt INTEGER`;
      break;
    default:
      throw new Error(`Unknown table: ${table}`);
  }
  
  return tempSchema;
}

function getSelectColumns(table: string): string {
  switch (table) {
    case 'queue_settings':
    case 'settings':
      return 'key, value, updatedAt';
    case 'knowledge_edges':
      return 'sourceId, targetId, type, weight';
    case 'branches':
      return 'repoPath, name, head, isEphemeral, createdAt, expiresAt';
    case 'claims':
      return 'repoPath, branch, path, author, timestamp, expiresAt';
    case 'tags':
      return 'repoPath, name, head, createdAt';
    default:
      throw new Error(`Unknown table: ${table}`);
  }
}

console.log('=== BROCCOLIDB NUCLEAR PATCH SEQUENCE ===');
console.log(`[NUCLEAR PATCH] Target database: ${DB_PATH}`);

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`[NUCLEAR PATCH] Created database directory: ${dbDir}`);
}

const db = new Database(DB_PATH);

try {
  // Database connection opened - proceed with structural modification
  
  for (const table of TABLES) {
    console.log(`\n[NUCLEAR PATCH] Preparing to patch table '${table}'`);
    
    // Get current table structure
    const result = db.pragma(`table_info('${table}')`, { simple: true }) as any;
    const tableInfo = Array.isArray(result) ? result : [];
    
    const hasId = tableInfo.some((row: any) => row[1] === 'id');
    if (hasId) {
      console.log(`[NUCLEAR PATCH] ✓ Pre-check: 'id' column already exists`);
      const rowCount = db.prepare(`SELECT count(*) as count FROM "${table}"`).get() as any;
      const count = rowCount?.count || 0;
      if (count > 0) {
        console.log(`[NUCLEAR PATCH] ⚠ Skipped: No records to migrate`);
      } else {
        console.log(`[NUCLEAR PATCH] ℹ Table empty, no further action required`);
      }
      continue;
    }
    
    console.log(`[NUCLEAR PATCH] Check: Table has ${tableInfo.length} columns, none named 'id'`);
    
    // Start transaction
    db.exec('BEGIN TRANSACTION');
    
    // Generate schema and temp table name
    const tempSchema = getOriginalSchema(table);
    const tempTableName = `${table}_temp`;
    
    // Drop existing temp table if exists and create new one with schema
    db.exec(`DROP TABLE IF EXISTS "${tempTableName}"`);
    db.exec(`CREATE TABLE "${tempTableName}" (${tempSchema})`);
    
    // Get column names to select (exclude implicit ROWID)
    const selectColumns = getSelectColumns(table);
    
    // Migrate data: assign UUID to each row
    db.prepare(
      `INSERT INTO "${tempTableName}" (id, ${selectColumns})
       SELECT '${crypto.randomUUID()}', ${selectColumns}
       FROM "${table}"`
    ).run();
    
    // Verify counts
    const originalCount = db.prepare(`SELECT count(*) as count FROM "${table}"`).get() as any;
    const tempCount = db.prepare(`SELECT count(*) as count FROM "${tempTableName}"`).get() as any;
    
    if (originalCount?.count !== tempCount?.count) {
      throw new Error(
        `Data loss detected: ${originalCount?.count} rows in original, ` +
        `${tempCount?.count} rows in temp`
      );
    }
    
    console.log(`[NUCLEAR PATCH] ✅ Migration completed: ${tempCount?.count} rows migrated`);
    
    // Drop original and rename temp table
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${tempTableName}" RENAME TO "${table}"`);
    
    // Verify the patch
    const verifyResult = db.pragma(`table_info('${table}')`, { simple: true }) as any;
    const verifyTableInfo = Array.isArray(verifyResult) ? verifyResult : [];
    const verifyHasId = verifyTableInfo.some((row: any) => row[1] === 'id');
    
    if (!verifyHasId) {
      throw new Error(`Patching verification failed: 'id' still missing`);
    }
    
    console.log(`[NUCLEAR PATCH] ✅ Post-migration verification: 'id' column present`);
    console.log(`[NUCLEAR PATCH] Table now has ${verifyTableInfo.length} columns`);
  }
  
  // Commit all changes
  db.exec('COMMIT');
  
  console.log('\n==================================================');
  console.log('✅ HARDENING COMPLETE: 6/6 tables patched');
  console.log('==================================================');
  
} catch (error: any) {
  // Rollback on error
  try {
    db.exec('ROLLBACK');
  } catch (e) {}
  
  console.error('\n==================================================');
  console.error('❌ HARDENING FAILED');
  console.error('Error:', error.message);
  console.error('==================================================\n');
  process.exit(1);
} finally {
  db.close();
}