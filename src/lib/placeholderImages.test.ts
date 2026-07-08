import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDER_IMAGE_HASHES,
  sha256Hex,
  isPlaceholderImage,
  tcgplayerFullImageUrl,
} from './placeholderImages.js'

describe('PLACEHOLDER_IMAGE_HASHES — seeded card-back digests (Step-0)', () => {
  it('carries the four confirmed card-back hashes', () => {
    // The historical R2 object (cards/250321.png) — only findable by the purge sweep.
    expect(PLACEHOLDER_IMAGE_HASHES.has('c4d4811d46dc037cbd3c00a1213bb047ea3b0eb9d63bddb5352ef83074c3cb21')).toBe(true)
    // The live Scrydex /large placeholder (what the per-run probe produces).
    expect(PLACEHOLDER_IMAGE_HASHES.has('fd7c3800f9b8ebadf4b31a735f569a180e66201741b00fafa17879967884ad2c')).toBe(true)
    expect(PLACEHOLDER_IMAGE_HASHES.size).toBeGreaterThanOrEqual(4)
  })
})

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await sha256Hex(new ArrayBuffer(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('isPlaceholderImage', () => {
  it('accepts a precomputed hex hash and matches the static set', async () => {
    expect(await isPlaceholderImage('fd7c3800f9b8ebadf4b31a735f569a180e66201741b00fafa17879967884ad2c')).toBe(true)
    expect(await isPlaceholderImage('FD7C3800F9B8EBADF4B31A735F569A180E66201741B00FAFA17879967884AD2C')).toBe(true) // case-insensitive
    expect(await isPlaceholderImage('0'.repeat(64))).toBe(false)
  })

  it('hashes raw bytes and matches the static set', async () => {
    const bytes = new Uint8Array(2048).fill(3)
    const hash = await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer)
    expect(await isPlaceholderImage(bytes.buffer.slice(0) as ArrayBuffer)).toBe(false)
    // fold the same hash in via extraHashes (the mirror's live-probe path)
    expect(await isPlaceholderImage(bytes.buffer.slice(0) as ArrayBuffer, [hash])).toBe(true)
  })

  it('ignores empty/falsey extra hashes', async () => {
    expect(await isPlaceholderImage('0'.repeat(64), [''])).toBe(false)
    expect(await isPlaceholderImage('0'.repeat(64), null)).toBe(false)
  })
})

describe('tcgplayerFullImageUrl', () => {
  it('reconstructs the operator-verified _in_1000x1000 CDN url', () => {
    expect(tcgplayerFullImageUrl(250321))
      .toBe('https://tcgplayer-cdn.tcgplayer.com/product/250321_in_1000x1000.jpg')
  })
  it('returns null for a missing/invalid id', () => {
    expect(tcgplayerFullImageUrl(null)).toBeNull()
    expect(tcgplayerFullImageUrl(undefined)).toBeNull()
    expect(tcgplayerFullImageUrl(NaN)).toBeNull()
  })
})
