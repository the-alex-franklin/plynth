# Plynth

Plaid transaction sync for Node.js. Wire it up once — Plynth keeps your Postgres database current with no further thought required.

```ts
const plynth = createPlynth({
  plaid: plaidClient,
  connectionString: process.env.DATABASE_URL,
  webhookSecret: process.env.PLAID_WEBHOOK_SECRET,
  encryptionKey: process.env.PLYNTH_ENCRYPTION_KEY,
})

await plynth.migrate()
```

That's it. Query your own tables directly.

---

## How it works

Plynth owns four Postgres tables: `plynth_items`, `plynth_accounts`, `plynth_transactions`, and `plynth_webhook_events`. You never write to them — you just read.

When a user connects their bank via Plaid Link, you call `registerItem` once. Plynth encrypts and stores the access token, kicks off an initial sync in the background, and from then on handles all `SYNC_UPDATES_AVAILABLE` webhooks automatically.

**v1 supports the Transactions product only.**

---

## Install

```bash
npm install plynth
```

Requires Node 20+. Peer dependencies: `plaid`, `pg`.

---

## Setup

### 1. Generate an encryption key

Plynth encrypts access tokens at rest using AES-256-GCM. Generate a 32-byte key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store it in an environment variable. Never commit it.

### 2. Run migrations

```ts
import createPlynth from 'plynth'
import { PlaidApi } from 'plaid'
import { Pool } from 'pg'

const plynth = createPlynth({
  plaid: plaidClient,          // your existing PlaidApi instance
  connectionString: process.env.DATABASE_URL,
  webhookSecret: process.env.PLAID_WEBHOOK_SECRET,
  encryptionKey: process.env.PLYNTH_ENCRYPTION_KEY,
})

await plynth.migrate()
```

`migrate()` is idempotent — safe to call on every deploy.

### 3. Register items

After a user completes Plaid Link and you exchange the public token for an access token:

```ts
await plynth.registerItem({
  itemId: exchangeResponse.item_id,
  accessToken: exchangeResponse.access_token,
})
```

Returns immediately. Initial sync runs in the background.

### 4. Handle webhooks

In your webhook endpoint:

```ts
app.post('/webhooks/plaid', async (req, res) => {
  const result = await plynth.handleWebhook(req.body, req.headers)
  res.status(result.status).send()
})
```

Pass the raw request body (before JSON parsing) and the full headers object. Plynth verifies the Plaid signature, deduplicates events, and handles the rest.

---

## Querying your data

Read directly from Postgres — Plynth doesn't provide query helpers.

```sql
-- Recent transactions for a user
SELECT * FROM plynth_transactions
WHERE account_id = ANY(
  SELECT id FROM plynth_accounts WHERE item_id = $1
)
AND removed_at IS NULL
ORDER BY date DESC
LIMIT 50;

-- Item status
SELECT status FROM plynth_items WHERE id = $1;
```

---

## Configuration

```ts
createPlynth({
  plaid: PlaidApi,                  // required
  connectionString: string,         // required — Postgres connection string
  webhookSecret: string,            // required — from Plaid dashboard
  encryptionKey: string,            // required — base64-encoded 32-byte key

  // Optional: bring your own encryption (e.g. KMS, Vault)
  encrypt: (plaintext: string) => Promise<string>,
  decrypt: (ciphertext: string) => Promise<string>,

  // Optional: error handler (default: console.error)
  onError: (err: Error, context: Record<string, unknown>) => void,
})
```

If you provide `encrypt` and `decrypt`, `encryptionKey` is still required at init but unused — a future version may make it optional when custom functions are provided.

---

## Item lifecycle

| Status | Meaning |
|---|---|
| `syncing` | Initial sync in progress |
| `active` | Syncing normally |
| `pending_expiration` | Access token expiring soon — prompt re-auth |
| `login_required` | Token expired or revoked — re-link required |
| `disconnected` | Terminal. Create a new item to recover. |

When an item disconnects, historical transactions are preserved. Accounts are marked `disconnected`. No data is deleted.

---

## License

MIT
