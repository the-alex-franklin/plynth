import type { PlaidApi } from 'plaid';
import type { Pool } from 'pg';
import { getItemCursor, updateItemCursor, updateItemStatus } from './db/items';
import { upsertAccounts } from './db/accounts';
import { upsertTransactions, softDeleteTransactions } from './db/transactions';

interface SyncDeps {
  plaid: PlaidApi;
  pool: Pool;
  decrypt: (ciphertext: string) => Promise<string>;
  onError: (err: Error, context: Record<string, unknown>) => void;
}

export async function syncItem(itemId: string, encryptedToken: string, deps: SyncDeps): Promise<void> {
  const { plaid, pool, decrypt, onError } = deps;

  let cursor: string | undefined;
  try {
    const stored = await getItemCursor(pool, itemId);
    cursor = stored ?? undefined;
  } catch (err) {
    onError(err as Error, { itemId, phase: 'sync:read_cursor' });
    return;
  }

  const accessToken = await decrypt(encryptedToken);

  let hasMore = true;
  while (hasMore) {
    let response;
    try {
      response = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
        options: { include_personal_finance_category: true },
      });
    } catch (err) {
      onError(err as Error, { itemId, phase: 'sync:plaid_api' });
      return;
    }

    const { added, modified, removed, next_cursor, has_more, accounts } = response.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await upsertAccounts(
        client,
        accounts.map((a) => ({
          id: a.account_id,
          item_id: itemId,
          name: a.name ?? null,
          mask: a.mask ?? null,
          type: a.type ?? null,
          subtype: a.subtype ?? null,
        }))
      );

      await upsertTransactions(client, itemId, [...added, ...modified]);
      await softDeleteTransactions(client, removed.map((r) => r.transaction_id));

      if (!has_more) {
        await updateItemCursor(client, itemId, next_cursor);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      onError(err as Error, { itemId, phase: 'sync:db_write' });
      return;
    } finally {
      client.release();
    }

    cursor = next_cursor;
    hasMore = has_more;
  }
}
