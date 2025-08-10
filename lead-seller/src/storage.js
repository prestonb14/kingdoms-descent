import Database from 'better-sqlite3';
import path from 'node:path';
let dbInstance;

export function getDb() {
  if (!dbInstance) {
    const dbPath = path.join(process.cwd(), 'data', 'app.db');
    dbInstance = new Database(dbPath);
  }
  return dbInstance;
}