CREATE TABLE IF NOT EXISTS plynth_migrations (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  run_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plynth_items (
  id              TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'syncing',
  cursor          TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plynth_accounts (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES plynth_items(id),
  name        TEXT,
  mask        TEXT,
  type        TEXT,
  subtype     TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plynth_transactions (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL REFERENCES plynth_accounts(id),
  item_id                   TEXT NOT NULL,
  amount                    NUMERIC(12, 2) NOT NULL,
  date                      DATE NOT NULL,
  name                      TEXT,
  merchant_name             TEXT,
  category                  TEXT[],
  personal_finance_category TEXT,
  pending                   BOOLEAN NOT NULL DEFAULT false,
  pending_transaction_id    TEXT,
  currency_code             TEXT NOT NULL DEFAULT 'USD',
  payment_channel           TEXT,
  raw                       JSONB,
  removed_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plynth_webhook_events (
  id            TEXT PRIMARY KEY,
  webhook_type  TEXT NOT NULL,
  webhook_code  TEXT NOT NULL,
  item_id       TEXT,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
