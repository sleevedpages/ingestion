// hashProductImages sweep — fake-env tests: hash writes, sentinel semantics,
// tcgplayer-cdn exclusion, transient-failure circuit break, packed-index
// regeneration, and the pack format round trip.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  runHashProductImages, packIndex, indexKeyForGame, RECORD_BYTES,
} from './hashProductImages';
import { HASH_VERSION, HASH_BYTES } from './lib/cardHash';

// ── Tiny valid PNG (2×2 RGB) built with node:zlib ────────────────────────────

function crc32(buf: Uint8Array): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function tinyPng(): Uint8Array {
  // 64×64 patterned RGB — big enough to clear the fetch path's junk-body floor.
  const w = 64, h = 64, stride = w * 3;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    for (let x = 0; x < w; x++) {
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = (x * 7 + y * 13) % 256;
      raw[o + 1] = (x * 3 + y * 29) % 256;
      raw[o + 2] = (x * 11 + y * 5) % 256;
    }
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── Fake env ─────────────────────────────────────────────────────────────────

interface FakeRow { product_id: number; game_id: number; r2_url: string | null; source_url: string | null }

function makeEnv(rows: FakeRow[], opts: { excludedCount?: number; r2Objects?: Record<string, Uint8Array> } = {}) {
  // hashes written this run: product_id → { hash bytes }
  const written = new Map<number, { game_id: number; hash: Uint8Array }>();
  const r2Puts: Record<string, Uint8Array> = {};

  const candidates = () => rows.filter(r => !written.has(r.product_id));

  function makeStmt(sql: string) {
    let binds: unknown[] = [];
    const stmt: Record<string, unknown> = {
      bind(...a: unknown[]) { binds = a; (stmt as { _binds?: unknown[] })._binds = a; return stmt; },
      _sql: sql,
      get _bindsList() { return binds; },
      async all() {
        if (sql.includes('LEFT JOIN product_image_hashes h') && sql.includes('LIMIT ?')) {
          const cursor = Number(binds[1]);
          const limit = Number(binds[2]);
          return { results: candidates().filter(r => r.product_id > cursor).slice(0, limit) };
        }
        if (sql.includes('FROM product_image_hashes') && sql.includes('length(hash)')) {
          const gameId = Number(binds[0]);
          const cursor = Number(binds[3]);
          const results = [...written.entries()]
            .filter(([id, v]) => v.game_id === gameId && v.hash.length === HASH_BYTES && id > cursor)
            .sort((a, b) => a[0] - b[0])
            .map(([id, v]) => ({ product_id: id, hash: v.hash.buffer.slice(v.hash.byteOffset, v.hash.byteOffset + v.hash.byteLength) }));
          return { results };
        }
        return { results: [] };
      },
      async first() {
        // The excluded-count query has no products/sets join; countRemaining does.
        if (sql.includes('COUNT(*)') && !sql.includes('JOIN products')) {
          return { n: opts.excludedCount ?? 0 };
        }
        if (sql.includes('COUNT(*)')) {
          return { n: candidates().length };
        }
        return null;
      },
      async run() { return { meta: {} }; },
    };
    return stmt;
  }

  const env = {
    DB: {
      prepare: (sql: string) => makeStmt(sql),
      async batch(stmts: Array<{ _sql: string; _binds?: unknown[] }>) {
        for (const s of stmts) {
          if (s._sql.includes('INSERT OR REPLACE INTO product_image_hashes')) {
            const [productId, gameId, hash] = s._binds as [number, number, Uint8Array, number];
            written.set(Number(productId), { game_id: Number(gameId), hash: new Uint8Array(hash) });
          }
        }
        return [];
      },
    },
    IMAGES_BUCKET: {
      async get(key: string) {
        const bytes = opts.r2Objects?.[key];
        if (!bytes) return null;
        return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
      async put(key: string, value: ArrayBuffer) {
        r2Puts[key] = new Uint8Array(value as ArrayBuffer);
      },
    },
  };
  return { env: env as never, written, r2Puts };
}

afterEach(() => vi.unstubAllGlobals());

describe('runHashProductImages', () => {
  it('hashes an R2-mirrored image and repacks that game index', async () => {
    const png = tinyPng();
    const { env, written, r2Puts } = makeEnv(
      [{ product_id: 10, game_id: 3, r2_url: 'https://images.sleevedpages.com/cards/10.png', source_url: null }],
      { r2Objects: { 'cards/10.png': png } },
    );
    const result = await runHashProductImages(env);
    expect(result.hashed).toBe(1);
    expect(result.undecodable).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.gamesRepacked).toEqual([3]);
    expect(written.get(10)!.hash.length).toBe(HASH_BYTES);
    // Packed blob exists at the versioned key with one 42-byte record for product 10.
    const blob = r2Puts[indexKeyForGame(3)];
    expect(blob.length).toBe(RECORD_BYTES);
    expect(new DataView(blob.buffer).getUint32(0, true)).toBe(10);
  });

  it('undecodable bytes → SENTINEL row (drops out of the pool; excluded from packing)', async () => {
    const { env, written, r2Puts } = makeEnv(
      [{ product_id: 11, game_id: 3, r2_url: 'https://images.sleevedpages.com/cards/11.png', source_url: null }],
      { r2Objects: { 'cards/11.png': new Uint8Array([1, 2, 3, 4, 5]) } },
    );
    const result = await runHashProductImages(env);
    expect(result.undecodable).toBe(1);
    expect(result.hashed).toBe(0);
    expect(written.get(11)!.hash.length).toBe(0); // zero-length sentinel
    expect(result.remaining).toBe(0);             // converged — never re-attempted
    expect(Object.keys(r2Puts)).toEqual([])       // nothing repacked
  });

  it('fetches a non-tcgplayer source_url when there is no R2 mirror; 4xx → sentinel', async () => {
    const png = tinyPng();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('good')) {
        return new Response(png.buffer.slice(0) as ArrayBuffer, { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { env, written } = makeEnv([
      { product_id: 20, game_id: 5, r2_url: null, source_url: 'https://images.scrydex.com/pokemon/good/large' },
      { product_id: 21, game_id: 5, r2_url: null, source_url: 'https://images.scrydex.com/pokemon/dead/large' },
    ]);
    const result = await runHashProductImages(env);
    expect(result.hashed).toBe(1);
    expect(result.undecodable).toBe(1);
    expect(written.get(20)!.hash.length).toBe(HASH_BYTES);
    expect(written.get(21)!.hash.length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('circuit-breaks after repeated TRANSIENT failures and writes nothing for them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const rows: FakeRow[] = Array.from({ length: 30 }, (_, i) => ({
      product_id: 100 + i, game_id: 7, r2_url: null,
      source_url: `https://images.scrydex.com/pokemon/x${i}/large`,
    }));
    const { env, written } = makeEnv(rows);
    const result = await runHashProductImages(env);
    expect(result.circuitBroken).toBe(true);
    expect(result.transientFailures).toBeGreaterThanOrEqual(10);
    expect(written.size).toBe(0);       // transient failures never write sentinels
    expect(result.remaining).toBe(30);  // all still candidates for the next run
    expect(result.hasMore).toBe(true);
  });

  it('reports the structurally-excluded tcgplayer-cdn count (coverage signal)', async () => {
    const { env } = makeEnv([], { excludedCount: 218471 });
    const result = await runHashProductImages(env);
    expect(result.excludedTcgplayerCdn).toBe(218471);
    expect(result.scanned).toBe(0);
  });

  it('respects the limit option and reports hasMore + cursorNext', async () => {
    const png = tinyPng();
    const r2Objects: Record<string, Uint8Array> = {};
    const rows: FakeRow[] = Array.from({ length: 5 }, (_, i) => {
      r2Objects[`cards/${200 + i}.png`] = png;
      return {
        product_id: 200 + i, game_id: 9,
        r2_url: `https://images.sleevedpages.com/cards/${200 + i}.png`,
        source_url: null,
      };
    });
    const { env } = makeEnv(rows, { r2Objects });
    const result = await runHashProductImages(env, { limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.hashed).toBe(2);
    expect(result.remaining).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.cursorNext).toBe(201);
  });
});

describe('packIndex format', () => {
  it('emits fixed-width [u32 LE id][hash] records', () => {
    const hash = new Uint8Array(HASH_BYTES).fill(0xab);
    const blob = packIndex([{ productId: 258, hash }]);
    expect(blob.length).toBe(RECORD_BYTES);
    expect(new DataView(blob.buffer).getUint32(0, true)).toBe(258);
    expect(blob[4]).toBe(0xab);
    expect(blob[4 + HASH_BYTES - 1]).toBe(0xab);
  });
});
