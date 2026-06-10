import { createHmac, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';
import type { PlaidApi } from 'plaid';
import { insertWebhookEvent } from './db/events';
import { updateItemStatus, getItem } from './db/items';
import { disconnectAccountsByItem } from './db/accounts';
import { syncItem } from './sync';

// Error codes from Plaid that indicate a disconnected item
const DISCONNECT_ERROR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ACCESS_NOT_GRANTED',
  'USER_PERMISSION_REVOKED',
]);

interface WebhookDeps {
  pool: Pool;
  plaid: PlaidApi;
  webhookSecret: string;
  decrypt: (ciphertext: string) => Promise<string>;
  onError: (err: Error, context: Record<string, unknown>) => void;
}

export async function handleWebhook(
  body: string | Buffer,
  headers: Record<string, string>,
  deps: WebhookDeps
): Promise<{ status: number }> {
  const { pool, plaid, webhookSecret, decrypt, onError } = deps;

  const bodyStr = typeof body === 'string' ? body : body.toString('utf8');

  if (!verifySignature(bodyStr, headers, webhookSecret)) {
    return { status: 401 };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyStr) as Record<string, unknown>;
  } catch {
    return { status: 200 };
  }

  const webhookType = payload['webhook_type'] as string | undefined;
  const webhookCode = payload['webhook_code'] as string | undefined;
  const itemId = payload['item_id'] as string | undefined;
  const eventId = buildEventId(payload);

  if (!webhookType || !webhookCode || !eventId) {
    return { status: 200 };
  }

  let inserted: boolean;
  try {
    ({ inserted } = await insertWebhookEvent(pool, {
      id: eventId,
      webhook_type: webhookType,
      webhook_code: webhookCode,
      item_id: itemId ?? null,
    }));
  } catch (err) {
    onError(err as Error, { phase: 'webhook:insert_event', webhookType, webhookCode, itemId });
    return { status: 200 };
  }

  if (!inserted) return { status: 200 };

  try {
    await route({ webhookType, webhookCode, itemId, payload, pool, plaid, decrypt, onError });
  } catch (err) {
    onError(err as Error, { phase: 'webhook:route', webhookType, webhookCode, itemId });
  }

  return { status: 200 };
}

async function route(opts: {
  webhookType: string;
  webhookCode: string;
  itemId: string | undefined;
  payload: Record<string, unknown>;
  pool: Pool;
  plaid: PlaidApi;
  decrypt: (ciphertext: string) => Promise<string>;
  onError: (err: Error, context: Record<string, unknown>) => void;
}): Promise<void> {
  const { webhookType, webhookCode, itemId, pool, plaid, decrypt, onError } = opts;

  if (webhookType === 'TRANSACTIONS' && webhookCode === 'SYNC_UPDATES_AVAILABLE') {
    if (!itemId) return;
    const item = await getItem(pool, itemId);
    if (!item) return;
    await syncItem(itemId, item.access_token, { plaid, pool, decrypt, onError });
    return;
  }

  if (webhookType === 'ITEM') {
    if (!itemId) return;

    if (webhookCode === 'PENDING_EXPIRATION') {
      await updateItemStatus(pool, itemId, 'pending_expiration');
      return;
    }

    if (webhookCode === 'USER_PERMISSION_REVOKED') {
      await disconnectItem(pool, itemId);
      return;
    }

    if (webhookCode === 'ERROR') {
      const error = opts.payload['error'] as Record<string, unknown> | undefined;
      const errorCode = error?.['error_code'] as string | undefined;
      if (errorCode && DISCONNECT_ERROR_CODES.has(errorCode)) {
        await disconnectItem(pool, itemId);
      } else {
        await updateItemStatus(pool, itemId, 'login_required');
      }
      return;
    }
  }
}

async function disconnectItem(pool: Pool, itemId: string): Promise<void> {
  await updateItemStatus(pool, itemId, 'disconnected');
  await disconnectAccountsByItem(pool, itemId);
}

function verifySignature(
  body: string,
  headers: Record<string, string>,
  secret: string
): boolean {
  // Plaid sends the signature in plaid-verification header
  const sigHeader =
    headers['plaid-verification'] ??
    headers['Plaid-Verification'] ??
    headers['PLAID-VERIFICATION'];

  if (!sigHeader) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function buildEventId(payload: Record<string, unknown>): string | null {
  // Use item_id + webhook_type + webhook_code + timestamp for a stable idempotency key.
  // Plaid doesn't guarantee a unique event id field in all webhook types.
  const type = payload['webhook_type'];
  const code = payload['webhook_code'];
  const itemId = payload['item_id'] ?? 'none';
  const ts = payload['timestamp'];

  if (!type || !code || !ts) return null;
  return `${itemId}:${type}:${code}:${ts}`;
}
