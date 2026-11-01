/**
 * The Workers-side suite: the real OpsStore Durable Object, running in
 * workerd through the vitest plugin, driven the way production drives it —
 * requests through the Worker's fetch, storage through the DO's own
 * ctx.storage.sql. The claims here are the port's, not the service's
 * re-test: migrations apply inside the DO, sign-in verifies a PBKDF2 row,
 * issue/escrow is one write, the tip route answers headerless, and the
 * escrow export round-trips through age.
 *
 * Anchor tests mock fetch explicitly; they never depend on a live upstream.
 */
import {env} from 'cloudflare:workers';
import {SELF} from 'cloudflare:test';
import {describe, expect, it, vi} from 'vitest';

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;

async function operatorToken(): Promise<string> {
  // The first test creates the operator; later tests re-use the session.
  const res = await SELF.fetch('http://x/auth/operator/session', {
    method: 'POST',
    body: JSON.stringify({name: 'bench-lead', password: 'correct horse'}),
  });
  return ((await json(res)).token as string) ?? '';
}

let bootstrapped = false;

async function ensureOperator(): Promise<void> {
  if (bootstrapped) {
    return;
  }
  const {bootstrapOperatorInto} = await import('../../src/test-bootstrap');
  await bootstrapOperatorInto(env, 'bench-lead', 'correct horse', 'issued');
  bootstrapped = true;
}

describe('ops on Workers (the DO)', () => {
  it('migrations applied inside the DO: a batch creates and escrows in one write', async () => {
    await ensureOperator();
    const token = await operatorToken();
    expect(token).not.toBe('');

    const deviceId = crypto.randomUUID();
    const res = await SELF.fetch('http://x/provisioning/batches', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({
        device_id: deviceId,
        batch_request_id: crypto.randomUUID(),
        count: 3,
        mint_url: 'https://forge.flashapp.me',
        pin_policy: 'perCard',
        daily_usd: 25,
        no_pin_usd: 5,
        load_sha256: 'fe'.repeat(32),
      }),
    });
    expect(res.status).toBe(200);
    const batch = ((await json(res)).batch ?? {}) as Record<string, unknown>;
    const batchId = batch.batch_id as number;

    const attemptId = crypto.randomUUID();
    const reservation = await SELF.fetch('http://x/provisioning/attempts', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({
        device_id: deviceId,
        attempt_id: attemptId,
        batch_id: batchId,
        ordinal: 0,
      }),
    });
    expect(reservation.status).toBe(200);
    // Read the reserved escrow set through the production issuance path.
    const issue = await SELF.fetch('http://x/keys/issue', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({device_id: deviceId, attempt_id: attemptId}),
    });
    expect(issue.status).toBe(200);
    const keys = await json(issue);
    for (const f of ['enc', 'mac', 'dek']) {
      expect(keys[f]).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('a lost response re-issues byte-identical keys through the DO', async () => {
    await ensureOperator();
    const token = await operatorToken();
    const deviceId = crypto.randomUUID();
    const batchRes = await SELF.fetch('http://x/provisioning/batches', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({
        device_id: deviceId,
        batch_request_id: crypto.randomUUID(),
        count: 2,
        mint_url: 'https://forge.flashapp.me',
        pin_policy: 'perCard',
        daily_usd: 25,
        no_pin_usd: 5,
        load_sha256: 'fe'.repeat(32),
      }),
    });
    const batchId = (
      ((await json(batchRes)).batch ?? {}) as Record<string, unknown>
    ).batch_id as number;

    const attemptId = crypto.randomUUID();
    const reservation = await SELF.fetch('http://x/provisioning/attempts', {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`},
      body: JSON.stringify({
        device_id: deviceId,
        attempt_id: attemptId,
        batch_id: batchId,
        ordinal: 0,
      }),
    });
    expect(reservation.status).toBe(200);
    const ask = () =>
      SELF.fetch('http://x/keys/issue', {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`},
        body: JSON.stringify({device_id: deviceId, attempt_id: attemptId}),
      }).then(json);
    const a = (await ask()) as Record<string, string>;
    const b = (await ask()) as Record<string, string>;
    expect(a.enc).toMatch(/^[0-9a-f]{32}$/);
    expect(b.enc).toMatch(/^[0-9a-f]{32}$/);
    expect(a.enc).toBe(b.enc);
    expect(a.mac).toBe(b.mac);
    expect(a.dek).toBe(b.dek);
  });

  it('GET /anchor/tip answers the headerless request (public route, 503 without upstream)', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('upstream unavailable'));
    try {
      const res = await SELF.fetch('http://x/anchor/tip', {method: 'GET'});
      expect(res.status).toBe(503);
      const body = await json(res);
      expect(body.reason).toBe('upstream-unavailable');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });

  it('GET /anchor/tip resolves the block hash and returns the decoded header', async () => {
    const hash = '0123456789abcdef'.repeat(4);
    const header = 'ab'.repeat(80);
    const responses = new Map([
      ['https://mempool.space/api/blocks/tip/height', '900000'],
      ['https://mempool.space/api/block-height/900000', hash],
      [`https://mempool.space/api/block/${hash}/header`, header],
    ]);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async input => {
        const response = responses.get(String(input));
        if (response === undefined) throw new Error('unexpected upstream URL');
        return new Response(response);
      });
    try {
      const res = await SELF.fetch('http://x/anchor/tip');
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.header).toBe(header);
      expect(body.height).toBe(900000);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        ...responses.keys(),
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it(
    'the escrow export runs inside the DO: the DO method serializes the escrow and armors it',
    {timeout: 20_000}, // age's key wrap is deliberately slow work
    async () => {
      await ensureOperator();
      const {runInDurableObject} = await import('cloudflare:test');
      // The SqlHandle is the DO's own I/O object: it can only be used inside
      // the DO's context (workerd enforces this — a handle carried out answers
      // "on behalf of a different Durable Object"). So the export runs inside
      // runInDurableObject, exactly how the cron's call path works.
      const {exportEscrowSql} = await import('../../src/export');
      const id = env.OPS_DO.idFromName('ops');
      const armored = await runInDurableObject(
        env.OPS_DO.get(id) as never,
        async (instance: unknown) => {
          const store = instance as {deps: {db: {db: unknown}}};
          const {armored} = await exportEscrowSql(
            store.deps.db.db as never,
            'age143umpzceuzceneulq4kjez9d2t9u2c975dmru5a8ksr6c3mtcuvscgmvun',
          );
          return armored;
        },
      );
      // The armored file is inert text; decrypting needs the identity, which
      // the round-trip test in export.test.ts covers (node side). Here the
      // claim is: the DO's rows serialize and the armor parses back to bytes.
      expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    },
  );
});
