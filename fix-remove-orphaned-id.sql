-- Remove orphaned 'id' column from composite PK tables
-- Drop and recreate tables without the orphaned id column

-- Backup and drop branches table
DROP TABLE IF EXISTS branches;

-- Recreate branches table properly
CREATE TABLE branches (
  repoPath TEXT NOT NULL,
  name TEXT NOT NULL,
  head TEXT NOT NULL,
  isEphemeral INTEGER DEFAULT 0,
  createdAt BIGINT,
  expiresAt BIGINT,
  PRIMARY KEY(repoPath, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_repo ON branches(repoPath);

-- Backup and drop tags table
DROP TABLE IF EXISTS tags;

-- Recreate tags table properly  
CREATE TABLE tags (
  repoPath TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt BIGINT,
  PRIMARY KEY(repoPath, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_repo ON tags(repoPath);

-- Verify the fix
PRAGMA table_info(branches);
PRAGMA table_info(tags);