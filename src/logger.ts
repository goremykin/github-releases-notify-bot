import pino from 'pino';
import { config } from './config.ts';

const pretty = config.app.prettyLogs;

export const logger = pino(
  { name: 'github-releases-notify-bot' },
  pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: process.stdout.isTTY,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,name',
        },
      })
    : undefined
);

export type { Logger } from 'pino';
