// Image decode — hand-rolled PNG decoder + jpeg-js wrapper + sniffing.
//
// PNG fixtures are BUILT in-test (node:zlib deflate over hand-assembled chunks)
// so we control every shape: RGB, RGBA, grayscale, palette, and the
// unsupported cases that must return null (never throw).

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { encode as encodeJpeg } from 'jpeg-js';
import { sniffImageFormat, decodeImage, decodePng } from './imageDecode';

// ── Minimal PNG builder ──────────────────────────────────────────────────────

function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
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
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function buildPng(opts: {
  width: number; height: number; colorType: number; bitDepth?: number;
  interlace?: number; pixels: Uint8Array; palette?: Uint8Array;
}): Uint8Array {
  const { width, height, colorType, pixels } = opts;
  const bitDepth = opts.bitDepth ?? 8;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const stride = width * (channels[colorType] ?? 1);
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = opts.interlace ?? 0;
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (opts.palette) parts.push(chunk('PLTE', opts.palette));
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw))));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('sniffImageFormat', () => {
  it('detects jpeg / png / unknown', () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg');
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe('unknown');
  });
});

describe('decodePng — supported shapes', () => {
  it('decodes 8-bit RGB', async () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const png = buildPng({ width: 2, height: 2, colorType: 2, pixels });
    const img = await decodePng(png);
    expect(img).not.toBeNull();
    expect(img!.width).toBe(2);
    expect(img!.height).toBe(2);
    expect([...img!.data.subarray(0, 8)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect([...img!.data.subarray(12, 16)]).toEqual([10, 20, 30, 255]);
  });

  it('decodes 8-bit RGBA with alpha preserved', async () => {
    const pixels = new Uint8Array([1, 2, 3, 128, 4, 5, 6, 255]);
    const png = buildPng({ width: 2, height: 1, colorType: 6, pixels });
    const img = await decodePng(png);
    expect([...img!.data]).toEqual([1, 2, 3, 128, 4, 5, 6, 255]);
  });

  it('decodes 8-bit grayscale', async () => {
    const pixels = new Uint8Array([0, 128, 255]);
    const png = buildPng({ width: 3, height: 1, colorType: 0, pixels });
    const img = await decodePng(png);
    expect([...img!.data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  });

  it('decodes palette (colorType 3)', async () => {
    const palette = new Uint8Array([255, 0, 0, 0, 0, 255]);
    const pixels = new Uint8Array([0, 1]);
    const png = buildPng({ width: 2, height: 1, colorType: 3, pixels, palette });
    const img = await decodePng(png);
    expect([...img!.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('decodes Sub/Up/Paeth-filtered rows (filter bytes exercised)', async () => {
    // Build a 3×3 RGB with hand-set filters: row0 Sub(1), row1 Up(2), row2 Paeth(4).
    const width = 3, height = 3, stride = 9;
    const truth = new Uint8Array([
      10, 10, 10, 20, 20, 20, 30, 30, 30,
      12, 12, 12, 22, 22, 22, 32, 32, 32,
      15, 15, 15, 25, 25, 25, 35, 35, 35,
    ]);
    const raw = new Uint8Array(height * (stride + 1));
    // row 0 — Sub: raw = cur - left
    raw[0] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? truth[x - 3] : 0;
      raw[1 + x] = (truth[x] - left) & 0xff;
    }
    // row 1 — Up: raw = cur - up
    raw[stride + 1] = 2;
    for (let x = 0; x < stride; x++) {
      raw[stride + 2 + x] = (truth[stride + x] - truth[x]) & 0xff;
    }
    // row 2 — Paeth
    raw[2 * (stride + 1)] = 4;
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? truth[2 * stride + x - 3] : 0;
      const up = truth[stride + x];
      const upLeft = x >= 3 ? truth[stride + x - 3] : 0;
      raw[2 * (stride + 1) + 1 + x] = (truth[2 * stride + x] - paeth(left, up, upLeft)) & 0xff;
    }
    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, width); iv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', new Uint8Array(deflateSync(raw))),
      chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { png.set(p, off); off += p.length; }

    const img = await decodePng(png);
    expect(img).not.toBeNull();
    for (let i = 0; i < 9; i++) {
      expect([...img!.data.subarray(i * 4, i * 4 + 3)]).toEqual([...truth.subarray(i * 3, i * 3 + 3)]);
    }
  });
});

describe('decodePng — unsupported shapes return null (never throw)', () => {
  it('16-bit depth → null', async () => {
    const png = buildPng({ width: 1, height: 1, colorType: 2, bitDepth: 16, pixels: new Uint8Array(6) });
    expect(await decodePng(png)).toBeNull();
  });

  it('interlaced → null', async () => {
    const png = buildPng({ width: 1, height: 1, colorType: 2, interlace: 1, pixels: new Uint8Array(3) });
    expect(await decodePng(png)).toBeNull();
  });

  it('truncated/garbage → null', async () => {
    expect(await decodePng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBeNull();
    expect(await decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('decodeImage — dispatch', () => {
  it('decodes a jpeg-js-encoded JPEG', async () => {
    const w = 16, h = 16;
    const data = new Uint8Array(w * h * 4).fill(200);
    const jpeg = encodeJpeg({ data, width: w, height: h }, 90);
    const img = await decodeImage(jpeg.data);
    expect(img).not.toBeNull();
    expect(img!.width).toBe(w);
  });

  it('routes PNG and rejects unknown', async () => {
    const png = buildPng({ width: 1, height: 1, colorType: 2, pixels: new Uint8Array([9, 9, 9]) });
    expect((await decodeImage(png))!.width).toBe(1);
    expect(await decodeImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
