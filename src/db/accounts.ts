import type { PoolClient, Pool } from 'pg';

export interface UpsertAccountParams {
  id: string;
  item_id: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
}

export async function upsertAccounts(
  client: PoolClient,
  accounts: UpsertAccountParams[]
): Promise<void> {
  for (const acc of accounts) {
    await client.query(
      `INSERT INTO plynth_accounts (id, item_id, name, mask, type, subtype)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         mask = EXCLUDED.mask,
         type = EXCLUDED.type,
         subtype = EXCLUDED.subtype,
         updated_at = now()`,
      [acc.id, acc.item_id, acc.name, acc.mask, acc.type, acc.subtype]
    );
  }
}

export async function disconnectAccountsByItem(
  pool: Pool,
  itemId: string
): Promise<void> {
  await pool.query(
    `UPDATE plynth_accounts
     SET status = 'disconnected', updated_at = now()
     WHERE item_id = $1`,
    [itemId]
  );
}
