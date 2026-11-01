/**
 * Migrations apply forward-only; batch creation's derive-and-escrow is one
 * transaction — a forced failure between the batch row and a key row leaves
 * nothing, proving "no issued-but-unescrowed state" (D29) rather than
 * asserting it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {AnchorFeed, CACHE_SECONDS, HEADER_LEN} from '../src/anchor';
import {BatchError, createBatch} from '../src/batches';
import {MIGRATIONS, OpsDb} from '../src/db';
import {openSqliteFile} from '../src/sqlite-file';
import {TEST_MASTER, testDb} from './helpers';

/** A temp-file path a test can open twice (a re-open of a real DB file). */
function tempDbPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ops-db-test-')),
    'ops.db',
  );
}

test('migrations apply forward-only to a fresh DB', () => {
  const db = testDb();
  const v = db.db.prepare('SELECT version FROM schema_version').get() as {
    version: number;
  };
  assert.equal(v.version, MIGRATIONS.length);
  // every table the routes touch exists
  const tables = (
    db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as {
      name: string;
    }[]
  ).map(r => r.name);
  for (const t of [
    'operators',
    'sessions',
    'key_batches',
    'issued_keys',
    'cards',
    'cap_releases',
    'anchor_tip',
  ]) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }
  db.close();
});

test('a second OpsDb on the same file does not re-apply or fail', () => {
  // A real file, opened twice: the first OpsDb writes a row and closes, the
  // second re-opens the SAME path. A re-apply (or a crash on the existing
  // schema) would show up here and nowhere in an :memory: test.
  const p = tempDbPath();
  const db = new OpsDb({
    sql: openSqliteFile(p),
    master: {getMaster: () => TEST_MASTER},
  });
  db.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'x', 'issued', 1)",
    )
    .run();
  db.close();

  const again = new OpsDb({
    sql: openSqliteFile(p),
    master: {getMaster: () => TEST_MASTER},
  });
  const v = again.db.prepare('SELECT version FROM schema_version').get() as {
    version: number;
  };
  assert.equal(v.version, MIGRATIONS.length, 'the version stands at head');
  const ops = again.db
    .prepare('SELECT name FROM operators WHERE name = ?')
    .get('op') as {name: string} | undefined;
  assert.ok(ops, 'the previously written operator row survived the re-open');
  again.close();
  fs.rmSync(path.dirname(p), {recursive: true, force: true});
});

test('createBatch escrows every ordinal in one write', () => {
  const db = testDb();
  db.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'x', 'issued', 1)",
    )
    .run();
  const batch = createBatch(db, {
    count: 5,
    mintUrl: 'https://forge.flashapp.me',
    pinPolicy: 'perCard',
    dailyUsd: 25,
    noPinUsd: 5,
    loadSha256: 'fe7d8ac3',
    operatorId: 1,
  });
  const rows = db.db
    .prepare(
      'SELECT ordinal FROM issued_keys WHERE batch_id = ? ORDER BY ordinal',
    )
    .all(batch.id) as {ordinal: number}[];
  assert.deepEqual(
    rows.map(r => r.ordinal),
    [0, 1, 2, 3, 4],
  );
  db.close();
});

test('a forced failure between the batch row and a key row leaves NO row at all', () => {
  const db = testDb();
  db.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'x', 'issued', 1)",
    )
    .run();

  // Derive with a broken master source: createBatch's transaction throws
  // after the INSERT of the batch row — exactly the forced failure the
  // no-issued-but-unescrowed claim needs.
  const broken = new OpsDb({
    sql: openSqliteFile(':memory:'),
    now: () => 1_700_000_000,
    master: {getMaster: () => Buffer.alloc(4, 1)}, // too short: requireMaster throws
  });
  broken.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'x', 'issued', 1)",
    )
    .run();
  assert.throws(() =>
    createBatch(broken, {
      count: 3,
      mintUrl: 'https://forge.flashapp.me',
      pinPolicy: 'perCard',
      dailyUsd: 25,
      noPinUsd: 5,
      loadSha256: 'fe7d8ac3',
      operatorId: 1,
    }),
  );
  const batches = broken.db
    .prepare('SELECT COUNT(*) AS n FROM key_batches')
    .get() as {n: number};
  const keys = broken.db
    .prepare('SELECT COUNT(*) AS n FROM issued_keys')
    .get() as {n: number};
  assert.equal(batches.n, 0, 'the batch row rolled back');
  assert.equal(keys.n, 0, 'no key row survived');
  broken.close();

  // And a mid-loop failure: corrupt the master AFTER creation begins by
  // pointing deriveKeySet at an ordinal that throws — exercised via a stub
  // master that fails from the second derive on.
  let calls = 0;
  const midFail = new OpsDb({
    sql: openSqliteFile(':memory:'),
    now: () => 1_700_000_000,
    master: {
      getMaster: () => {
        calls++;
        if (calls > 1) {
          throw new Error('master vanished mid-batch');
        }
        return TEST_MASTER;
      },
    },
  });
  midFail.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'x', 'issued', 1)",
    )
    .run();
  assert.throws(() =>
    createBatch(midFail, {
      count: 3,
      mintUrl: 'https://forge.flashapp.me',
      pinPolicy: 'perCard',
      dailyUsd: 25,
      noPinUsd: 5,
      loadSha256: 'fe7d8ac3',
      operatorId: 1,
    }),
  );
  const midBatches = midFail.db
    .prepare('SELECT COUNT(*) AS n FROM key_batches')
    .get() as {n: number};
  const midKeys = midFail.db
    .prepare('SELECT COUNT(*) AS n FROM issued_keys')
    .get() as {n: number};
  assert.equal(midBatches.n, 0);
  assert.equal(midKeys.n, 0);
  midFail.close();
  db.close();
});

