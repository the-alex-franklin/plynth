import type { Pool, PoolClient } from 'pg';
import type { PlynthItem, ItemStatus } from '../types';

export async function insertItem(
  pool: Pool,
  id: string,
  encryptedToken: string
): Promise<void> {
  await pool.query(
    `INSERT INTO plynth_items (id, access_token, status)
     VALUES ($1, $2, 'syncing')`,
    [id, encryptedToken]
  );
}

export async function getItem(pool: Pool, id: string): Promise<PlynthItem | null> {
  const result = await pool.query<PlynthItem>(
    `SELECT * FROM plynth_items WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateItemStatus(
  pool: Pool | PoolClient,
  id: string,
  status: ItemStatus
): Promise<void> {
  await pool.query(
    `UPDATE plynth_items SET status = $1, updated_at = now() WHERE id = $2`,
    [status, id]
  );
}

export async function updateItemCursor(
  client: PoolClient,
  id: string,
  cursor: string
): Promise<void> {
  await client.query(
    `UPDATE plynth_items
     SET cursor = $1, last_synced_at = now(), status = 'active', updated_at = now()
     WHERE id = $2`,
    [cursor, id]
  );
}

export async function getItemCursor(pool: Pool, id: string): Promise<string | null> {
  const result = await pool.query<{ cursor: string | null }>(
    `SELECT cursor FROM plynth_items WHERE id = $1`,
    [id]
  );
  return result.rows[0]?.cursor ?? null;
}
