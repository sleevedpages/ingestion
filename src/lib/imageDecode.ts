// Image decode for the hash sweep — JPEG via jpeg-js, PNG hand-rolled.
//
// The corpus is mixed (verified against prod 2026-07-17: the R2-mirrored tier
// is ~92% PNG — Scrydex mirrors — plus JPEG; source_url rows are JPEG). Workers
// have no canvas, so:
//   - JPEG: jpeg-js (the one new dependency — pure JS baseline+progressive
//     decode, no wasm/native bindings; Huffman+IDCT is not hand-rollable).
//   - PNG: hand-rolled minimal decoder below (house style: hand-rolled over a
//     second dependency). Inflate rides the Workers-native DecompressionStream
//     ('deflate' = zlib-wrapped, exactly PNG's IDAT format). Supports the shapes
//     Scrydex/TCGplayer actually serve: 8-bit depth, color types 0/2/3/4/6,
//     non-interlaced. Anything else → null (the sweep records it undecodable —
//     log + skip, never fail the run).
//
// decodeImage() returns { data (RGBA), width, height } or null on any
// permanent decode failure. It NEVER throws.

import { decode as decodeJpeg } from 'jpeg-js';

export interface DecodedImage {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
}

const MAX_PIXELS = 16_000_000; // safety valve — no catalogue image is near this

export function sniffImageFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'unknown' {
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  return 'unknown';
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Channels per PNG color type (8-bit depth only).
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function decodePng(bytes: Uint8Array): Promise<DecodedImage | null> {
  try {
    if (sniffImageFormat(bytes) !== 'png') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idatParts: Uint8Array[] = [];

    let off = 8;
    while (off + 8 <= bytes.length) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      const dataStart = off + 8;
      if (dataStart + len > bytes.length) return null;
      if (type === 'IHDR') {
        width = view.getUint32(dataStart);
        height = view.getUint32(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlace = bytes[dataStart + 12];
      } else if (type === 'PLTE') {
        palette = bytes.subarray(dataStart, dataStart + len);
      } else if (type === 'tRNS') {
        trns = bytes.subarray(dataStart, dataStart + len);
      } else if (type === 'IDAT') {
        idatParts.push(bytes.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') {
        break;
      }
      off = dataStart + len + 4; // skip CRC
    }

    if (!width || !height || width * height > MAX_PIXELS) return null;
    if (bitDepth !== 8 || interlace !== 0) return null; // unsupported shapes → undecodable
    const channels = CHANNELS[colorType];
    if (!channels) return null;
    if (colorType === 3 && !palette) return null;
    if (!idatParts.length) return null;

    const idat = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
    let ioff = 0;
    for (const p of idatParts) { idat.set(p, ioff); ioff += p.length; }

    const raw = await inflateZlib(idat);
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;

    // Unfilter in place into a contiguous pixel buffer.
    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const rowIn = y * (stride + 1) + 1;
      const rowOut = y * stride;
      const prevOut = rowOut - stride;
      for (let x = 0; x < stride; x++) {
        const rawByte = raw[rowIn + x];
        const left = x >= channels ? pixels[rowOut + x - channels] : 0;
        const up = y > 0 ? pixels[prevOut + x] : 0;
        const upLeft = y > 0 && x >= channels ? pixels[prevOut + x - channels] : 0;
        let v: number;
        switch (filter) {
          case 0: v = rawByte; break;
          case 1: v = rawByte + left; break;
          case 2: v = rawByte + up; break;
          case 3: v = rawByte + ((left + up) >> 1); break;
          case 4: v = rawByte + paeth(left, up, upLeft); break;
          default: return null;
        }
        pixels[rowOut + x] = v & 0xff;
      }
    }

    // Expand to RGBA.
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const p = i * channels;
      const o = i * 4;
      if (colorType === 0) {            // gray
        out[o] = out[o + 1] = out[o + 2] = pixels[p];
        out[o + 3] = 255;
      } else if (colorType === 2) {     // RGB
        out[o] = pixels[p]; out[o + 1] = pixels[p + 1]; out[o + 2] = pixels[p + 2];
        out[o + 3] = 255;
      } else if (colorType === 3) {     // palette
        const idx = pixels[p] * 3;
        out[o] = palette![idx]; out[o + 1] = palette![idx + 1]; out[o + 2] = palette![idx + 2];
        out[o + 3] = trns && pixels[p] < trns.length ? trns[pixels[p]] : 255;
      } else if (colorType === 4) {     // gray + alpha
        out[o] = out[o + 1] = out[o + 2] = pixels[p];
        out[o + 3] = pixels[p + 1];
      } else {                          // RGBA
        out[o] = pixels[p]; out[o + 1] = pixels[p + 1]; out[o + 2] = pixels[p + 2];
        out[o + 3] = pixels[p + 3];
      }
    }
    return { data: out, width, height };
  } catch {
    return null;
  }
}

export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage | null> {
  const format = sniffImageFormat(bytes);
  if (format === 'jpeg') {
    try {
      const { data, width, height } = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 96 });
      if (!width || !height || width * height > MAX_PIXELS) return null;
      return { data: data as Uint8Array, width, height };
    } catch {
      return null;
    }
  }
  if (format === 'png') return decodePng(bytes);
  return null;
}
