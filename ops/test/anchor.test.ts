/**
 * The anchor tip: 80-byte validation, the 60 s cache, and upstream failure
 * → 503-shaped answer carrying the last-good header. The fetcher is
 * injected — no network in this suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {AnchorFeed, CACHE_SECONDS, HEADER_LEN} from '../src/anchor';

const HEADER = Buffer.alloc(HEADER_LEN, 0xab);
const HASH = '0123456789abcdef'.repeat(4);
const HASH_BODY = Buffer.from(HASH);
const HEADER_BODY = Buffer.from(HEADER.toString('hex'));
let clock = 1_000_000;

function feed(
  responses: Map<string, Buffer | Error>,
  opts: {now?: () => number} = {},
): AnchorFeed & {calls: number} {
  let calls = 0;
  const fetcher = async (url: string): Promise<Buffer> => {
    calls++;
    const r = responses.get(url);
    if (!r) {
      throw new Error('unexpected url ' + url);
    }
    if (r instanceof Error) {
      throw r;
    }
    return r;
  };
  const f = new AnchorFeed(fetcher, opts.now ?? (() => clock)) as AnchorFeed & {
    calls: number;
  };
  Object.defineProperty(f, 'calls', {get: () => calls});
  return f;
}

const heightOf = (h: number) => Buffer.from(String(h), 'ascii');
const TIP_URL = 'https://mempool.space/api/blocks/tip/height';
const blockUrl = (h: number) => `https://mempool.space/api/block-height/${h}`;
const HEADER_URL = `https://mempool.space/api/block/${HASH}/header`;

test('a good tip is an 80-byte header with its height', async () => {
  const f = feed(
    new Map([
      [TIP_URL, heightOf(900_000)],
      [blockUrl(900_000), HASH_BODY],
      [HEADER_URL, HEADER_BODY],
    ]),
  );
  const r = await f.tip();
  assert.ok(r.ok);
  assert.ok(r.ok && r.tip.header.equals(HEADER));
  assert.ok(r.ok && r.tip.height === 900_000);
});

test('a wrong-length header is rejected (shape validation, cardctl parity)', async () => {
  const f = feed(
    new Map([
      [TIP_URL, heightOf(900_000)],
      [blockUrl(900_000), HASH_BODY],
      [HEADER_URL, Buffer.from('ab'.repeat(79))],
    ]),
  );
  const r = await f.tip();
  assert.ok(!r.ok);
  assert.equal(r.ok === false ? r.stale : null, null, 'no last-good yet');
});

test('the cache holds for CACHE_SECONDS, then refetches', async () => {
  const f = feed(
    new Map([
      [TIP_URL, heightOf(900_000)],
      [blockUrl(900_000), HASH_BODY],
      [HEADER_URL, HEADER_BODY],
    ]),
  );
  const first = await f.tip();
  assert.ok(first.ok);
  const callsAfterFirst = f.calls;
  clock += CACHE_SECONDS - 1;
  const second = await f.tip();
  assert.ok(second.ok);
  assert.equal(f.calls, callsAfterFirst, 'served from cache');
  clock += 1;
  const third = await f.tip();
  assert.ok(third.ok);
  assert.equal(
    f.calls,
    callsAfterFirst + 3,
    'cache expired: height + hash + header refetched',
  );
});

test('upstream failure answers the last-good header (503-shaped)', async () => {
  const responses = new Map<string, Buffer | Error>([
    [TIP_URL, heightOf(900_000)],
    [blockUrl(900_000), HASH_BODY],
    [HEADER_URL, HEADER_BODY],
  ]);
  const f = feed(responses);
  const first = await f.tip();
  assert.ok(first.ok);
  clock += CACHE_SECONDS + 1;
  responses.set(TIP_URL, new Error('upstream down'));
  const second = await f.tip();
  assert.ok(!second.ok);
  assert.ok(
    second.ok === false &&
      second.stale !== null &&
      second.stale.header.equals(HEADER),
  );
});

test('upstream failure with no last-good is a bare 503-shaped answer', async () => {
  const f = feed(new Map([[TIP_URL, new Error('down')]]));
  const r = await f.tip();
  assert.ok(!r.ok);
  assert.equal(r.ok === false ? r.stale : undefined, null);
});

test('a garbage height is rejected like a failed upstream', async () => {
  const f = feed(new Map([[TIP_URL, Buffer.from('not-a-number')]]));
  const r = await f.tip();
  assert.ok(!r.ok);
});

// ── the last-good header persists (the 503 fallback survives a restart) ──────

/** An in-memory TipStore, plus a reader for what a "restart" would see. */
function memoryStore() {
  let saved: {header: Buffer; height: number; fetchedAt: number} | undefined;
  return {
    read: () =>
      saved ? {...saved, header: Buffer.from(saved.header)} : undefined,
    write: (tip: {header: Buffer; height: number; fetchedAt: number}) => {
      saved = {...tip, header: Buffer.from(tip.header)};
    },
    peek: () => saved,
  };
}

