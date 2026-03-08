import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureMigrationsTable() {
  await query(`
    create table if not exists schema_migrations (
      id serial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    );
  `);
}

export async function runMigrations() {
  await ensureMigrationsTable();
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await query(
      'select 1 from schema_migrations where filename = $1',
      [file]
    );
    if (existing.rowCount > 0) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        'insert into schema_migrations (filename) values ($1)',
        [file]
      );
      await client.query('commit');
      console.log(`Applied migration ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`Migration failed: ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}
