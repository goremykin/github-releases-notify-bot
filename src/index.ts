import { logger } from './logger.ts';
import { Db } from './db.sqlite.ts';
import { Bot } from './bot.ts';
import type { SessionData } from './bot.ts';
import { SqliteSessionStorage } from './session-storage.ts';
import { TaskManager } from './task-manager.ts';
import { getManyVersionsInBunches } from './github-client.ts';
import { config } from './config.ts';

process.on('uncaughtException', (err: Error) => {
  logger.error({ err }, 'uncaughtException');
});

process.on('unhandledRejection', (err: unknown) => {
  logger.error({ err }, 'unhandledRejection');
});

const db = new Db(config.sqlite.path);

try {
  await db.init();
} catch (error) {
  logger.error({ err: error }, 'DB init failed');
}

const storage = new SqliteSessionStorage<SessionData>(db.getConnection());
const tasks = new TaskManager();
const bot = new Bot(db, storage, logger, tasks);

const updateReleases = async () => {
  try {
    await db.clearReleases();
    const repos = await db.getAllReposNames();
    const updates = await getManyVersionsInBunches(
      repos.map(({ owner, name }) => ({ owner, name })),
      1
    );

    if (updates.tags.length || updates.releases.length) {
      logger.info({ releases: updates.releases.length, tags: updates.tags.length }, 'Repositories updated');
    }

    return await db.updateRepos(updates);
  } catch (error) {
    logger.error({ err: error }, 'Exception while releases requesting');
    return [];
  }
};

tasks.add('releases', updateReleases, config.app.updateInterval);
tasks.subscribe('releases', bot.notifyUsers.bind(bot));

logger.info('App ready');

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down');
  tasks.stop('releases')
    .then(() => bot.stop())
    .then(() => { process.exit(0); })
    .catch((err: unknown) => {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    });
});