test('a fetched tip is written to the store; a restarted feed seeds from it', async () => {
  const store = memoryStore();
  const f = new AnchorFeed(okFetcher, () => clock, store);
  await f.tip();
  assert.ok(store.peek(), 'the good tip was persisted');
  assert.equal(store.peek()!.height, 900_000);

  // The restart: a NEW feed over the same store, its fetcher dead.
  const restarted = new AnchorFeed(
    async () => {
      throw new Error('upstream down after restart');
    },
    () => clock + CACHE_SECONDS + 1,
    store,
  );
  const r = await restarted.tip();
  assert.ok(!r.ok, 'upstream is down after the restart');
  assert.ok(r.ok === false && r.stale !== null);
  assert.ok(r.ok === false && r.stale!.header.equals(HEADER));
  assert.equal(r.ok === false ? r.stale!.height : -1, 900_000);
});

test('a store row from before the height column (no height) does not seed', () => {
  const store = {
    read: () => ({
      header: Buffer.from(HEADER),
      height: 0,
      fetchedAt: 1,
    }),
    write: () => undefined,
  };
  const f = new AnchorFeed(
    async () => {
      throw new Error('down');
    },
    () => clock,
    store,
  );
  return f.tip().then(r => {
    assert.ok(!r.ok);
    assert.equal(r.ok === false ? r.stale : null, null, 'invalid seed ignored');
  });
});

test('a failed store write does not take the tip down', async () => {
  const f = new AnchorFeed(okFetcher, () => clock, {
    read: () => undefined,
    write: () => {
      throw new Error('disk full');
    },
  });
  const r = await f.tip();
  assert.ok(r.ok, 'the tip still answers with the store broken');
});

async function okFetcher(url: string): Promise<Buffer> {
  if (url === TIP_URL) {
    return heightOf(900_000);
  }
  if (url === blockUrl(900_000)) {
    return HASH_BODY;
  }
  if (url === HEADER_URL) {
    return HEADER_BODY;
  }
  throw new Error('unexpected url ' + url);
}

test('requests height, hash and hex header in order and decodes the header', async () => {
  const urls: string[] = [];
  const f = new AnchorFeed(async url => {
    urls.push(url);
    const response = await okFetcher(url);
    return Buffer.from(`  ${response.toString().toUpperCase()}\n`);
  });
  const result = await f.tip();
  assert.ok(result.ok);
  assert.deepEqual(result.tip.header, HEADER);
  assert.deepEqual(urls, [TIP_URL, blockUrl(900_000), HEADER_URL]);
});

for (const hash of [
  '',
  'a'.repeat(63),
  'a'.repeat(65),
  'g'.repeat(64),
  '../header',
]) {
  test(`rejects malformed block hash ${JSON.stringify(hash)} before requesting a header`, async () => {
    const f = feed(
      new Map([
        [TIP_URL, heightOf(900_000)],
        [blockUrl(900_000), Buffer.from(hash)],
      ]),
    );
    assert.deepEqual(await f.tip(), {ok: false, stale: null});
    assert.equal(f.calls, 2);
  });
}

for (const header of [
  '',
  'a'.repeat(159),
  'a'.repeat(162),
  'g'.repeat(160),
  'ab'.repeat(79) + 'zz',
]) {
  test(`rejects malformed header ${JSON.stringify(header)}`, async () => {
    const store = memoryStore();
    const f = new AnchorFeed(
      async url => (url === HEADER_URL ? Buffer.from(header) : okFetcher(url)),
      () => clock,
      store,
    );
    assert.deepEqual(await f.tip(), {ok: false, stale: null});
    assert.equal(store.peek(), undefined);
  });
}

for (const failedUrl of [blockUrl(900_000), HEADER_URL]) {
  test(`failure at ${failedUrl} preserves the last-good header and persisted row`, async () => {
    let now = 1_000_000;
    let fail = false;
    const store = memoryStore();
    const f = new AnchorFeed(
      async url => {
        if (fail && url === failedUrl) throw new Error('upstream unavailable');
        return okFetcher(url);
      },
      () => now,
      store,
    );
    const first = await f.tip();
    assert.ok(first.ok);
    const saved = store.peek();
    now += CACHE_SECONDS;
    fail = true;
    assert.deepEqual(await f.tip(), {ok: false, stale: first.tip});
    assert.deepEqual(store.peek(), saved);
  });
}

for (const invalidUrl of [blockUrl(900_000), HEADER_URL]) {
  test(`malformed response at ${invalidUrl} cannot overwrite the last-good header`, async () => {
    let now = 1_000_000;
    let corrupt = false;
    const store = memoryStore();
    const f = new AnchorFeed(
      async url => {
        if (corrupt && url === invalidUrl) return Buffer.from('not-hex');
        return okFetcher(url);
      },
      () => now,
      store,
    );
    const first = await f.tip();
    assert.ok(first.ok);
    const saved = store.peek();
    now += CACHE_SECONDS;
    corrupt = true;
    assert.deepEqual(await f.tip(), {ok: false, stale: first.tip});
    assert.deepEqual(store.peek(), saved);
  });
}
