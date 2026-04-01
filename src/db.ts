import { MongoClient, type Collection, type Db as MongoDb } from 'mongodb';
import { logger } from './logger.ts';
import type { RepoDocument, UserDocument, Release, RepoIdentifier, RepoUpdate, RepoWithReleases, RepoWithTags, VersionUpdates } from './types.ts';

type ReleasesFilter = (oldReleases: Release[], newReleases: Release[]) => Release[];

interface ModifyResult extends RepoIdentifier {
  releases?: Release[];
  tags?: Release[];
  watchedUsers: number[];
}

export class Db {
  private url: string;
  private name: string;
  private users!: Collection<UserDocument>;
  private repos!: Collection<RepoDocument>;

  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
  }

  async init(): Promise<void> {
    try {
      const client = new MongoClient(this.url);
      await client.connect();
      logger.info('Connected successfully to Db');

      const db: MongoDb = client.db(this.name);
      await this.createCollections(db);

      this.users = db.collection<UserDocument>('users');
      this.repos = db.collection<RepoDocument>('repos');

      await this.createIndexes();
      logger.info('DB initialized');
    } catch (error) {
      logger.error({ err: error }, 'MongoDB connection failed');
    }
  }

  private async createCollections(db: MongoDb): Promise<void> {
    const neededCollections = ['users', 'repos'];
    const collections = await db.collections();
    const existingCollectionNames = collections.map((c) => c.collectionName);
    const collectionsForCreate = neededCollections.filter((name) => !existingCollectionNames.includes(name));
    await Promise.all(collectionsForCreate.map((name) => db.createCollection(name)));
  }

  private async createIndexes(): Promise<void> {
    const isExistUsersIndex = await this.users.indexExists('userId');
    if (!isExistUsersIndex) {
      await this.users.createIndex({ userId: 1 }, { unique: true });
    }
  }

  async createUser(user: { id: number; type: string; username?: string; is_bot?: boolean; first_name?: string; last_name?: string; title?: string }): Promise<void> {
    const createdUser = await this.getUser(user.id);

    if (!createdUser) {
      await this.users.insertOne({
        userId: user.id,
        subscriptions: [],
        type: user.type,
        username: user.username ?? '',
        date: (new Date()).toISOString(),
        ...(user.type === 'private' ? {
          isBot: user.is_bot,
          firstName: user.first_name,
          lastName: user.last_name
        } : {
          title: user.title
        })
      } as UserDocument);

      const userTitle = user.type === 'private' ? `${user.first_name} ${user.last_name}` : user.title;
      logger.info({ userTitle }, 'User created');
    }
  }

  async addRepo(owner: string, name: string): Promise<'exist' | 'new'> {
    const repo = await this.repos.findOne({ owner, name });

    if (repo?.owner && repo?.name) {
      return 'exist';
    }

    await this.repos.insertOne({ owner, name, watchedUsers: [], releases: [], tags: [] } as RepoDocument);
    return 'new';
  }

  async getUserSubscriptions(userId: number): Promise<RepoDocument[]> {
    return this.repos.find({ watchedUsers: userId } as never).toArray();
  }

  async getUser(userId: number): Promise<UserDocument | null> {
    return this.users.findOne({ userId });
  }

  async getAllUsers(): Promise<UserDocument[]> {
    return this.users.find().toArray();
  }

  async getRepo(owner: string, name: string): Promise<RepoDocument | null> {
    return this.repos.findOne({ owner, name });
  }

  async getAllRepos(): Promise<RepoDocument[]> {
    return this.repos.find().toArray();
  }

  async getAllReposNames(): Promise<Pick<RepoDocument, 'owner' | 'name' | 'watchedUsers'>[]> {
    return this.repos.find({}, { projection: { name: 1, owner: 1, watchedUsers: 1, _id: 0 } }).toArray() as unknown as Pick<RepoDocument, 'owner' | 'name' | 'watchedUsers'>[];
  }

  async clearReleases(): Promise<void> {
    await Promise.all([
      this.repos.updateMany(
        { 'releases.5': { $exists: true } } as never,
        { $push: { releases: { $each: [], $slice: -5 } } } as never
      ),
      this.repos.updateMany(
        { 'tags.5': { $exists: true } } as never,
        { $push: { tags: { $each: [], $slice: -5 } } } as never
      )
    ]);
  }

  async updateRepo(owner: string, name: string, { releases: newReleases, tags: newTags }: { releases: Release[]; tags: Release[] }): Promise<void> {
    const repo = await this.repos.findOne({ owner, name });
    if (!repo) return;

    const filteredReleases = this.filterNewReleases(repo.releases, newReleases);
    const filteredTags = this.filterNewReleases(repo.tags, newTags);

    await this.repos.updateOne({ owner, name }, {
      $push: {
        releases: { $each: filteredReleases } as never,
        tags: { $each: filteredTags } as never
      }
    }, { upsert: true });
  }

  private async updateReposReleases(
    newReleasesUpdates: ModifyResult[],
    newTagsUpdates: ModifyResult[],
    changedUpdates: ModifyResult[]
  ): Promise<void> {
    const preparedNewReleases = [
      ...newReleasesUpdates.filter(Boolean).map((update) => ({
        filter: { owner: update.owner, name: update.name },
        update: { $push: { releases: { $each: update.releases } } }
      })),
      ...newTagsUpdates.filter(Boolean).map((update) => ({
        filter: { owner: update.owner, name: update.name },
        update: { $push: { tags: { $each: update.tags } } }
      }))
    ];

    const preparedChangedReleases = changedUpdates
      .filter(Boolean)
      .reduce<Array<{ owner: string; name: string; release: Release }>>((acc, { owner, name, releases }) =>
        acc.concat((releases ?? []).map((release) => ({ owner, name, release }))), [])
      .filter(Boolean)
      .map((update) => ({
        filter: { owner: update.owner, name: update.name, 'releases.name': update.release.name },
        update: { $set: { 'releases.$': { name: update.release.name, description: update.release.description, isPrerelease: update.release.isPrerelease, url: update.release.url } } }
      }));

    await Promise.all(
      [...preparedNewReleases, ...preparedChangedReleases]
        .map(({ filter, update }) => this.repos.updateOne(filter as never, update as never))
    );
  }

  async updateRepos({ releases, tags }: VersionUpdates): Promise<RepoUpdate[]> {
    const oldRepos = await this.getAllRepos();

    const newReleasesUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterNewReleases);
    const newTagsUpdates = this.modifyReleases(tags, oldRepos, 'tags', this.filterNewReleases);
    const changedUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterChangedReleases);

    await this.updateReposReleases(newReleasesUpdates, newTagsUpdates, changedUpdates);

    const onlyTagsUpdates = newTagsUpdates
      .filter(({ owner, name }) => !newReleasesUpdates.some((r) => r.owner === owner && r.name === name));

    const newReleasesWithTags = newReleasesUpdates.map((repoWithRelease) => {
      const similarRepoWithTags = newTagsUpdates.find(({ owner, name }) =>
        repoWithRelease.owner === owner && repoWithRelease.name === name);

      if (similarRepoWithTags) {
        return {
          ...repoWithRelease,
          releases: [
            ...(repoWithRelease.releases ?? []),
            ...(similarRepoWithTags.tags ?? []).filter(({ name }) =>
              !(repoWithRelease.releases ?? []).some((r) => r.name === name))
          ]
        };
      }
      return repoWithRelease;
    });

    return [...newReleasesWithTags, ...onlyTagsUpdates, ...changedUpdates]
      .map((entry): RepoUpdate => ({
        owner: entry.owner,
        name: entry.name,
        watchedUsers: entry.watchedUsers,
        releases: entry.tags ? entry.tags : (entry.releases ?? []),
        ...(entry.tags ? { tags: entry.tags } : {})
      }));
  }

  async bindUserToRepo(userId: number, owner: string, name: string): Promise<'exist' | 'new'> {
    const status = await this.addRepo(owner, name);

    await Promise.all([
      this.repos.updateOne({ owner, name }, { $addToSet: { watchedUsers: userId } } as never, { upsert: true }),
      this.users.updateOne({ userId }, { $addToSet: { subscriptions: { owner, name } } } as never, { upsert: true })
    ]);

    return status;
  }

  async unbindUserFromRepo(userId: number, owner: string, name: string): Promise<void> {
    await Promise.all([
      this.repos.updateOne({ owner, name }, { $pull: { watchedUsers: userId } } as never, { upsert: true }),
      this.users.updateOne({ userId }, { $pull: { subscriptions: { owner, name } } } as never, { upsert: true })
    ]);
  }

  private modifyReleases(
    entries: Array<RepoWithReleases | RepoWithTags>,
    repos: RepoDocument[],
    type: 'releases' | 'tags',
    releasesFilter: ReleasesFilter
  ): ModifyResult[] {
    const results: ModifyResult[] = [];

    for (const updatedRepo of entries.filter(Boolean)) {
      const similarRepo = repos.find(({ owner, name }) => owner === updatedRepo.owner && name === updatedRepo.name);
      if (!similarRepo) continue;

      const newItems: Release[] = (updatedRepo as unknown as Record<string, Release[]>)[type] ?? [];
      const filtered = releasesFilter(similarRepo[type], newItems);
      if (!filtered.length) continue;

      results.push({
        owner: updatedRepo.owner,
        name: updatedRepo.name,
        [type]: filtered,
        watchedUsers: similarRepo.watchedUsers ?? []
      });
    }

    return results;
  }

  private filterNewReleases(oldReleases: Release[] = [], newReleases: Release[] = []): Release[] {
    return newReleases.filter((newRelease) =>
      newRelease && !oldReleases.some((oldRelease) => oldRelease && oldRelease.name === newRelease.name)
    );
  }

  private filterChangedReleases(oldReleases: Release[] = [], newReleases: Release[] = []): Release[] {
    return newReleases.filter((newRelease) =>
      newRelease && oldReleases.some((oldRelease) =>
        oldRelease &&
        oldRelease.name === newRelease.name &&
        (oldRelease.description !== newRelease.description || oldRelease.isPrerelease !== newRelease.isPrerelease)
      )
    );
  }
}
