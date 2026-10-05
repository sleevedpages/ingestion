// The ONE-GAME TCG sync (admin "Sync now" on a supported game — POST /admin/sync-game).
//
// runIngestion with `onlyLabel`, the HTTP client and the DB layer mocked. Pins:
//   • only THAT game's category is resolved, upserted and enqueued — no other game is touched;
//   • it ALWAYS runs: the "TCGCSV unchanged since the last sync" early exit is skipped;
//   • it writes NO tcg_sync_log row (no createSyncLog / setGroupsEnqueued / updateSyncLog), so it
//     can never become the "last successful sync" the daily full run's change detection reads,
//     and its messages carry syncLogId 0 (each consumer's progress UPDATE then matches no row);
//   • an unknown / disabled label, or terms that match no TCGCSV category, throw (the runStage
//     row records the error) and enqueue nothing;
//   • the FULL run is unchanged: it still writes its log row and still exits early when TCGCSV
//     has not updated.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  lastUpdated: '2026-10-05T00:00:00.000Z',
  lastSync: new Date('2026-10-05T06:44:50.215Z') as Date | null,
  supported: [] as Array<{ label: string; terms: string[] }>,
}))

vi.mock('./http.js', () => ({
  RateLimitedClient: class {
    async getText() { return state.lastUpdated }
    async get(path: string) {
      if (path === '/tcgplayer/categories') {
        return { results: [
          { categoryId: 3, name: 'Pokemon', displayName: 'Pokemon', modifiedOn: '', image: '', seoText: null, isDirectBrand: false },
          { categoryId: 81, name: 'Union Arena', displayName: 'Union Arena', modifiedOn: '', image: '', seoText: null, isDirectBrand: false },
        ] }
      }
      const m = /^\/tcgplayer\/(\d+)\/groups$/.exec(path)
      if (m) {
        const categoryId = Number(m[1])
        const base = categoryId * 1000
        return { results: [1, 2, 3].map(i => ({ groupId: base + i, categoryId, name: `Set ${base + i}`, isSupplemental: false })) }
      }
      throw new Error(`unexpected path ${path}`)
    }
  },
}))

vi.mock('./db.js', () => ({
  upsertCategory: vi.fn(async () => {}),
  upsertSetsBatch: vi.fn(async () => {}),
  upsertProducts: vi.fn(async () => 0),
  upsertProductSourceImages: vi.fn(async () => {}),
  syncProductAttributes: vi.fn(async () => ({})),
  upsertPrices: vi.fn(async () => 0),
  createSyncLog: vi.fn(async () => 42),
  updateSyncLog: vi.fn(async () => {}),
  setGroupsEnqueued: vi.fn(async () => {}),
  updateSyncLogProgress: vi.fn(async () => {}),
  getLastSuccessfulSync: vi.fn(async () => state.lastSync),
}))

vi.mock('./categories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./categories.js')>()
  return { ...actual, loadSupportedTcgs: vi.fn(async () => state.supported) }
})
vi.mock('./price-config.js', () => ({ loadPriceConfig: vi.fn(async () => ({})) }))

import { runIngestion, type IngestionConfig } from './index.js'
import * as db from './db.js'

const SUPPORTED = [
  { label: 'Pokemon', terms: ['Pokemon'] },
  { label: 'Union Arena', terms: ['Union Arena'] },
]

let sent: Array<{ body: { tcgLabel: string; categoryId: number; syncLogId: number } }>
function config(extra: Partial<IngestionConfig> = {}): IngestionConfig {
  return {
    db: {} as D1Database,
    syncQueue: { sendBatch: async (msgs: typeof sent) => { sent.push(...msgs) } } as unknown as Queue<never>,
    tcgcsvBaseUrl: 'https://tcgcsv.test',
    logLevel: 'error',
    dryRun: false,
    backfillLimit: null,
    forceSync: false,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sent = []
  state.supported = SUPPORTED
  // TCGCSV has NOT updated since the last successful (full) sync — the full run would exit early.
  state.lastUpdated = '2026-10-05T00:00:00.000Z'
  state.lastSync = new Date('2026-10-05T06:44:50.215Z')
})

describe('a one-game run (onlyLabel)', () => {
  it('syncs ONLY that game, even though TCGCSV is unchanged since the last sync', async () => {
    const summary = await runIngestion(config({ onlyLabel: 'Union Arena' }))
    expect(summary).toEqual({ tcgsProcessed: ['Union Arena'], groupsEnqueued: 3, categoryIds: [81] })
    expect(sent.map(m => m.body.tcgLabel)).toEqual(['Union Arena', 'Union Arena', 'Union Arena'])
    expect(sent.every(m => m.body.categoryId === 81)).toBe(true)
    expect(db.upsertCategory).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.upsertCategory).mock.calls[0][1]).toMatchObject({ tcgplayer_category_id: 81 })
    const setRows = vi.mocked(db.upsertSetsBatch).mock.calls[0][1] as Array<{ tcgplayer_category_id: number }>
    expect(setRows).toHaveLength(3)
    expect(setRows.every(r => r.tcgplayer_category_id === 81)).toBe(true)
  })

  it('writes NO tcg_sync_log row — the daily full run\'s change detection never sees it', async () => {
    await runIngestion(config({ onlyLabel: 'Union Arena' }))
    expect(db.createSyncLog).not.toHaveBeenCalled()
    expect(db.setGroupsEnqueued).not.toHaveBeenCalled()
    expect(db.updateSyncLog).not.toHaveBeenCalled()
    expect(db.getLastSuccessfulSync).not.toHaveBeenCalled()
    // Its messages carry syncLogId 0: each consumer's progress UPDATE matches no row.
    expect(sent.every(m => m.body.syncLogId === 0)).toBe(true)
  })

  it('an unknown or disabled label (absent from the ENABLED list) throws and enqueues nothing', async () => {
    await expect(runIngestion(config({ onlyLabel: 'Cyberpunk' }))).rejects.toThrow(/No ENABLED supported game labelled "Cyberpunk"/)
    expect(sent).toEqual([])
    expect(db.upsertCategory).not.toHaveBeenCalled()
  })

  it('terms that match no TCGCSV category throw (the runStage row records why) and enqueue nothing', async () => {
    state.supported = [{ label: 'Union Arena', terms: ['Unoin Arena'] }]
    await expect(runIngestion(config({ onlyLabel: 'Union Arena' }))).rejects.toThrow(/matched no TCGCSV category/)
    expect(sent).toEqual([])
    expect(db.upsertSetsBatch).not.toHaveBeenCalled()
  })
})

describe('the full run is unchanged', () => {
  it('still exits early when TCGCSV has not updated since the last successful sync', async () => {
    const out = await runIngestion(config())
    expect(out).toBeUndefined()
    expect(db.createSyncLog).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('when TCGCSV has updated: every enabled game, ONE tcg_sync_log row, its id on every message', async () => {
    state.lastUpdated = '2026-10-06T00:00:00.000Z'
    const summary = await runIngestion(config())
    expect(summary).toEqual({ tcgsProcessed: ['Pokemon', 'Union Arena'], groupsEnqueued: 6, categoryIds: [3, 81] })
    expect(db.createSyncLog).toHaveBeenCalledTimes(1)
    expect(db.setGroupsEnqueued).toHaveBeenCalledWith(expect.anything(), 42, 6, ['Pokemon', 'Union Arena'])
    expect(sent.every(m => m.body.syncLogId === 42)).toBe(true)
  })
})
