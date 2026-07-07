import { describe, it, expect, vi, beforeEach } from 'vitest'

// WP-2 (audit IMG-3): the weekly pipeline must run the MIRROR FIRST — the
// 2026-07-05 run died inside the Scrydex sync stages and the mirror never
// executed. This test pins the stage order.

const calls: string[] = []

vi.mock('./image-mirror.js', () => ({
  runMirrorJob: vi.fn(async () => { calls.push('mirror'); return {} }),
}))
vi.mock('./scrydexSetMapping.js', () => ({
  syncScrydexSetMappings: vi.fn(async () => { calls.push('set-mappings') }),
}))
vi.mock('./scrydexImageSync.js', () => ({
  syncScrydexImages: vi.fn(async () => { calls.push('image-sync') }),
}))
vi.mock('./lib/scrydexClient.js', () => ({
  cleanupScrydexApiLog: vi.fn(async () => { calls.push('cleanup') }),
}))

import { runWeeklyImagePipeline } from './adminJobs.js'

beforeEach(() => { calls.length = 0 })

describe('runWeeklyImagePipeline — mirror-first stage order (WP-2)', () => {
  it('runs mirror → set-mappings → image-sync → cleanup when Scrydex keys are present', async () => {
    const env = { DB: {} as any, IMAGES_BUCKET: {} as any, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any
    await runWeeklyImagePipeline(env)
    expect(calls).toEqual(['mirror', 'set-mappings', 'image-sync', 'cleanup'])
  })

  it('runs mirror → cleanup when Scrydex keys are absent (UAT shape)', async () => {
    const env = { DB: {} as any, IMAGES_BUCKET: {} as any } as any
    await runWeeklyImagePipeline(env)
    expect(calls).toEqual(['mirror', 'cleanup'])
  })

  it('a mirror-stage failure does not stop the later stages (each stage is caught)', async () => {
    const { runMirrorJob } = await import('./image-mirror.js')
    ;(runMirrorJob as any).mockImplementationOnce(async () => { calls.push('mirror'); throw new Error('boom') })
    const env = { DB: {} as any, IMAGES_BUCKET: {} as any, SCRYDEX_API_KEY: 'k', SCRYDEX_TEAM_ID: 't' } as any
    await runWeeklyImagePipeline(env)
    expect(calls).toEqual(['mirror', 'set-mappings', 'image-sync', 'cleanup'])
  })
})
