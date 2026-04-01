import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MongoExportDump } from './mongo-export.ts';
import { config } from '../config.ts';

interface MongoUser {
  userId: number;
  type?: string;
  subscriptions?: Array<{ owner: string; name: string }>;
}

interface MongoRelease {
  name: string;
}

interface MongoRepo {
  owner: string;
  name: string;
  watchedUsers?: number[];
  releases?: MongoRelease[];
  tags?: MongoRelease[];
}

export interface VerifyIssue {
  type: string;
  message: string;
}

export interface VerifyReport {
  passed: boolean;
  issues: VerifyIssue[];
  summary: string;
}

export function verify(dbPath: string, dumpPath: string): VerifyReport {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf-8')) as MongoExportDump;
  const mongoUsers = dump.users as MongoUser[];
  const mongoRepos = dump.repos as MongoRepo[];

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');

  const issues: VerifyIssue[] = [];

  // --- counts ---
  const dbUserCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (dbUserCount !== mongoUsers.length) {
    issues.push({
      type: 'users_count',
      message: `Users: expected ${mongoUsers.length}, got ${dbUserCount}`,
    });
  }

  const dbRepoCount = (db.prepare('SELECT COUNT(*) as c FROM repos').get() as { c: number }).c;
  if (dbRepoCount !== mongoRepos.length) {
    issues.push({
      type: 'repos_count',
      message: `Repos: expected ${mongoRepos.length}, got ${dbRepoCount}`,
    });
  }

  // --- per-user subscriptions ---
  for (const user of mongoUsers) {
    const dbRow = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(user.userId) as { user_id: number } | undefined;
    if (!dbRow) {
      issues.push({ type: 'missing_user', message: `User ${user.userId} not found in SQLite` });
      continue;
    }

    const dbSubs = db.prepare(`
      SELECT r.owner, r.name FROM repos r
      JOIN subscriptions s ON s.repo_id = r.id
      WHERE s.user_id = ?
    `).all(user.userId) as Array<{ owner: string; name: string }>;

    const dbSubSet = new Set(dbSubs.map(s => `${s.owner}/${s.name}`));

    // Source of truth for subscriptions is repos.watchedUsers, not users.subscriptions.
    // We check that the user is subscribed to repos they appear in as watchedUser.
    const expectedSubs = mongoRepos
      .filter(r => r.watchedUsers?.includes(user.userId))
      .map(r => `${r.owner}/${r.name}`);

    for (const sub of expectedSubs) {
      if (!dbSubSet.has(sub)) {
        issues.push({ type: 'missing_subscription', message: `User ${user.userId} missing subscription to ${sub}` });
      }
    }

    for (const sub of dbSubSet) {
      const inMongo = mongoRepos.some(
        r => `${r.owner}/${r.name}` === sub && r.watchedUsers?.includes(user.userId)
      );
      if (!inMongo) {
        issues.push({ type: 'extra_subscription', message: `User ${user.userId} has extra subscription to ${sub} in SQLite` });
      }
    }
  }

  // --- per-repo releases and tags ---
  for (const repo of mongoRepos) {
    const repoRow = db.prepare(
      'SELECT id FROM repos WHERE owner = ? AND name = ?'
    ).get(repo.owner, repo.name) as { id: number } | undefined;

    if (!repoRow) {
      issues.push({ type: 'missing_repo', message: `Repo ${repo.owner}/${repo.name} not found in SQLite` });
      continue;
    }

    // releases: export may have more than 5; SQLite stores last 5
    const mongoReleaseNames = (repo.releases ?? []).slice(-5).map(r => r.name).sort();
    const dbReleaseNames = (db.prepare(
      'SELECT name FROM releases WHERE repo_id = ? ORDER BY id ASC'
    ).all(repoRow.id) as Array<{ name: string }>).map(r => r.name).sort();

    if (JSON.stringify(mongoReleaseNames) !== JSON.stringify(dbReleaseNames)) {
      issues.push({
        type: 'releases_mismatch',
        message: `${repo.owner}/${repo.name} releases mismatch: expected [${mongoReleaseNames.join(', ')}], got [${dbReleaseNames.join(', ')}]`,
      });
    }

    const mongoTagNames = (repo.tags ?? []).slice(-5).map(r => r.name).sort();
    const dbTagNames = (db.prepare(
      'SELECT name FROM tags WHERE repo_id = ? ORDER BY id ASC'
    ).all(repoRow.id) as Array<{ name: string }>).map(r => r.name).sort();

    if (JSON.stringify(mongoTagNames) !== JSON.stringify(dbTagNames)) {
      issues.push({
        type: 'tags_mismatch',
        message: `${repo.owner}/${repo.name} tags mismatch: expected [${mongoTagNames.join(', ')}], got [${dbTagNames.join(', ')}]`,
      });
    }
  }

  const passed = issues.length === 0;

  const lines: string[] = [
    passed ? '✅ Verification passed' : `❌ Verification failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
    '',
    `Users:  ${mongoUsers.length} → ${dbUserCount} ${dbUserCount === mongoUsers.length ? '✓' : '✗'}`,
    `Repos:  ${mongoRepos.length} → ${dbRepoCount} ${dbRepoCount === mongoRepos.length ? '✓' : '✗'}`,
  ];

  if (!passed) {
    lines.push('', 'Issues:');
    for (const issue of issues.slice(0, 20)) {
      lines.push(`• ${issue.message}`);
    }
    if (issues.length > 20) {
      lines.push(`• ... and ${issues.length - 20} more`);
    }
  }

  return { passed, issues, summary: lines.join('\n') };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = resolve(process.cwd(), config.sqlite.path);
  const dumpPath = resolve(dirname(dbPath), 'export.json');

  const report = verify(dbPath, dumpPath);
  console.log(report.summary);
  if (!report.passed) process.exit(1);
}
