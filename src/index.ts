import cluster from 'cluster';
import { logger } from './logger.ts';
import { Db } from './db.ts';
import { Bot } from './bot.ts';
import { TaskManager } from './task-manager.ts';
import { getManyVersionsInBunches } from './github-client.ts';
import { config } from './config.ts';

const tasks = new TaskManager();
const workers = parseInt(process.env.WORKERS ?? '1', 10);

process.on('uncaughtException', (err: Error) => {
  logger.error({ err }, 'uncaughtException');
});

process.on('unhandledRejection', (err: unknown) => {
  logger.error({ err }, 'unhandledRejection');
});

const run = async (): Promise<void> => {
  logger.info('Worker initializing');

  const db = new Db(config.mongodb.url, config.mongodb.name);

  try {
    await db.init();
  } catch (error) {
    logger.error({ err: error }, 'DB init failed');
  }

  const bot = new Bot(db, logger, tasks);

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

  tasks.add('releases', updateReleases, config.app.updateInterval || 60 * 5);
  tasks.subscribe('releases', bot.notifyUsers.bind(bot));

  process.on('SIGTERM', () => {
    logger.info('Worker received SIGTERM, shutting down');
    tasks.stop('releases')
      .then(() => { bot.stop(); })
      .then(() => { process.exit(0); })
      .catch((err: unknown) => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  });

  logger.info('Worker ready');
};

const forkWorker = (): void => {
  const worker = cluster.fork().process;
  logger.info({ pid: worker.pid }, 'Worker started');
};

if (cluster.isPrimary) {
  logger.info({ workers }, 'Starting cluster');

  for (let i = workers; i--;) {
    forkWorker();
  }

  let isShuttingDown = false;

  cluster.on('exit', (worker) => {
    if (isShuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) {
        logger.info('All workers exited');
        process.exit(0);
      }
      return;
    }
    const timeout = config.app.restartRate;
    logger.warn({ pid: worker.process.pid, restartIn: timeout }, 'Worker died, restarting');
    setTimeout(() => forkWorker(), timeout * 1000);
  });

  process.on('SIGTERM', () => {
    logger.info('Primary received SIGTERM, stopping workers');
    isShuttingDown = true;
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.process.kill('SIGTERM');
    }
  });
} else {
  run();
}
