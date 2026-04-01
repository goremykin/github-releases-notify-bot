import { DatabaseSync } from 'node:sqlite';
import type { StorageAdapter } from 'grammy';

export class SqliteSessionStorage<V> implements StorageAdapter<V> {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  read(key: string): V | undefined {
    const row = this.db
      .prepare('SELECT value FROM sessions WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as V) : undefined;
  }

  write(key: string, value: V): void {
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM sessions WHERE key = ?').run(key);
  }
}
