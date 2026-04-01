import { DatabaseSync } from 'node:sqlite';
import { logger } from './logger.ts';
import { MIGRATIONS } from './migrations.ts';
import type {
  RepoDocument,
  UserDocument,
  Release,
  RepoUpdate,
  RepoWithReleases,
  RepoWithTags,
  VersionUpdates,
  TelegramUser,
} from './types.ts';

type ReleasesFilter = (oldReleases: Release[], newReleases: Release[]) => Release[];
type SQLValue = null | number | bigint | string | Uint8Array;

interface ModifyResult {
  owner: string;
  name: string;
  releases?: Release[];
  tags?: Release[];
  watchedUsers: number[];
}

interface UserRow {
  id: number;
  user_id: number;
  type: string;
  username: string | null;
  date: string;
  is_bot: number | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
}

interface ReleaseRow {
  name: string;
  description: string | null;
  is_prerelease: number;
  url: string | null;
}


function mapRelease(row: ReleaseRow): Release {
  return {
    name: row.name,
    description: row.description ?? '',
    isPrerelease: Boolean(row.is_prerelease),
    url: row.url ?? '',
  };
}

export class Db {
  private path: string;
  private db!: DatabaseSync;

  constructor(path: string) {
    this.path = path;
  }

  getConnection(): DatabaseSync {
    return this.db;
  }

  async init(): Promise<void> {
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.runMigrations();
    logger.info('Connected successfully to Db');
    logger.info('DB initialized');
  }

  private runMigrations(): void {
    const currentVersion = this.queryOne<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    const pending = MIGRATIONS.filter(m => m.version > currentVersion);

    for (const migration of pending) {
      logger.info({ version: migration.version, description: migration.description }, 'Running migration');
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      logger.info({ version: migration.version }, 'Migration complete');
    }
  }

