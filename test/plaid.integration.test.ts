/**
 * End-to-end tests against Plaid sandbox + real Postgres.
 *
 * Requires:
 *   PLAID_CLIENT_ID, PLAID_SECRET  — sandbox credentials
 *   DATABASE_URL                   — defaults to postgres://localhost/plynth_test
 *
 * Run: npx jest test/plaid.integration.test.ts --no-coverage --testTimeout=30000
 */

import { Configuration, PlaidApi, PlaidEnvironments, Products, SandboxItemFireWebhookRequestWebhookCodeEnum, WebhookType } from 'plaid';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { runMigrations } from '../src/migrate';
import { buildCrypto } from '../src/crypto';
import { syncItem } from '../src/sync';
import { insertItem, getItem } from '../src/db/items';

const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const CONNECTION_STRING = process.env.PLAID_TEST_DATABASE_URL ?? 'postgres://localhost/plynth_plaid_test';

const SKIP = !CLIENT_ID || !SECRET;

const describeOrSkip = SKIP ? describe.skip : describe;

if (SKIP) {
  console.warn('Skipping Plaid integration tests: PLAID_CLIENT_ID / PLAID_SECRET not set');
}

describeOrSkip('Plaid sandbox integration', () => {
  let pool: Pool;
  let plaid: PlaidApi;
  let encrypt: (p: string) => Promise<string>;
  let decrypt: (c: string) => Promise<string>;

  let accessToken: string;
  let itemId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });

    // Fresh schema for this suite
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

    const crypto = buildCrypto(randomBytes(32).toString('base64'));
    encrypt = crypto.encrypt;
    decrypt = crypto.decrypt;

    plaid = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments.sandbox,
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': CLIENT_ID!,
            'PLAID-SECRET': SECRET!,
          },
        },
      })
    );

    // Create a sandbox item and exchange for a real access token.
    // A webhook URL is required to fire sandbox webhooks — any URL works in sandbox.
    const ptRes = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508', // First Platypus Bank — always has transactions
      initial_products: [Products.Transactions],
      options: { webhook: 'https://example.com/webhook' },
    });

    const exchangeRes = await plaid.itemPublicTokenExchange({
      public_token: ptRes.data.public_token,
    });

    accessToken = exchangeRes.data.access_token;
    itemId = exchangeRes.data.item_id;

    // Trigger historical transaction generation in sandbox. DEFAULT_UPDATE causes
    // Plaid to populate transaction data; SyncUpdatesAvailable only fires the webhook.
    // Data is generated async, so we poll until transactions appear (up to ~10s).
    await plaid.sandboxItemFireWebhook({
      access_token: accessToken,
      webhook_type: WebhookType.Transactions,
      webhook_code: SandboxItemFireWebhookRequestWebhookCodeEnum.DefaultUpdate,
    });

    let attempts = 0;
    while (attempts < 10) {
      await new Promise((r) => setTimeout(r, 1000));
      const probe = await plaid.transactionsSync({ access_token: accessToken });
      if (probe.data.added.length > 0) break;
      attempts++;
    }

    // Seed the item row with an encrypted token
    await insertItem(pool, itemId, await encrypt(accessToken));
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

it('syncs transactions into Postgres from a fresh item', async () => {
    const onError = jest.fn();
    const encryptedToken = await encrypt(accessToken);

    await syncItem(itemId, encryptedToken, { plaid, pool, decrypt, onError });

    expect(onError).not.toHaveBeenCalled();

    const txns = await pool.query(
      `SELECT * FROM plynth_transactions WHERE item_id = $1`, [itemId]
    );
    expect(txns.rows.length).toBeGreaterThan(0);
  }, 30_000);

  it('creates account rows linked to the item', async () => {
    const accounts = await pool.query(
      `SELECT * FROM plynth_accounts WHERE item_id = $1`, [itemId]
    );
    expect(accounts.rows.length).toBeGreaterThan(0);
    expect(accounts.rows[0].status).toBe('active');
  });

  it('sets item status to active and stores a cursor after sync', async () => {
    const item = await getItem(pool, itemId);
    expect(item!.status).toBe('active');
    expect(item!.cursor).not.toBeNull();
    expect(item!.last_synced_at).not.toBeNull();
  });

  it('transactions have the expected shape in the DB', async () => {
    const result = await pool.query(
      `SELECT * FROM plynth_transactions WHERE item_id = $1 LIMIT 1`, [itemId]
    );
    const row = result.rows[0];
    expect(row.id).toBeTruthy();
    expect(row.account_id).toBeTruthy();
    expect(row.amount).toBeTruthy();
    expect(row.date).toBeInstanceOf(Date);
    expect(typeof row.pending).toBe('boolean');
    expect(row.currency_code).toBeTruthy();
    expect(row.raw).toBeTruthy(); // JSONB round-trip
    expect(row.removed_at).toBeNull();
  });

  it('is idempotent — syncing again does not duplicate transactions', async () => {
    const before = await pool.query(
      `SELECT COUNT(*) FROM plynth_transactions WHERE item_id = $1`, [itemId]
    );

    const onError = jest.fn();
    await syncItem(itemId, await encrypt(accessToken), { plaid, pool, decrypt, onError });
    expect(onError).not.toHaveBeenCalled();

    const after = await pool.query(
      `SELECT COUNT(*) FROM plynth_transactions WHERE item_id = $1`, [itemId]
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  }, 30_000);
});
