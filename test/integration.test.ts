/**
 * Integration tests against a real Postgres instance.
 * Requires DATABASE_URL or falls back to postgres://localhost/plynth_test.
 *
 * Run: npx jest test/integration.test.ts --no-coverage
 */

import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { insertItem, getItem, updateItemStatus, updateItemCursor, getItemCursor } from '../src/db/items';
import { upsertAccounts } from '../src/db/accounts';
import { upsertTransactions, softDeleteTransactions } from '../src/db/transactions';
import { insertWebhookEvent } from '../src/db/events';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgres://localhost/plynth_test';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONNECTION_STRING });
  await pool.query(`
    DROP TABLE IF EXISTS
      plynth_transactions,
      plynth_accounts,
      plynth_webhook_events,
      plynth_items,
      plynth_migrations
    CASCADE
  `);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedItem(id = 'item_test_1', token = 'enc_token') {
  await insertItem(pool, id, token);
  return id;
}

async function seedAccount(itemId: string, accountId = 'acct_test_1') {
  const client = await pool.connect();
  try {
    await upsertAccounts(client, [{
      id: accountId,
      item_id: itemId,
      name: 'Checking',
      mask: '0000',
      type: 'depository',
      subtype: 'checking',
    }]);
  } finally {
    client.release();
  }
  return accountId;
}

