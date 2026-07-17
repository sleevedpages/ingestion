import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./scrydexSyncSet.js', () => ({ syncSingleSet: vi.fn() }))
vi.mock('./lib/imagePreference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/imagePreference.js')>()
  return { ...actual, loadImagePreferences: vi.fn() }
})

import { runScrydexImageRepairBatch } from './scrydexImageRepair.js'
import { syncSingleSet } from './scrydexSyncSet.js'
import { loadImagePreferences } from './lib/imagePreference.js'

const PREFS = [
  { label: 'One Piece', terms: ['One Piece'], preference: 'scrydex' as const },
  { label: 'Gundam',    terms: ['Gundam Card Game', 'Gundam'], preference: 'scrydex' as const },
  { label: 'Pokemon',   terms: ['Pokemon'], preference: 'tcgplayer' as const },
]

// Mapped sets across games — the repair must only ever touch the Bandai rows.
const SET_ROWS = [
  { id: 10, name: 'Scarlet & Violet',          game: 'Pokemon' },
  { id: 20, name: 'Awakening of the New Era',  game: 'One Piece Card Game' },
  { id: 30, name: 'Newtype Rising',            game: 'Gundam Card Game' },
]

function makeEnv() {
  return {
    DB: {
      prepare: (_sql: string) => ({
        bind: (cursor: number) => ({
          all: async () => ({ results: SET_ROWS.filter((r) => r.id > cursor) }),
        }),
      }),
    },
  } as any
}

beforeEach(() => {
  vi.mocked(loadImagePreferences).mockResolvedValue(PREFS)
  vi.mocked(syncSingleSet).mockReset()
})

describe('runScrydexImageRepairBatch', () => {
  it('processes ONE scrydex-preferred set per call (skipping tcgplayer-preferred games) and advances the cursor', async () => {
    vi.mocked(syncSingleSet).mockResolvedValue({
      ok: true, setId: 20, setName: 'Awakening of the New Era', scrydexExpansionId: 'OP05',
      cardsFetched: 150, imagesUpdated: 200, variantsConflicted: 0, requests: 1,
    })
    const out = await runScrydexImageRepairBatch(makeEnv(), 0)
    expect(syncSingleSet).toHaveBeenCalledTimes(1)
    expect(syncSingleSet).toHaveBeenCalledWith(expect.anything(), { setId: 20, force: true })
    expect(out.ok).toBe(true)
    expect(out.set?.setId).toBe(20)
    expect(out.cursorNext).toBe(20)
    expect(out.hasMore).toBe(true)
    expect(out.remaining).toBe(1)   // only the Gundam set remains — Pokemon is never in the pool
  })

  it('forces the sync (the daily drain keeps expansions price-fresh, which would skip image writes)', async () => {
    vi.mocked(syncSingleSet).mockResolvedValue({ ok: true, setId: 20, requests: 1 })
    await runScrydexImageRepairBatch(makeEnv(), 0)
    expect(vi.mocked(syncSingleSet).mock.calls[0][1]).toMatchObject({ force: true })
  })

  it('completes with hasMore:false when no scrydex-preferred sets are past the cursor', async () => {
    const out = await runScrydexImageRepairBatch(makeEnv(), 30)
    expect(out).toMatchObject({ ok: true, hasMore: false, cursorNext: 30, remaining: 0 })
    expect(syncSingleSet).not.toHaveBeenCalled()
  })

  it('does NOT advance the cursor on a failed set (retryable), and flags a credit-guard trip', async () => {
    vi.mocked(syncSingleSet).mockResolvedValue({ ok: false, error: 'Scrydex credit guard triggered' })
    const out = await runScrydexImageRepairBatch(makeEnv(), 10)
    expect(out.ok).toBe(false)
    expect(out.creditLimited).toBe(true)
    expect(out.cursorNext).toBe(10)
    expect(out.hasMore).toBe(true)
  })
})
