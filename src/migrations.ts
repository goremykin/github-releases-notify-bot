export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: `
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE,
        type       TEXT NOT NULL,
        username   TEXT,
        date       TEXT NOT NULL,
        is_bot     INTEGER,
        first_name TEXT,
        last_name  TEXT,
        title      TEXT
      );

      CREATE TABLE repos (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name  TEXT NOT NULL,
        UNIQUE(owner, name)
      );

      CREATE TABLE subscriptions (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, repo_id)
      );

      CREATE TABLE releases (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        is_prerelease INTEGER NOT NULL DEFAULT 0,
        url           TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE TABLE tags (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        is_prerelease INTEGER NOT NULL DEFAULT 0,
        url           TEXT,
        UNIQUE(repo_id, name)
      );

      CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
      CREATE INDEX idx_subscriptions_repo ON subscriptions(repo_id);
      CREATE INDEX idx_releases_repo ON releases(repo_id);
      CREATE INDEX idx_tags_repo ON tags(repo_id);
    `,
  },
  {
    version: 2,
    description: 'Add sessions table',
    sql: `
      CREATE TABLE sessions (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    description: 'Drop redundant indexes',
    sql: `
      DROP INDEX IF EXISTS idx_subscriptions_user;
      DROP INDEX IF EXISTS idx_releases_repo;
      DROP INDEX IF EXISTS idx_tags_repo;
    `,
  },
];
