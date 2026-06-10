import { createHmac } from 'crypto';
import { handleWebhook } from '../src/webhook';
import type { Pool } from 'pg';
import type { PlaidApi } from 'plaid';

const SECRET = 'test-webhook-secret';

function sign(body: string): Record<string, string> {
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  return { 'plaid-verification': sig };
}

function makePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'item_123',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  });
}

function makeDeps(overrides: Partial<Parameters<typeof handleWebhook>[2]> = {}) {
  const insertWebhookEvent = jest.fn().mockResolvedValue({ inserted: true });
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

  const pool = {
    query,
  } as unknown as Pool;

  const plaid = {} as unknown as PlaidApi;
  const decrypt = jest.fn().mockResolvedValue('access-token');
  const onError = jest.fn();

  return {
    pool,
    plaid,
    webhookSecret: SECRET,
    decrypt,
    onError,
    _query: query,
    ...overrides,
  };
}

describe('handleWebhook', () => {
  describe('signature verification', () => {
    it('returns 401 when signature is missing', async () => {
      const body = makePayload();
      const deps = makeDeps();
      const result = await handleWebhook(body, {}, deps);
      expect(result.status).toBe(401);
    });

    it('returns 401 when signature is wrong', async () => {
      const body = makePayload();
      const deps = makeDeps();
      const result = await handleWebhook(body, { 'plaid-verification': 'deadbeef' }, deps);
      expect(result.status).toBe(401);
    });

    it('returns 200 when signature is valid', async () => {
      const body = makePayload();
      const deps = makeDeps();
      // mock insertWebhookEvent via pool.query
      deps._query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // insert
      deps._query.mockResolvedValueOnce({ rows: [{ access_token: 'enc', status: 'active' }], rowCount: 1 }); // getItem
      const result = await handleWebhook(body, sign(body), deps);
      expect(result.status).toBe(200);
    });
  });

  describe('idempotency', () => {
    it('returns 200 and skips routing when event already processed', async () => {
      const body = makePayload();
      const deps = makeDeps();
      // insertWebhookEvent returns rowCount 0 → already processed
      deps._query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const onError = jest.fn();
      const result = await handleWebhook(body, sign(body), { ...deps, onError });
      expect(result.status).toBe(200);
      expect(onError).not.toHaveBeenCalled();
      // getItem should NOT have been called (routing skipped)
      expect(deps._query).toHaveBeenCalledTimes(1);
    });

    it('processes the same payload exactly once when sent twice', async () => {
      const body = makePayload();
      const deps = makeDeps();

      // First call: event inserted
      deps._query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // insert → inserted
        .mockResolvedValueOnce({ rows: [{ id: 'item_123', access_token: 'enc', status: 'active', cursor: null }], rowCount: 1 }); // getItem

      await handleWebhook(body, sign(body), deps);
      const firstCallCount = deps._query.mock.calls.length;

      // Second call: duplicate, insert returns 0
      deps._query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await handleWebhook(body, sign(body), deps);
      // Only one extra query (the insert), no routing queries
      expect(deps._query.mock.calls.length).toBe(firstCallCount + 1);
    });
  });

  describe('routing', () => {
    async function routeWebhook(
      type: string,
      code: string,
      extra: Record<string, unknown> = {}
    ) {
      const body = makePayload({ webhook_type: type, webhook_code: code, ...extra });
      const deps = makeDeps();
      deps._query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert event
        .mockResolvedValue({ rows: [], rowCount: 1 });    // any subsequent queries
      await handleWebhook(body, sign(body), deps);
      return deps._query.mock.calls as unknown[][];
    }

    function queriedParams(calls: unknown[][]): string[] {
      return calls.flatMap((c) => (Array.isArray(c[1]) ? c[1] : []) as string[]);
    }

    function queriedSqls(calls: unknown[][]): string[] {
      return calls.map((c) => (c[0] as string).replace(/\s+/g, ' ').trim());
    }

    it('TRANSACTIONS/SYNC_UPDATES_AVAILABLE fetches the item for sync', async () => {
      const calls = await routeWebhook('TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE');
      expect(queriedSqls(calls).some((s) => s.includes('plynth_items') && s.includes('SELECT'))).toBe(true);
    });

    it('ITEM/PENDING_EXPIRATION updates status to pending_expiration', async () => {
      const calls = await routeWebhook('ITEM', 'PENDING_EXPIRATION');
      expect(queriedParams(calls)).toContain('pending_expiration');
    });

    it('ITEM/USER_PERMISSION_REVOKED disconnects item and accounts', async () => {
      const calls = await routeWebhook('ITEM', 'USER_PERMISSION_REVOKED');
      const sqls = queriedSqls(calls);
      // items status is parameterized; accounts status is hardcoded in SQL
      expect(queriedParams(calls)).toContain('disconnected');
      expect(sqls.some((s) => s.includes('plynth_accounts') && s.includes('disconnected'))).toBe(true);
    });

    it('ITEM/ERROR with disconnect code disconnects item and accounts', async () => {
      const calls = await routeWebhook('ITEM', 'ERROR', {
        error: { error_code: 'ITEM_LOGIN_REQUIRED' },
      });
      const sqls = queriedSqls(calls);
      expect(queriedParams(calls)).toContain('disconnected');
      expect(sqls.some((s) => s.includes('plynth_accounts') && s.includes('disconnected'))).toBe(true);
    });

    it('ITEM/ERROR with non-disconnect code sets login_required', async () => {
      const calls = await routeWebhook('ITEM', 'ERROR', {
        error: { error_code: 'SOME_OTHER_ERROR' },
      });
      expect(queriedParams(calls)).toContain('login_required');
    });

    it('returns 200 and calls onError if routing throws', async () => {
      const body = makePayload({ webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION' });
      const deps = makeDeps();
      deps._query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // insert event
        .mockRejectedValueOnce(new Error('db exploded'));   // updateItemStatus throws
      const result = await handleWebhook(body, sign(body), deps);
      expect(result.status).toBe(200);
      expect(deps.onError).toHaveBeenCalled();
    });
  });
});
