import type { PoolClient } from 'pg';
import type { Transaction } from 'plaid';

export async function upsertTransactions(
  client: PoolClient,
  itemId: string,
  transactions: Transaction[]
): Promise<void> {
  for (const txn of transactions) {
    await client.query(
      `INSERT INTO plynth_transactions (
         id, account_id, item_id, amount, date, name, merchant_name,
         category, personal_finance_category, pending, pending_transaction_id,
         currency_code, payment_channel, raw
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         account_id                = EXCLUDED.account_id,
         amount                    = EXCLUDED.amount,
         date                      = EXCLUDED.date,
         name                      = EXCLUDED.name,
         merchant_name             = EXCLUDED.merchant_name,
         category                  = EXCLUDED.category,
         personal_finance_category = EXCLUDED.personal_finance_category,
         pending                   = EXCLUDED.pending,
         pending_transaction_id    = EXCLUDED.pending_transaction_id,
         currency_code             = EXCLUDED.currency_code,
         payment_channel           = EXCLUDED.payment_channel,
         raw                       = EXCLUDED.raw,
         removed_at                = NULL,
         updated_at                = now()`,
      [
        txn.transaction_id,
        txn.account_id,
        itemId,
        txn.amount,
        txn.date,
        txn.name,
        txn.merchant_name ?? null,
        txn.category ?? null,
        txn.personal_finance_category?.primary ?? null,
        txn.pending,
        txn.pending_transaction_id ?? null,
        txn.iso_currency_code ?? 'USD',
        txn.payment_channel ?? null,
        txn,
      ]
    );
  }
}

export async function softDeleteTransactions(
  client: PoolClient,
  transactionIds: string[]
): Promise<void> {
  if (transactionIds.length === 0) return;
  await client.query(
    `UPDATE plynth_transactions
     SET removed_at = now(), updated_at = now()
     WHERE id = ANY($1::text[])`,
    [transactionIds]
  );
}
