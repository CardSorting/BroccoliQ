-- Reformat branches table (remove orphaned id, fix primary key)
ALTER TABLE branches RENAME TO branches_reform;

CREATE TABLE branches (
  repoPath TEXT NOT NULL,
  name TEXT NOT NULL,
  head TEXT NOT NULL,
  isEphemeral INTEGER DEFAULT 0,
  createdAt BIGINT,
  expiresAt BIGINT,
  PRIMARY KEY(repoPath, name)
);

INSERT INTO branches SELECT repoPath, name, head, isEphemeral, createdAt, expiresAt FROM branches_reform;

DROP TABLE branches_reform;