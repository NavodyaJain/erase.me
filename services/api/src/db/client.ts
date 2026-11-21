import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, onError?: (err: Error) => void): DbHandle {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client error must not crash the process.
  pool.on('error', (err) => onError?.(err));
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
