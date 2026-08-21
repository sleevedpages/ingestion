import { describe, it, expect, vi } from 'vitest'
import { invalidateUpcCache, upcCacheKeys, upcCacheForms } from './upcCache.js'
import { EBAY_UPC_PREFIX } from './ebayUpc.js'
import { UPCITEMDB_UPC_PREFIX } from './upcitemdbUpc.js'

function makeKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    _store: store,
    async get(k: string) { return store.has(k) ? store.get(k)! : null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as any
}

describe('upcCacheKeys / upcCacheForms', () => {
  it('covers BOTH external rungs — a bust that missed one leaves the ladder pinned', () => {
    expect(upcCacheKeys('196214136144')).toEqual([
      `${EBAY_UPC_PREFIX}196214136144`,
      `${UPCITEMDB_UPC_PREFIX}196214136144`,
    ])
  })
  it('covers BOTH barcode forms — the rungs cache under whatever form the scanner sent', () => {
    expect(upcCacheForms('196214136144')).toEqual(['196214136144', '0196214136144'])
    expect(upcCacheForms('0196214136144')).toEqual(['0196214136144', '196214136144'])
    expect(upcCacheForms('12345678')).toEqual(['12345678'])   // other lengths query as-is
  })
})

describe('invalidateUpcCache', () => {
  it('deletes every rung × every barcode form, and reports a truthful count', async () => {
    const kv = makeKV({
      [`${EBAY_UPC_PREFIX}196214136144`]: '{"found":false}',
      [`${UPCITEMDB_UPC_PREFIX}0196214136144`]: '{"found":false}',
      'unrelated:key': 'keep me',
    })
    const res = await invalidateUpcCache(kv, '196214136144')
    expect(res.deleted).toBe(2)
    expect(res.keys).toHaveLength(4)   // 2 forms × 2 rungs
    expect(kv._store.has(`${EBAY_UPC_PREFIX}196214136144`)).toBe(false)
    expect(kv._store.has(`${UPCITEMDB_UPC_PREFIX}0196214136144`)).toBe(false)
    expect(kv._store.get('unrelated:key')).toBe('keep me')
  })

  it('is IDEMPOTENT — a second bust deletes nothing and is still ok', async () => {
    const kv = makeKV({ [`${EBAY_UPC_PREFIX}196214136144`]: '{"found":false}' })
    expect((await invalidateUpcCache(kv, '196214136144')).deleted).toBe(1)
    const again = await invalidateUpcCache(kv, '196214136144')
    expect(again).toMatchObject({ ok: true, deleted: 0 })
  })

  it('no KV binding → ok with skipped:no_kv, never a throw', async () => {
    expect(await invalidateUpcCache(undefined, '196214136144'))
      .toMatchObject({ ok: true, deleted: 0, skipped: 'no_kv' })
  })

  it('a KV failure on ONE key never aborts the rest, and warns rather than errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = makeKV({ [`${UPCITEMDB_UPC_PREFIX}196214136144`]: '{"found":false}' })
    const realDelete = kv.delete.bind(kv)
    kv.delete = async (k: string) => {
      if (k.startsWith(EBAY_UPC_PREFIX)) throw new Error('kv down')
      return realDelete(k)
    }
    const res = await invalidateUpcCache(kv, '196214136144')
    expect(res.ok).toBe(true)
    expect(kv._store.has(`${UPCITEMDB_UPC_PREFIX}196214136144`)).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore(); error.mockRestore()
  })
})
