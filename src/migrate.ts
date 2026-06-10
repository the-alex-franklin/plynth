import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const MIGRATIONS: string[] = ['001_initial.sql'];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plynth_migrations (
      id      SERIAL PRIMARY KEY,
      name    TEXT NOT NULL UNIQUE,
      run_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const name of MIGRATIONS) {
    const result = await pool.query(
      `SELECT 1 FROM plynth_migrations WHERE name = $1`,
      [name]
    );
    if ((result.rowCount ?? 0) > 0) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    await pool.query(sql);
    await pool.query(
      `INSERT INTO plynth_migrations (name) VALUES ($1)`,
      [name]
    );
  }
}
