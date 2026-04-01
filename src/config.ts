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

export const config = JSON.parse(raw) as Config;
