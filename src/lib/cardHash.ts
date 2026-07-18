// Perceptual card hash — INGESTION WORKER port (bulk scan intake, HASH_VERSION 1).
//
// PORT of the pure core in Content/src/lib/cardHash.js ↔ Content/functions/lib/
// cardHash.js (three copies total — src↔functions aren't import-shareable and
// this is a separate repo). Parity is pinned by shared deterministic test
// vectors (src/lib/cardHash.test.ts here mirrors Content's
// tests/unit/lib/cardHash.test.js — the centeringMeasurement mirror-and-pin
// pattern). All INTEGER math → identical inputs produce byte-identical hashes
// on every runtime. Change ANY constant → bump HASH_VERSION everywhere (the
// packed R2 indexes and product_image_hashes rows are versioned; old versions
// are re-swept, never migrated).
//
// HASH_VERSION 1 layout (38 bytes):
//   bytes 0–7   classic 8×8 dHash  (9×8 luma grid  → 8 diffs × 8 rows = 64 bits)
//   bytes 8–37  16×16-difference dHash (17×15 grid → 16 diffs × 15 rows = 240 bits)
// Bits pack MSB-first, row-major; bit set ⇔ cell[y][x] > cell[y][x+1].
//
// The worker computes the CORPUS flavour only (full frame — catalogue art is a
// tight card crop already). The scan flavour (card localization first) lives in
// the Content copies.

export const HASH_VERSION = 1;
export const HASH_BYTES = 38;
export const PREFIX_BYTES = 8;
export const MAIN_BYTES = 30;

/** BT.601 integer grayscale — the cardDetection.js weights. RGBA in, Uint8Array out. */
export function grayFromRgba(data: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

/** Integer box-average downsample of a grayscale buffer to a W×H grid. */
export function downsampleGray(gray: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  const cells = new Uint8Array(W * H);
  for (let gy = 0; gy < H; gy++) {
    const y0 = Math.floor((gy * h) / H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / H));
    for (let gx = 0; gx < W; gx++) {
      const x0 = Math.floor((gx * w) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / W));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const rowOff = y * w;
        for (let x = x0; x < x1; x++) sum += gray[rowOff + x];
      }
      cells[gy * W + gx] = Math.floor(sum / ((x1 - x0) * (y1 - y0)));
    }
  }
  return cells;
}

/** Row-difference dHash bits over a W×H cell grid, packed MSB-first. */
export function dhashBytes(cells: Uint8Array, W: number, H: number): Uint8Array {
  const bits = (W - 1) * H;
  const out = new Uint8Array(Math.ceil(bits / 8));
  let bit = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (cells[y * W + x] > cells[y * W + x + 1]) {
        out[bit >> 3] |= 0x80 >> (bit & 7);
      }
      bit++;
    }
  }
  return out;
}

/** The 38-byte HASH_VERSION-1 hash of a grayscale frame (corpus flavour — full frame). */
export function computeHashFromGray(gray: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(HASH_BYTES);
  out.set(dhashBytes(downsampleGray(gray, w, h, 9, 8), 9, 8), 0);
  out.set(dhashBytes(downsampleGray(gray, w, h, 17, 15), 17, 15), PREFIX_BYTES);
  return out;
}

export function hashToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
