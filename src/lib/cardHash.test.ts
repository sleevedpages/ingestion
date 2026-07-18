// Perceptual card hash — worker-port parity against the PINNED shared vectors.
//
// The pins below are duplicated VERBATIM from Content/tests/unit/lib/
// cardHash.test.js (the mirror-and-pin contract): the same deterministic
// synthetic inputs must hash to the same hex on every copy. Never regenerate a
// pin to make a failing test pass — fix the drifted copy or bump HASH_VERSION
// everywhere.

import { describe, it, expect } from 'vitest';
import { HASH_VERSION, HASH_BYTES, grayFromRgba, computeHashFromGray, hashToHex } from './cardHash';

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vectorV1() {
  const w = 64, h = 88;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = (x * 3 + y * 2) % 256;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  return { d, w, h };
}

function vectorV2() {
  const w = 200, h = 280;
  const rnd = mulberry32(42);
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = Math.floor(rnd() * 256);
    d[i * 4 + 1] = Math.floor(rnd() * 256);
    d[i * 4 + 2] = Math.floor(rnd() * 256);
    d[i * 4 + 3] = 255;
  }
  return { d, w, h };
}

function vectorV3() {
  const w = 300, h = 420;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let v = 30;
    if (x >= 60 && x < 240 && y >= 60 && y < 360) v = 150 + ((x * 7 + y * 5) % 80);
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  return { d, w, h };
}

const PIN_V1_CORPUS = '0000000103060c18000000000000000000000000000100030006000c0038007000e001c00380';
const PIN_V2_CORPUS = 'a8521a35a2794225a4cab4813185510da26a731a2578cf0d65c81eea656e08c93449aad28c77';
const PIN_V3_CORPUS = '000303030303230000000000042c005c0a8c02ac040c005c0a8c02ac040c005c0aac00000000';

describe('cardHash worker port — pinned vector parity', () => {
  it('HASH_VERSION is 1 (matches the Content copies)', () => {
    expect(HASH_VERSION).toBe(1);
  });

  it.each([
    ['V1', vectorV1, PIN_V1_CORPUS],
    ['V2', vectorV2, PIN_V2_CORPUS],
    ['V3', vectorV3, PIN_V3_CORPUS],
  ])('%s corpus hash matches the shared pin', (_n, mk, pin) => {
    const { d, w, h } = mk();
    const hash = computeHashFromGray(grayFromRgba(d, w, h), w, h);
    expect(hash.length).toBe(HASH_BYTES);
    expect(hashToHex(hash)).toBe(pin);
  });
});
