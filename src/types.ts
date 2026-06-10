import type { PlaidApi } from 'plaid';

export type ItemStatus =
  | 'syncing'
  | 'active'
  | 'pending_expiration'
  | 'login_required'
  | 'disconnected';

export type AccountStatus = 'active' | 'disconnected';

export interface PlynthConfig {
  plaid: PlaidApi;
  connectionString: string;
  webhookSecret: string;
  encryptionKey: string;
  encrypt?: (plaintext: string) => Promise<string>;
  decrypt?: (ciphertext: string) => Promise<string>;
  onError?: (err: Error, context: Record<string, unknown>) => void;
}

export interface PlynthInstance {
  migrate: () => Promise<void>;
  registerItem: (opts: { itemId: string; accessToken: string }) => Promise<void>;
  handleWebhook: (
    body: string | Buffer,
    headers: Record<string, string>
  ) => Promise<{ status: number }>;
}

export interface PlynthItem {
  id: string;
  access_token: string;
  status: ItemStatus;
  cursor: string | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlynthAccount {
  id: string;
  item_id: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  status: AccountStatus;
  created_at: Date;
  updated_at: Date;
}
