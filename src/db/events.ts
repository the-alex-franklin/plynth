import type { Pool } from 'pg';

export interface WebhookEventParams {
  id: string;
  webhook_type: string;
  webhook_code: string;
  item_id: string | null;
}

export async function insertWebhookEvent(
  pool: Pool,
  event: WebhookEventParams
): Promise<{ inserted: boolean }> {
  const result = await pool.query(
    `INSERT INTO plynth_webhook_events (id, webhook_type, webhook_code, item_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.webhook_type, event.webhook_code, event.item_id]
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}