  async createUser(user: TelegramUser): Promise<void> {
    const existing = await this.getUser(user.id);
    if (existing) return;

    this.db.prepare(`
      INSERT INTO users (user_id, type, username, date, is_bot, first_name, last_name, title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.type,
      user.username ?? null,
      new Date().toISOString(),
      user.type === 'private' ? (user.is_bot ? 1 : 0) : null,
      user.type === 'private' ? (user.first_name ?? null) : null,
      user.type === 'private' ? (user.last_name ?? null) : null,
      user.type !== 'private' ? (user.title ?? null) : null,
    );

    const userTitle = user.type === 'private'
      ? `${user.first_name} ${user.last_name}`
      : user.title;
    logger.info({ userTitle }, 'User created');
  }

  async addRepo(owner: string, name: string): Promise<'exist' | 'new'> {
    if (this.queryOne<RepoRow>('SELECT id FROM repos WHERE owner = ? AND name = ?', owner, name)) {
      return 'exist';
    }
    this.db.prepare('INSERT INTO repos (owner, name) VALUES (?, ?)').run(owner, name);
    return 'new';
  }

  async getUserSubscriptions(userId: number): Promise<RepoDocument[]> {
    const rows = this.query<RepoRow>(`
      SELECT r.id, r.owner, r.name FROM repos r
      JOIN subscriptions s ON s.repo_id = r.id
      WHERE s.user_id = ?
    `, userId);
    return rows.map(row => this.buildRepoDocument(row));
  }

  async getUser(userId: number): Promise<UserDocument | null> {
    const row = this.queryOne<UserRow>('SELECT * FROM users WHERE user_id = ?', userId);
    return row ? this.buildUserDocument(row) : null;
  }

  async getAllUsers(): Promise<UserDocument[]> {
    return this.query<UserRow>('SELECT * FROM users').map(row => this.buildUserDocument(row));
  }

  async getRepo(owner: string, name: string): Promise<RepoDocument | null> {
    const row = this.queryOne<RepoRow>(
      'SELECT id, owner, name FROM repos WHERE owner = ? AND name = ?', owner, name
    );
    return row ? this.buildRepoDocument(row) : null;
  }

  async getAllRepos(): Promise<RepoDocument[]> {
    return this.query<RepoRow>('SELECT id, owner, name FROM repos').map(row => this.buildRepoDocument(row));
  }

  async getAllReposNames(): Promise<Pick<RepoDocument, 'owner' | 'name' | 'watchedUsers'>[]> {
    return this.query<RepoRow>('SELECT id, owner, name FROM repos').map(row => ({
      owner: row.owner,
      name: row.name,
      watchedUsers: this.query<{ user_id: number }>(
        'SELECT user_id FROM subscriptions WHERE repo_id = ?', row.id
      ).map(r => r.user_id),
    }));
  }

  // no-op: capping is enforced at insert time via insertReleases()
  async clearReleases(): Promise<void> {}

  async updateRepo(
    owner: string,
    name: string,
    { releases: newReleases, tags: newTags }: { releases: Release[]; tags: Release[] }
  ): Promise<void> {
    const repoRow = this.queryOne<RepoRow>(
      'SELECT id FROM repos WHERE owner = ? AND name = ?', owner, name
    );
    if (!repoRow) return;

    this.insertReleases(repoRow.id, newReleases, 'releases');
    this.insertReleases(repoRow.id, newTags, 'tags');
  }

  async updateRepos({ releases, tags }: VersionUpdates): Promise<RepoUpdate[]> {
    const oldRepos = await this.getAllRepos();

    const newReleasesUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterNewReleases);
    const newTagsUpdates = this.modifyReleases(tags, oldRepos, 'tags', this.filterNewReleases);
    const changedUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterChangedReleases);

    this.db.exec('BEGIN');
    try {
      for (const update of newReleasesUpdates) {
        const repoRow = this.queryOne<RepoRow>(
          'SELECT id FROM repos WHERE owner = ? AND name = ?', update.owner, update.name
        );
        if (!repoRow) continue;
        this.insertReleases(repoRow.id, update.releases ?? [], 'releases');
      }

      for (const update of newTagsUpdates) {
        const repoRow = this.queryOne<RepoRow>(
          'SELECT id FROM repos WHERE owner = ? AND name = ?', update.owner, update.name
        );
        if (!repoRow) continue;
        this.insertReleases(repoRow.id, update.tags ?? [], 'tags');
      }

      for (const update of changedUpdates) {
        const repoRow = this.queryOne<RepoRow>(
          'SELECT id FROM repos WHERE owner = ? AND name = ?', update.owner, update.name
        );
        if (!repoRow) continue;
        for (const release of update.releases ?? []) {
          this.db.prepare(`
            UPDATE releases SET description = ?, is_prerelease = ?, url = ?
            WHERE repo_id = ? AND name = ?
          `).run(release.description, release.isPrerelease ? 1 : 0, release.url, repoRow.id, release.name);
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    const onlyTagsUpdates = newTagsUpdates.filter(
      ({ owner, name }) => !newReleasesUpdates.some(r => r.owner === owner && r.name === name)
    );

    const newReleasesWithTags = newReleasesUpdates.map(repoWithRelease => {
      const similarRepoWithTags = newTagsUpdates.find(
        ({ owner, name }) => repoWithRelease.owner === owner && repoWithRelease.name === name
      );
      if (similarRepoWithTags) {
        return {
          ...repoWithRelease,
          releases: [
            ...(repoWithRelease.releases ?? []),
            ...(similarRepoWithTags.tags ?? []).filter(
              ({ name }) => !(repoWithRelease.releases ?? []).some(r => r.name === name)
            ),
          ],
        };
      }
      return repoWithRelease;
    });

    return [...newReleasesWithTags, ...onlyTagsUpdates, ...changedUpdates].map((entry): RepoUpdate => ({
      owner: entry.owner,
      name: entry.name,
      watchedUsers: entry.watchedUsers,
      releases: entry.tags ? entry.tags : (entry.releases ?? []),
      ...(entry.tags ? { tags: entry.tags } : {}),
    }));
  }

  async bindUserToRepo(userId: number, owner: string, name: string): Promise<'exist' | 'new'> {
    const status = await this.addRepo(owner, name);
    const repoRow = this.queryOne<RepoRow>(
      'SELECT id FROM repos WHERE owner = ? AND name = ?', owner, name
    );
    if (!repoRow) throw new Error(`Repo ${owner}/${name} not found after insertion`);
    this.db.prepare('INSERT OR IGNORE INTO subscriptions (user_id, repo_id) VALUES (?, ?)').run(userId, repoRow.id);
    return status;
  }

  async unbindUserFromRepo(userId: number, owner: string, name: string): Promise<void> {
    const repoRow = this.queryOne<RepoRow>(
      'SELECT id FROM repos WHERE owner = ? AND name = ?', owner, name
    );
    if (!repoRow) return;
    this.db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND repo_id = ?').run(userId, repoRow.id);
  }

  private query<T>(sql: string, ...params: SQLValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private queryOne<T>(sql: string, ...params: SQLValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  private insertReleases(repoId: number, items: Release[], table: 'releases' | 'tags'): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO ${table} (repo_id, name, description, is_prerelease, url)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const r of items) {
      insert.run(repoId, r.name, r.description, r.isPrerelease ? 1 : 0, r.url);
    }
    // keep only the last 5 per repo
    this.db.prepare(`
      DELETE FROM ${table} WHERE repo_id = ? AND id NOT IN (
        SELECT id FROM ${table} WHERE repo_id = ? ORDER BY id DESC LIMIT 5
      )
    `).run(repoId, repoId);
  }

  private buildRepoDocument(row: RepoRow): RepoDocument {
    return {
      owner: row.owner,
      name: row.name,
      releases: this.query<ReleaseRow>(
        'SELECT name, description, is_prerelease, url FROM releases WHERE repo_id = ? ORDER BY id ASC', row.id
      ).map(mapRelease),
      tags: this.query<ReleaseRow>(
        'SELECT name, description, is_prerelease, url FROM tags WHERE repo_id = ? ORDER BY id ASC', row.id
      ).map(mapRelease),
      watchedUsers: this.query<{ user_id: number }>(
        'SELECT user_id FROM subscriptions WHERE repo_id = ?', row.id
      ).map(r => r.user_id),
    };
  }

  private buildUserDocument(row: UserRow): UserDocument {
    return {
      userId: row.user_id,
      subscriptions: this.query<{ owner: string; name: string }>(`
        SELECT r.owner, r.name FROM repos r
        JOIN subscriptions s ON s.repo_id = r.id
        WHERE s.user_id = ?
      `, row.user_id),
      type: row.type,
      username: row.username ?? '',
      date: row.date,
      ...(row.type === 'private'
        ? {
            isBot: row.is_bot !== null ? Boolean(row.is_bot) : undefined,
            firstName: row.first_name ?? undefined,
            lastName: row.last_name ?? undefined,
          }
        : {
            title: row.title ?? undefined,
          }),
    };
  }

  private modifyReleases(
    entries: Array<RepoWithReleases | RepoWithTags>,
    repos: RepoDocument[],
    type: 'releases' | 'tags',
    releasesFilter: ReleasesFilter,
  ): ModifyResult[] {
    const results: ModifyResult[] = [];

    for (const updatedRepo of entries.filter(Boolean)) {
      const similarRepo = repos.find(
        ({ owner, name }) => owner === updatedRepo.owner && name === updatedRepo.name
      );
      if (!similarRepo) continue;

      const newItems = (updatedRepo as unknown as Record<string, Release[]>)[type] ?? [];
      const filtered = releasesFilter(similarRepo[type], newItems);
      if (!filtered.length) continue;

      results.push({
        owner: updatedRepo.owner,
        name: updatedRepo.name,
        [type]: filtered,
        watchedUsers: similarRepo.watchedUsers ?? [],
      });
    }

    return results;
  }

  private filterNewReleases(oldReleases: Release[] = [], newReleases: Release[] = []): Release[] {
    return newReleases.filter(newRelease =>
      newRelease && !oldReleases.some(oldRelease => oldRelease && oldRelease.name === newRelease.name)
    );
  }

  private filterChangedReleases(oldReleases: Release[] = [], newReleases: Release[] = []): Release[] {
    return newReleases.filter(newRelease =>
      newRelease && oldReleases.some(oldRelease =>
        oldRelease &&
        oldRelease.name === newRelease.name &&
        (oldRelease.description !== newRelease.description || oldRelease.isPrerelease !== newRelease.isPrerelease)
      )
    );
  }
}
