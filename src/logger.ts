import pino from 'pino';

export const logger = pino({ name: 'github-releases-notify-bot' });

export type { Logger } from 'pino';
