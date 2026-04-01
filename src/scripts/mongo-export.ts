import { MongoClient } from 'mongodb';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

export interface ExportResult {
  users: number;
  repos: number;
  path: string;
}

export interface MongoExportDump {
  exportedAt: string;
  users: unknown[];
  repos: unknown[];
}

export async function mongoExport(dataDir: string): Promise<ExportResult> {
  if (!config.mongodb) throw new Error('config.mongodb is not set');

  mkdirSync(dataDir, { recursive: true });
  const outputPath = resolve(dataDir, 'export.json');

  const client = new MongoClient(config.mongodb.url);
  await client.connect();

  try {
    const db = client.db(config.mongodb.name);
    const users = await db.collection('users').find().toArray();
    const repos = await db.collection('repos').find().toArray();

    const dump: MongoExportDump = {
      exportedAt: new Date().toISOString(),
      users,
      repos,
    };

    writeFileSync(outputPath, JSON.stringify(dump, null, 2), 'utf-8');

    return { users: users.length, repos: repos.length, path: outputPath };
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = dirname(resolve(process.cwd(), config.sqlite.path));
  const result = await mongoExport(dataDir);
  console.log(`Exported ${result.users} users and ${result.repos} repos → ${result.path}`);
}
