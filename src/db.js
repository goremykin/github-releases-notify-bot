const { MongoClient } = require('mongodb');

class DB {
  constructor(url, name) {
    this.name = name;
    this.url = url;

    this.users = null;
    this.repos = null;
  }

  async init() {
    try {
      const client = await MongoClient.connect(this.url, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        socketTimeoutMS: 480000,
        keepAlive: true
      });

      console.log("Connected successfully to DB");

      const db = client.db(this.name);

      await this.createCollections(db);

      console.log('Collections created');

      this.users = db.collection('users');
      this.repos = db.collection('repos');

      await this.createIndexes();

      console.log('Indexes created');
    } catch (error) {
      console.log('Something wrong with MongoDB =(', error.stack.toString());
    }
  }

  async createCollections(db) {
    const neededCollections = ['users', 'repos'];

    const collections = await db.collections();
    const existingCollectionNames = collections.map(collection => collection.collectionName);
    const collectionsForCreate = neededCollections.filter((neededCollection) => existingCollectionNames.indexOf(neededCollection) === -1);

    return await Promise.all([...collectionsForCreate.map((collection) => db.createCollection(collection))]);
  }

  async createIndexes() {
    const isExistUsersIndex = await this.users.indexExists('userId');

    if (!isExistUsersIndex) {
      return await this.users.createIndex({ userId: 1 }, { unique: true });
    } else {
      return null;
    }
  }

  async createUser(user) {
    const createdUser = await this.getUser(user.id);

    if (!createdUser) {
      await this.users.insertOne(Object.assign({
        userId: user.id,
        subscriptions: [],
        type: user.type,
        username: user.username,
        date: (new Date()).toISOString(),
      }, user.type === "private" ? {
        isBot: user.is_bot,
        firstName: user.first_name,
        lastName: user.last_name
      } : {
        title: user.title
      }));

      const userTitle = user.type === 'private' ? `${user.first_name} ${user.last_name}` : user.title;

      console.log(`user ${userTitle} created`);
    }
  }

  async addRepo(owner, name) {
    const repo = await this.repos.findOne({ owner, name });

    if (repo && repo.owner && repo.name) {
      return 'exist';
    } else {
      await this.repos.insertOne({
        owner,
        name,
        watchedUsers: [],
        releases: [],
        tags: []
      });

      return 'new';
    }
  }

  async getUserSubscriptions(userId) {
    return await this.repos.find({ watchedUsers: userId }).toArray();
  }

  async getUser(userId) {
    return await this.users.findOne({ userId });
  }

  async getAllUsers() {
    return await this.users.find().toArray();
  }

  async getRepo(owner, name) {
    return await this.repos.findOne({ owner, name });
  }

  async getAllRepos() {
    return await this.repos.find().toArray();
  }

  async getAllReposNames() {
    return await this.repos.find({}, { name: 1, owner: 1, watchedUsers: 1, _id: 0 }).toArray();
  }

  async clearReleases() {
    return await Promise.all([
      this.repos.update(
        { "releases.5": { "$exists": 1 } },
        { "$push": { "releases": { "$each": [], "$slice": -5 } } },
        { "multi": true }
      ),
      this.repos.update(
        { "tags.5": { "$exists": 1 } },
        { "$push": { "tags": { "$each": [], "$slice": -5 } } },
        { "multi": true }
      )
    ]);
  }

  async updateRepo(owner, name, { releases: newReleases, tags: newTags }) {
    const { releases, tags } = await this.repos.findOne({ owner, name });

    const filteredReleases = this.filterNewReleases(releases, newReleases);
    const filteredTags = this.filterNewReleases(tags, newTags);

    return await this.repos.updateOne({ owner, name }, {
      $push: {
        releases: { $each: filteredReleases },
        tags: { $each: filteredTags }
      }
    }, { upsert: true });
  }

  async updateReposReleases(newReleasesUpdates, newTagsUpdates, changedUpdates) {
    const preparedNewReleases = [
      ...newReleasesUpdates
        .filter(Boolean)
        .map((update) => ({
          filter: {
            owner: update.owner,
            name: update.name
          },
          update: {
            $push: {
              releases: {$each: update.releases}
            }
          }
        })),
      ...newTagsUpdates
        .filter(Boolean)
        .map((update) => ({
          filter: {
            owner: update.owner,
            name: update.name
          },
          update: {
            $push: {
              tags: {$each: update.tags}
            }
          }
        }))
    ];

    const preparedChangedReleases = changedUpdates
      .filter(Boolean)
      .reduce((acc, { owner, name, releases }) => acc.concat(
        releases.map((release) => ({
            owner,
            name,
            release
          })
        )
      ), [])
      .filter(Boolean)
      .map((update) => ({
        filter: {
          owner: update.owner,
          name: update.name,
          'releases.name': update.release.name
        },
        update: {
          $set: {
            'releases.$': {
              name: update.release.name,
              description: update.release.description,
              isPrerelease: update.release.isPrerelease,
              url: update.release.url,
            }
          }
        }
      }));

    await Promise.all([
      ...[
        ...preparedNewReleases,
        ...preparedChangedReleases
      ].map(({ filter, update }) => this.repos.updateOne(filter, update))
    ]);
  }

  async updateRepos({ releases, tags }) {
    const oldRepos = await this.getAllRepos();

    const newReleasesUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterNewReleases);
    const newTagsUpdates = this.modifyReleases(tags, oldRepos, 'tags', this.filterNewReleases);
    const changedUpdates = this.modifyReleases(releases, oldRepos, 'releases', this.filterChangedReleases);

    await this.updateReposReleases(newReleasesUpdates, newTagsUpdates, changedUpdates);

    const onlyTagsUpdates = newTagsUpdates
      .filter(({ owner, name }) => !newReleasesUpdates
        .some((release) => release.owner === owner && release.name === name));

    const newReleasesWithTags = newReleasesUpdates
      .map((repoWithRelease) => {
        const similarRepoWithTags = newTagsUpdates
          .find(({ owner, name }) => repoWithRelease.owner === owner && repoWithRelease.name === name);

        if (similarRepoWithTags) {
          return Object.assign({}, repoWithRelease, {
            releases: [
              ...repoWithRelease.releases,
              ...similarRepoWithTags.tags
                .filter(({ name }) => !repoWithRelease.releases
                  .some((release) => release.name === name))
            ]
          });
        } else {
          return repoWithRelease;
        }
      });

    return [...newReleasesWithTags, ...onlyTagsUpdates, ...changedUpdates]
      .map((entry) => entry.tags ? Object.assign({ releases: entry.tags }, entry) : entry);
  }

  async bindUserToRepo(userId, owner, name) {
    const status = await this.addRepo(owner, name);

    await Promise.all([
      this.repos.updateOne({ owner, name }, {
        $addToSet: {
          watchedUsers: userId
        }
      }, { upsert: true }),
      this.users.updateOne({ userId }, {
        $addToSet: {
          subscriptions: { owner, name }
        }
      }, { upsert: true })
    ]);

    return status;
  }

  async unbindUserFromRepo(userId, owner, name) {
    return await Promise.all([
      this.repos.updateOne({ owner, name }, {
        $pull: {
          watchedUsers: userId
        }
      }, { upsert: true }),
      this.users.updateOne({ userId }, {
        $pull: {
          subscriptions: { owner, name }
        }
      }, { upsert: true })
    ]);
  }

  modifyReleases(entries, repos, type, releasesFilter) {
    const findSimilar = (arr, repo) => arr
      .filter(Boolean)
      .find(({ owner, name }) => owner === repo.owner && name === repo.name);

    return entries
      .filter(Boolean)
      .map((updatedRepo = {}) => {
        const similarRepo = findSimilar(repos, updatedRepo);

        return {
          owner: updatedRepo.owner,
          name: updatedRepo.name,
          [type]: releasesFilter(similarRepo[type], updatedRepo[type]),
          watchedUsers: similarRepo.watchedUsers || []
        }
      })
      .filter((update) => update[type].length)
  }

  filterNewReleases(oldReleases = [], newReleases = []) {
    return newReleases.filter((newRelease) => (
      newRelease && !oldReleases.some((oldRelease) =>
        oldRelease && (oldRelease.name === newRelease.name)
      )
    ));
  }

  filterChangedReleases(oldReleases = [], newReleases = []) {
    return newReleases.filter((newRelease) => (
      newRelease && oldReleases.some((oldRelease) => (
        oldRelease && (
          oldRelease.name === newRelease.name
        ) && (
          oldRelease.description !== newRelease.description
          || oldRelease.isPrerelease !== newRelease.isPrerelease
        )
      ))
    ));
  }
}

module.exports = {
  DB
};
