import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MongoExportDump } from './mongo-export.ts';
import { config } from '../src/config.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
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

  CREATE TABLE IF NOT EXISTS repos (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name  TEXT NOT NULL,
    UNIQUE(owner, name)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, repo_id)
  );

  CREATE TABLE IF NOT EXISTS releases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    is_prerelease INTEGER NOT NULL DEFAULT 0,
    url           TEXT,
    UNIQUE(repo_id, name)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    is_prerelease INTEGER NOT NULL DEFAULT 0,
    url           TEXT,
    UNIQUE(repo_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_repo ON subscriptions(repo_id);
  CREATE INDEX IF NOT EXISTS idx_releases_repo ON releases(repo_id);
  CREATE INDEX IF NOT EXISTS idx_tags_repo ON tags(repo_id);
`;

export interface ImportResult {
  users: number;
  repos: number;
  subscriptions: number;
  releases: number;
  tags: number;
}

interface MongoUser {
  userId: number;
  type: string;
  username?: string;
  date?: string;
  isBot?: boolean;
  firstName?: string;
  lastName?: string;
  title?: string;
}

interface MongoRelease {
  name: string;
  description?: string;
  isPrerelease?: boolean;
  url?: string;
}

interface MongoRepo {
  owner: string;
  name: string;
  watchedUsers?: number[];
  releases?: MongoRelease[];
  tags?: MongoRelease[];
}

export function sqliteImport(dbPath: string, dumpPath: string): ImportResult {
  if (existsSync(dbPath)) {
    console.warn(`Warning: ${dbPath} already exists — importing into existing database (duplicates will be skipped)`);
  }

  const dump = JSON.parse(readFileSync(dumpPath, 'utf-8')) as MongoExportDump;
  const users = dump.users as MongoUser[];
  const repos = dump.repos as MongoRepo[];

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);

  let subscriptionsCount = 0;
  let releasesCount = 0;
  let tagsCount = 0;

  db.exec('BEGIN');
  try {
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (user_id, type, username, date, is_bot, first_name, last_name, title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const user of users) {
      insertUser.run(
        user.userId,
        user.type ?? 'private',
        user.username ?? null,
        user.date ?? new Date().toISOString(),
        user.type === 'private' ? (user.isBot ? 1 : 0) : null,
        user.type === 'private' ? (user.firstName ?? null) : null,
        user.type === 'private' ? (user.lastName ?? null) : null,
        user.type !== 'private' ? (user.title ?? null) : null,
      );
    }

    const insertRepo = db.prepare('INSERT OR IGNORE INTO repos (owner, name) VALUES (?, ?)');
    const insertSub = db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, repo_id) VALUES (?, ?)');
    const insertRelease = db.prepare(`
      INSERT OR IGNORE INTO releases (repo_id, name, description, is_prerelease, url)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertTag = db.prepare(`
      INSERT OR IGNORE INTO tags (repo_id, name, description, is_prerelease, url)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const repo of repos) {
      insertRepo.run(repo.owner, repo.name);

      const repoRow = db.prepare(
        'SELECT id FROM repos WHERE owner = ? AND name = ?'
      ).get(repo.owner, repo.name) as { id: number };

      for (const userId of repo.watchedUsers ?? []) {
        const userExists = db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId);
        if (!userExists) continue;
        insertSub.run(userId, repoRow.id);
        subscriptionsCount++;
      }

      for (const release of repo.releases ?? []) {
        insertRelease.run(
          repoRow.id,
          release.name,
          release.description ?? null,
          release.isPrerelease ? 1 : 0,
          release.url ?? null,
        );
        releasesCount++;
      }

      // cap to last 5
      db.prepare(`
        DELETE FROM releases WHERE repo_id = ? AND id NOT IN (
          SELECT id FROM releases WHERE repo_id = ? ORDER BY id DESC LIMIT 5
        )
      `).run(repoRow.id, repoRow.id);

      for (const tag of repo.tags ?? []) {
        insertTag.run(
          repoRow.id,
          tag.name,
          tag.description ?? null,
          tag.isPrerelease ? 1 : 0,
          tag.url ?? null,
        );
        tagsCount++;
      }

      // cap to last 5
      db.prepare(`
        DELETE FROM tags WHERE repo_id = ? AND id NOT IN (
          SELECT id FROM tags WHERE repo_id = ? ORDER BY id DESC LIMIT 5
        )
      `).run(repoRow.id, repoRow.id);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    users: users.length,
    repos: repos.length,
    subscriptions: subscriptionsCount,
    releases: releasesCount,
    tags: tagsCount,
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = resolve(process.cwd(), config.sqlite.path);
  const dataDir = dirname(dbPath);
  mkdirSync(dataDir, { recursive: true });

  const dumpPath = resolve(dataDir, 'export.json');

  const result = sqliteImport(dbPath, dumpPath);
  console.log([
    `Import complete:`,
    `  Users:         ${result.users}`,
    `  Repos:         ${result.repos}`,
    `  Subscriptions: ${result.subscriptions}`,
    `  Releases:      ${result.releases}`,
    `  Tags:          ${result.tags}`,
  ].join('\n'));
}