// Minimal shape matching Plaid's Transaction type for what we actually use
function makePlaidTransaction(id: string, accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    account_id: accountId,
    amount: 12.34,
    date: '2024-03-15',
    name: 'Blue Bottle Coffee',
    merchant_name: 'Blue Bottle',
    category: ['Food and Drink', 'Coffee Shop'],
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    pending: false,
    pending_transaction_id: null,
    iso_currency_code: 'USD',
    payment_channel: 'in store',
    ...overrides,
  } as Parameters<typeof upsertTransactions>[2][number];
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('migrations', () => {
  it('creates all four plynth tables', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'plynth_%'
      ORDER BY table_name
    `);
    const names = result.rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toContain('plynth_items');
    expect(names).toContain('plynth_accounts');
    expect(names).toContain('plynth_transactions');
    expect(names).toContain('plynth_webhook_events');
  });

  it('is idempotent — running twice does not throw', async () => {
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe('plynth_items', () => {
  it('inserts and retrieves an item', async () => {
    await seedItem('item_i1', 'enc_abc');
    const item = await getItem(pool, 'item_i1');
    expect(item).not.toBeNull();
    expect(item!.status).toBe('syncing');
    expect(item!.access_token).toBe('enc_abc');
    expect(item!.cursor).toBeNull();
  });

  it('updates item status', async () => {
    await seedItem('item_i2');
    await updateItemStatus(pool, 'item_i2', 'active');
    const item = await getItem(pool, 'item_i2');
    expect(item!.status).toBe('active');
  });

  it('updates cursor and sets status to active', async () => {
    await seedItem('item_i3');
    const client = await pool.connect();
    try {
      await updateItemCursor(client, 'item_i3', 'cursor_xyz');
    } finally {
      client.release();
    }
    const cursor = await getItemCursor(pool, 'item_i3');
    expect(cursor).toBe('cursor_xyz');
    const item = await getItem(pool, 'item_i3');
    expect(item!.status).toBe('active');
    expect(item!.last_synced_at).not.toBeNull();
  });

  it('returns null for a missing item', async () => {
    const item = await getItem(pool, 'item_does_not_exist');
    expect(item).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('plynth_accounts', () => {
  it('upserts an account', async () => {
    const itemId = await seedItem('item_a1');
    await seedAccount(itemId, 'acct_a1');
    const result = await pool.query(
      `SELECT * FROM plynth_accounts WHERE id = $1`, ['acct_a1']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Checking');
    expect(result.rows[0].type).toBe('depository');
  });

  it('updates an existing account on conflict', async () => {
    const itemId = await seedItem('item_a2');
    await seedAccount(itemId, 'acct_a2');

    const client = await pool.connect();
    try {
      await upsertAccounts(client, [{
        id: 'acct_a2',
        item_id: itemId,
        name: 'Updated Checking',
        mask: '1111',
        type: 'depository',
        subtype: 'checking',
      }]);
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT name, mask FROM plynth_accounts WHERE id = $1`, ['acct_a2']
    );
    expect(result.rows[0].name).toBe('Updated Checking');
    expect(result.rows[0].mask).toBe('1111');
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('plynth_transactions', () => {
  let itemId: string;
  let accountId: string;

  beforeEach(async () => {
    const id = `item_t_${Date.now()}`;
    itemId = await seedItem(id);
    accountId = await seedAccount(itemId, `acct_t_${Date.now()}`);
  });

  it('upserts a transaction with all fields', async () => {
    const client = await pool.connect();
    try {
      await upsertTransactions(client, itemId, [
        makePlaidTransaction('txn_full', accountId),
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT * FROM plynth_transactions WHERE id = $1`, ['txn_full']
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.amount).toBe('12.34');
    expect(row.name).toBe('Blue Bottle Coffee');
    expect(row.merchant_name).toBe('Blue Bottle');
    expect(row.category).toEqual(['Food and Drink', 'Coffee Shop']);
    expect(row.personal_finance_category).toBe('FOOD_AND_DRINK');
    expect(row.pending).toBe(false);
    expect(row.currency_code).toBe('USD');
    expect(row.payment_channel).toBe('in store');
    expect(row.raw).toMatchObject({ transaction_id: 'txn_full' });
    expect(row.removed_at).toBeNull();
  });

  it('upserts a pending transaction and updates it when settled', async () => {
    const client = await pool.connect();
    try {
      await upsertTransactions(client, itemId, [
        makePlaidTransaction('txn_pending', accountId, {
          pending: true,
          pending_transaction_id: null,
        }),
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const client2 = await pool.connect();
    try {
      await upsertTransactions(client2, itemId, [
        makePlaidTransaction('txn_pending', accountId, {
          pending: false,
          name: 'Settled Coffee',
        }),
      ]);
      await client2.query('COMMIT');
    } finally {
      client2.release();
    }

    const result = await pool.query(
      `SELECT pending, name FROM plynth_transactions WHERE id = $1`, ['txn_pending']
    );
    expect(result.rows[0].pending).toBe(false);
    expect(result.rows[0].name).toBe('Settled Coffee');
  });

  it('soft-deletes removed transactions without destroying the row', async () => {
    const client = await pool.connect();
    try {
      await upsertTransactions(client, itemId, [
        makePlaidTransaction('txn_remove', accountId),
      ]);
      await softDeleteTransactions(client, ['txn_remove']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT removed_at FROM plynth_transactions WHERE id = $1`, ['txn_remove']
    );
    expect(result.rows[0].removed_at).not.toBeNull();
  });

  it('upsert clears removed_at if a removed transaction reappears', async () => {
    const client = await pool.connect();
    try {
      await upsertTransactions(client, itemId, [makePlaidTransaction('txn_revive', accountId)]);
      await softDeleteTransactions(client, ['txn_revive']);
      await upsertTransactions(client, itemId, [makePlaidTransaction('txn_revive', accountId)]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT removed_at FROM plynth_transactions WHERE id = $1`, ['txn_revive']
    );
    expect(result.rows[0].removed_at).toBeNull();
  });

  it('handles null iso_currency_code by defaulting to USD', async () => {
    const client = await pool.connect();
    try {
      await upsertTransactions(client, itemId, [
        makePlaidTransaction('txn_nocurrency', accountId, { iso_currency_code: null }),
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query(
      `SELECT currency_code FROM plynth_transactions WHERE id = $1`, ['txn_nocurrency']
    );
    expect(result.rows[0].currency_code).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// Webhook events (idempotency)
// ---------------------------------------------------------------------------

describe('plynth_webhook_events', () => {
  it('inserts a new event and returns inserted: true', async () => {
    const { inserted } = await insertWebhookEvent(pool, {
      id: 'evt_1',
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'item_x',
    });
    expect(inserted).toBe(true);
  });

  it('returns inserted: false for a duplicate event id', async () => {
    await insertWebhookEvent(pool, {
      id: 'evt_2',
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'item_x',
    });
    const { inserted } = await insertWebhookEvent(pool, {
      id: 'evt_2',
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'item_x',
    });
    expect(inserted).toBe(false);
  });
});
