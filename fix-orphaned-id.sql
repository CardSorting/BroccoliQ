-- Remove orphaned 'id' column from composite PK tables
-- This column should NOT exist since we're using composite primary keys

-- Fix branches table
PRAGMA writable_schema = 1;
UPDATE sqlite_master 
SET sql = REPLACE(
    sql, 
    'expiresAt BIGINT, id TEXT, PRIMARY KEY(repoPath, name))',
    'expiresAt BIGINT, PRIMARY KEY(repoPath, name))'
)
WHERE type = 'table' AND name = 'branches';
PRAGMA writable_schema = 0;

-- Fix tags table
UPDATE sqlite_master 
SET sql = REPLACE(
    sql, 
    'createdAt BIGINT, id TEXT, PRIMARY KEY(repoPath, name))',
    'createdAt BIGINT, PRIMARY KEY(repoPath, name))'
)
WHERE type = 'table' AND name = 'tags';

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_branches_repo ON branches(repoPath);
CREATE INDEX IF NOT EXISTS idx_tags_repo ON tags(repoPath);

-- Verify the fix
PRAGMA table_info(branches);