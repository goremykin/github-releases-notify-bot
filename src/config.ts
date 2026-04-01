import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Config } from './types.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(dir, '../config.json');

let raw: string;
try {
  raw = readFileSync(configPath, 'utf-8');
} catch {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

const parsed = JSON.parse(raw) as Partial<Config>;

const required: Array<[string, unknown]> = [
  ['telegram.token', parsed.telegram?.token],
  ['github.token', parsed.github?.token],
];
const missing = required.filter(([, value]) => !value).map(([key]) => key);
if (missing.length > 0) {
  console.error(`Config: missing required fields: ${missing.join(', ')}`);
  process.exit(1);
}

export const config: Config = {
  ...parsed as Config,
  github: {
    url: 'https://api.github.com/graphql',
    ...parsed.github,
  } as Config['github'],
  telegram: {
    proxy: '',
    ...parsed.telegram,
  } as Config['telegram'],
  sqlite: {
    path: './data/app.db',
    ...parsed.sqlite,
  },
  app: {
    updateInterval: 300,
    restartRate: 180,
    includePrerelease: false,
    prettyLogs: true,
    ...parsed.app,
  },
};
