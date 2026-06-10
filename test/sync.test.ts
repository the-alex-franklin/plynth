import { syncItem } from '../src/sync';
import type { Pool, PoolClient } from 'pg';
import type { PlaidApi } from 'plaid';

function makeTransaction(id: string, accountId = 'acct_1') {
  return {
    transaction_id: id,
    account_id: accountId,
    amount: 42.0,
    date: '2024-01-15',
    name: 'Coffee Shop',
    merchant_name: null,
    category: null,
    personal_finance_category: null,
    pending: false,
    pending_transaction_id: null,
    iso_currency_code: 'USD',
    payment_channel: 'in store',
  };
}

function makeSyncResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      added: [],
      modified: [],
      removed: [],
      accounts: [],
      next_cursor: 'cursor_abc',
      has_more: false,
      ...overrides,
    },
  };
}

function makeClient() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  } as unknown as PoolClient & { query: jest.Mock; release: jest.Mock };
  return client;
}

function makeDeps(syncPages: ReturnType<typeof makeSyncResponse>[]) {
  const client = makeClient();
  let pageIndex = 0;

  const pool = {
    query: jest.fn().mockResolvedValue({ rows: [{ cursor: null }], rowCount: 1 }),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool & { query: jest.Mock; connect: jest.Mock };

  const plaid = {
    transactionsSync: jest.fn().mockImplementation(() => {
      return Promise.resolve(syncPages[pageIndex++]);
    }),
  } as unknown as PlaidApi;

  const decrypt = jest.fn().mockResolvedValue('access-token-plain');
  const onError = jest.fn();

  return { pool, plaid, decrypt, onError, client };
}

describe('syncItem', () => {
  it('calls transactionsSync with decrypted access token', async () => {
    const deps = makeDeps([makeSyncResponse()]);
    await syncItem('item_1', 'encrypted-token', deps);
    expect(deps.decrypt).toHaveBeenCalledWith('encrypted-token');
    expect(deps.plaid.transactionsSync).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'access-token-plain' })
    );
  });

  it('pages through until has_more is false', async () => {
    const deps = makeDeps([
      makeSyncResponse({ has_more: true, next_cursor: 'cursor_1' }),
      makeSyncResponse({ has_more: true, next_cursor: 'cursor_2' }),
      makeSyncResponse({ has_more: false, next_cursor: 'cursor_3' }),
    ]);
    await syncItem('item_1', 'enc', deps);
    expect(deps.plaid.transactionsSync).toHaveBeenCalledTimes(3);
  });

  it('passes next_cursor as cursor on subsequent pages', async () => {
    const deps = makeDeps([
      makeSyncResponse({ has_more: true, next_cursor: 'cursor_page1' }),
      makeSyncResponse({ has_more: false, next_cursor: 'cursor_page2' }),
    ]);
    await syncItem('item_1', 'enc', deps);
    expect(deps.plaid.transactionsSync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'cursor_page1' })
    );
  });

  it('wraps each page in a db transaction', async () => {
    const deps = makeDeps([
      makeSyncResponse({ has_more: true, next_cursor: 'c1' }),
      makeSyncResponse({ has_more: false, next_cursor: 'c2' }),
    ]);
    await syncItem('item_1', 'enc', deps);
    const clientCalls = deps.client.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(clientCalls.filter((s: unknown) => s === 'BEGIN').length).toBe(2);
    expect(clientCalls.filter((s: unknown) => s === 'COMMIT').length).toBe(2);
  });

  it('only updates cursor on the final page', async () => {
    const deps = makeDeps([
      makeSyncResponse({ has_more: true, next_cursor: 'interim' }),
      makeSyncResponse({ has_more: false, next_cursor: 'final' }),
    ]);
    await syncItem('item_1', 'enc', deps);
    const cursorUpdates = deps.client.query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('cursor') && Array.isArray(c[1]) && (c[1] as unknown[]).includes('final')
    );
    expect(cursorUpdates.length).toBe(1);
    const interimUpdates = deps.client.query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('cursor') && Array.isArray(c[1]) && (c[1] as unknown[]).includes('interim')
    );
    expect(interimUpdates.length).toBe(0);
  });

  it('does not update cursor if Plaid API call fails midway', async () => {
    const deps = makeDeps([
      makeSyncResponse({ has_more: true, next_cursor: 'c1' }),
    ]);
    (deps.plaid.transactionsSync as jest.Mock)
      .mockResolvedValueOnce(makeSyncResponse({ has_more: true, next_cursor: 'c1' }))
      .mockRejectedValueOnce(new Error('Plaid 500'));

    await syncItem('item_1', 'enc', deps);

    expect(deps.onError).toHaveBeenCalled();
    const cursorUpdates = deps.client.query.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('cursor')
    );
    expect(cursorUpdates.length).toBe(0);
  });

  it('rolls back and calls onError if db write fails', async () => {
    const deps = makeDeps([makeSyncResponse({ added: [makeTransaction('txn_1')] })]);
    deps.client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error('db constraint'))  // upsert fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await syncItem('item_1', 'enc', deps);

    expect(deps.onError).toHaveBeenCalled();
    const clientCalls = deps.client.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(clientCalls).toContain('ROLLBACK');
  });

  it('soft-deletes removed transactions', async () => {
    const deps = makeDeps([
      makeSyncResponse({ removed: [{ transaction_id: 'txn_gone' }] }),
    ]);
    await syncItem('item_1', 'enc', deps);
    const calls = deps.client.query.mock.calls as unknown[][];
    const softDelete = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('removed_at')
    );
    expect(softDelete).toBeDefined();
  });
});
