import { createPool } from './db/client';
import { buildCrypto } from './crypto';
import { runMigrations } from './migrate';
import { insertItem, getItem } from './db/items';
import { handleWebhook as _handleWebhook } from './webhook';
import { syncItem } from './sync';
import type { PlynthConfig, PlynthInstance } from './types';

export default function createPlynth(config: PlynthConfig): PlynthInstance {
  const {
    plaid,
    connectionString,
    webhookSecret,
    encryptionKey,
    onError = (err, ctx) => console.error('[plynth]', err, ctx),
  } = config;

  if (!encryptionKey) {
    throw new Error('Plynth: encryptionKey is required');
  }

  const defaultCrypto = buildCrypto(encryptionKey);
  const encrypt = config.encrypt ?? defaultCrypto.encrypt;
  const decrypt = config.decrypt ?? defaultCrypto.decrypt;

  const pool = createPool(connectionString);

  async function migrate(): Promise<void> {
    await runMigrations(pool);
  }

  async function registerItem(opts: { itemId: string; accessToken: string }): Promise<void> {
    const { itemId, accessToken } = opts;
    const encryptedToken = await encrypt(accessToken);
    await insertItem(pool, itemId, encryptedToken);

    // Fire and forget — errors go to onError
    void syncItem(itemId, encryptedToken, { plaid, pool, decrypt, onError }).catch((err: Error) => {
      onError(err, { itemId, phase: 'registerItem:sync' });
    });
  }

  async function handleWebhook(
    body: string | Buffer,
    headers: Record<string, string>
  ): Promise<{ status: number }> {
    return _handleWebhook(body, headers, { pool, plaid, webhookSecret, decrypt, onError });
  }

  return { migrate, registerItem, handleWebhook };
}

export type { PlynthConfig, PlynthInstance };