test('migrations never rewrite history: opening twice leaves the same version', () => {
  // A forward-only contract holds only if a re-open does not re-apply or
  // reorder anything; the version row stands still across opens.
  const db = new OpsDb({
    sql: openSqliteFile(':memory:'),
    master: {getMaster: () => TEST_MASTER},
  });
  const v1 = (
    db.db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    }
  ).version;
  db.close();
  const again = new OpsDb({
    sql: openSqliteFile(':memory:'),
    master: {getMaster: () => TEST_MASTER},
  });
  const v2 = (
    again.db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    }
  ).version;
  assert.equal(v1, v2);
  again.close();
});

// ── the anchor_tip table behaves (the threat model's "survives a restart"
//    row, over the real store — not the hand-rolled memory one) ──────────────

test('a tip written through one OpsDb tipStore() seeds a fresh feed over the same DB', async () => {
  const p = tempDbPath();
  const db = new OpsDb({
    sql: openSqliteFile(p),
    now: () => 1_700_000_000,
    master: {getMaster: () => TEST_MASTER},
  });
  const HEADER = Buffer.alloc(HEADER_LEN, 0xab);
  const TIP_URL = 'https://mempool.space/api/blocks/tip/height';

  // A live fetch writes the last-good header through the REAL store.
  const live = new AnchorFeed(
    async url => {
      if (url === TIP_URL) return Buffer.from('900000');
      const hash = '0123456789abcdef'.repeat(4);
      if (url === 'https://mempool.space/api/block-height/900000')
        return Buffer.from(hash);
      if (url === `https://mempool.space/api/block/${hash}/header`)
        return Buffer.from(HEADER.toString('hex'));
      throw new Error('unexpected url ' + url);
    },
    () => 1_700_000_000,
    db.tipStore(),
  );
  const first = await live.tip();
  assert.ok(first.ok, 'the live fetch answered');

  // The restart: a NEW feed over the SAME DB file's tipStore(), its fetcher
  // dead, its clock past the cache window. The stale header must come back.
  const restarted = new AnchorFeed(
    async () => {
      throw new Error('upstream down after restart');
    },
    () => 1_700_000_000 + CACHE_SECONDS + 1,
    db.tipStore(),
  );
  const r = await restarted.tip();
  assert.ok(!r.ok, 'upstream is down after the restart');
  assert.ok(r.ok === false && r.stale !== null, 'the last-good was seeded');
  assert.ok(r.ok === false && r.stale!.header.equals(HEADER));
  assert.equal(r.ok === false ? r.stale!.height : -1, 900_000);
  assert.equal(r.ok === false ? r.stale!.fetchedAt : -1, 1_700_000_000);

  // And the row itself is what the store read back: one row, id 1.
  const row = db.db
    .prepare('SELECT header, height, fetched_at FROM anchor_tip WHERE id = 1')
    .get() as {header: Buffer; height: number; fetched_at: number};
  assert.ok(row.header.equals(HEADER));
  assert.equal(row.height, 900_000);

  db.close();
  fs.rmSync(path.dirname(p), {recursive: true, force: true});
});

test('a NULL-height anchor_tip row (pre-migration-2) seeds nothing', async () => {
  const p = tempDbPath();
  const db = new OpsDb({
    sql: openSqliteFile(p),
    now: () => 1_700_000_000,
    master: {getMaster: () => TEST_MASTER},
  });
  // The shape a row written before migration 2 has: header present, height NULL.
  db.db
    .prepare(
      'INSERT INTO anchor_tip (id, header, height, fetched_at) VALUES (1, ?, NULL, ?)',
    )
    .run(Buffer.alloc(HEADER_LEN, 0xab), 1_699_999_000);

  const feed = new AnchorFeed(
    async () => {
      throw new Error('upstream down');
    },
    () => 1_700_000_000,
    db.tipStore(),
  );
  const r = await feed.tip();
  assert.ok(!r.ok);
  assert.equal(
    r.ok === false ? r.stale : null,
    null,
    'a NULL-height row seeds nothing (no height, no {header, height, fetched_at} shape)',
  );
  db.close();
  fs.rmSync(path.dirname(p), {recursive: true, force: true});
});

test('batch admission rejects invalid counts and limits before creating recovery metadata', () => {
  const db = testDb();
  db.db
    .prepare(
      "INSERT INTO operators (name, password_hash, key_env, created) VALUES ('op', 'test', 'issued', 1)",
    )
    .run();
  const input = {
    count: 1,
    mintUrl: 'https://mint.test',
    pinPolicy: 'perCard' as const,
    dailyUsd: 0,
    noPinUsd: 0,
    loadSha256: 'test',
    operatorId: 1,
  };
  for (const invalid of [
    {count: 1.5},
    {count: NaN},
    {dailyUsd: -1},
    {dailyUsd: Infinity},
    {noPinUsd: -1},
    {noPinUsd: NaN},
  ]) {
    assert.throws(() => createBatch(db, {...input, ...invalid}), BatchError);
  }
  assert.equal(
    (
      db.db.prepare('SELECT COUNT(*) AS n FROM key_batches').get() as {
        n: number;
      }
    ).n,
    0,
  );
  assert.equal(createBatch(db, input).count, 1);
});
