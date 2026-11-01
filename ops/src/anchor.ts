/**
 * The BTC tip the daily-limit clock anchors to (D20): mempool.space REST,
 * a 60 s cache, and the last-good header kept for an upstream failure — the
 * plan's decision 4. Shape-validated only (80 bytes, like cardctl's
 * HEADER_LEN check at cardctl.py:479-480); proof-of-work is NOT verified and
 * the threat model's row 10 says so.
 *
 * The last-good header persists to the `anchor_tip` table (one row, id = 1)
 * and is seeded from it at boot, so a restart does not silently lose the
 * header the 503 fallback promises. The store is injectable; without one the
 * feed behaves exactly as before, in memory only.
 */
export const HEADER_LEN = 80;
export const CACHE_SECONDS = 60;
const MEMPOOL_TIP = 'https://mempool.space/api/blocks/tip/height';
const MEMPOOL_BLOCK = (height: number) =>
  `https://mempool.space/api/block-height/${height}`;
const MEMPOOL_HEADER = (hash: string) =>
  `https://mempool.space/api/block/${hash}/header`;

export interface TipHeader {
  readonly header: Buffer;
  readonly fetchedAt: number;
  readonly height: number;
}

/** The fetch, injectable so tests (and cardctl's offline suite) never touch a network. */
export type TipFetcher = (url: string) => Promise<Buffer>;

/** The last-good header's store; the ops DB's anchor_tip table in production. */
export interface TipStore {
  read(): {header: Buffer; height: number; fetchedAt: number} | undefined;
  write(tip: {header: Buffer; height: number; fetchedAt: number}): void;
}

export const httpTipFetcher: TipFetcher = async url => {
  const res = await fetch(url, {signal: AbortSignal.timeout(10_000)});
  if (!res.ok) {
    throw new UpstreamError(`upstream answered ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

export class UpstreamError extends Error {}

export class AnchorFeed {
  private lastGood: TipHeader | null = null;
  private fetchedAt: number = 0;

  constructor(
    private readonly fetcher: TipFetcher = httpTipFetcher,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly store?: TipStore,
  ) {
    // Seed from the persisted last-good: a restart keeps the header the 503
    // fallback answers with (finding: the table was dead schema before).
    const saved = this.store?.read();
    if (
      saved &&
      saved.header.length === HEADER_LEN &&
      Number.isInteger(saved.height) &&
      saved.height > 0
    ) {
      this.lastGood = {
        header: Buffer.from(saved.header),
        height: saved.height,
        fetchedAt: saved.fetchedAt,
      };
      this.fetchedAt = saved.fetchedAt;
    }
  }

  /**
   * The tip header: from cache within CACHE_SECONDS, from upstream otherwise.
   * Upstream failure answers the last-good header — the caller decides, via
   * `stale`, whether to surface it as a 503-shaped answer or serve it.
   */
  async tip(): Promise<
    {ok: true; tip: TipHeader} | {ok: false; stale: TipHeader | null}
  > {
    const now = this.now();
    if (this.lastGood && now - this.fetchedAt < CACHE_SECONDS) {
      return {ok: true, tip: this.lastGood};
    }
    try {
      const heightBuf = await this.fetcher(MEMPOOL_TIP);
      const height = Number.parseInt(heightBuf.toString('ascii').trim(), 10);
      if (!Number.isInteger(height) || height <= 0) {
        throw new UpstreamError('upstream height is not a number');
      }
      // Esplora resolves a height to a hash, not a binary block header.
      const hash = (await this.fetcher(MEMPOOL_BLOCK(height)))
        .toString('utf8')
        .trim();
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        throw new UpstreamError('upstream block hash is not 32-byte hex');
      }
      const headerHex = (await this.fetcher(MEMPOOL_HEADER(hash.toLowerCase())))
        .toString('utf8')
        .trim();
      // Buffer.from(hex) silently truncates malformed hex: validate first.
      if (
        !/^[0-9a-f]+$/i.test(headerHex) ||
        headerHex.length !== HEADER_LEN * 2
      ) {
        throw new UpstreamError('upstream block header is not 80-byte hex');
      }
      const header = Buffer.from(headerHex, 'hex');
      const tip: TipHeader = {header, fetchedAt: now, height};
      this.lastGood = tip;
      this.fetchedAt = now;
      try {
        this.store?.write({header: tip.header, height, fetchedAt: now});
      } catch {
        // A failed persistence write must not take the tip down; the
        // in-memory last-good still serves, and the next fetch rewrites.
      }
      return {ok: true, tip};
    } catch (e) {
      if (e instanceof UpstreamError || e instanceof Error) {
        // fall through to last-good
      }
      return {ok: false, stale: this.lastGood};
    }
  }
}
