import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./ingestion/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ingestion/index.js')>()
  return { ...actual, runIngestion: vi.fn(async () => ({})) }
})

vi.mock('./image-mirror.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./image-mirror.js')>()
  return {
    ...actual,
    runMirrorJob: vi.fn(async () => ({ processed: 0, mirrored: 0, failed: 0, has_more: false })),
    getPendingCards: vi.fn(async () => []),
    uploadCardImage: vi.fn(async () => 'https://images.sleevedpages.com/cards/1.jpg'),
  }
})

import worker from './worker.js'
import { runIngestion } from './ingestion/index.js'
import { runMirrorJob, getPendingCards, uploadCardImage } from './image-mirror.js'

afterEach(() => {
  vi.clearAllMocks()
})

const SECRET = 'test-secret'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as any,
    IMAGES_BUCKET: {} as any,
    INGESTION_WORKER_SECRET: SECRET,
    ...overrides,
  } as any
}

function fakeCtx() {
  return { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}) } } as any
}

describe('worker.ts — WP-0 auth on /sync, /mirror, /mirror/pending, /mirror/upload', () => {
  const cases: Array<{ path: string; method: string; body?: unknown }> = [
    { path: '/sync', method: 'POST' },
    { path: '/mirror', method: 'POST' },
    { path: '/mirror/pending?limit=5', method: 'GET' },
    {
      path: '/mirror/upload',
      method: 'POST',
      body: { tcgplayer_product_id: 1, imageBase64: btoa('x'), contentType: 'image/jpeg', source: 'tcgplayer' },
    },
  ]

  for (const c of cases) {
    it(`${c.method} ${c.path} → 401 with no secret header`, async () => {
      const req = new Request(`https://worker.test${c.path}`, {
        method: c.method,
        headers: c.body ? { 'content-type': 'application/json' } : undefined,
        body: c.body ? JSON.stringify(c.body) : undefined,
      })
      const res = await worker.fetch(req, makeEnv(), fakeCtx())
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data).toEqual({ ok: false, error: 'Unauthorized' })
    })

    it(`${c.method} ${c.path} → 401 with a wrong secret header`, async () => {
      const req = new Request(`https://worker.test${c.path}`, {
        method: c.method,
        headers: {
          ...(c.body ? { 'content-type': 'application/json' } : {}),
          'x-worker-secret': 'wrong',
        },
        body: c.body ? JSON.stringify(c.body) : undefined,
      })
      const res = await worker.fetch(req, makeEnv(), fakeCtx())
      expect(res.status).toBe(401)
    })

    it(`${c.method} ${c.path} → 401 when INGESTION_WORKER_SECRET is not configured, even with a header`, async () => {
      const req = new Request(`https://worker.test${c.path}`, {
        method: c.method,
        headers: {
          ...(c.body ? { 'content-type': 'application/json' } : {}),
          'x-worker-secret': SECRET,
        },
        body: c.body ? JSON.stringify(c.body) : undefined,
      })
      const res = await worker.fetch(req, makeEnv({ INGESTION_WORKER_SECRET: undefined }), fakeCtx())
      expect(res.status).toBe(401)
    })

    it(`${c.method} ${c.path} → succeeds with the correct secret header`, async () => {
      const req = new Request(`https://worker.test${c.path}`, {
        method: c.method,
        headers: {
          ...(c.body ? { 'content-type': 'application/json' } : {}),
          'x-worker-secret': SECRET,
        },
        body: c.body ? JSON.stringify(c.body) : undefined,
      })
      const res = await worker.fetch(req, makeEnv(), fakeCtx())
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
    })
  }

  it('POST /sync starts runIngestion in the background', async () => {
    const req = new Request('https://worker.test/sync', {
      method: 'POST',
      headers: { 'x-worker-secret': SECRET },
    })
    const res = await worker.fetch(req, makeEnv(), fakeCtx())
    expect(res.status).toBe(200)
    expect(runIngestion).toHaveBeenCalledTimes(1)
  })

  it('POST /mirror runs one mirror batch', async () => {
    const req = new Request('https://worker.test/mirror', {
      method: 'POST',
      headers: { 'x-worker-secret': SECRET },
    })
    const res = await worker.fetch(req, makeEnv(), fakeCtx())
    expect(res.status).toBe(200)
    expect(runMirrorJob).toHaveBeenCalledTimes(1)
  })

  it('GET /mirror/pending returns pending cards', async () => {
    const req = new Request('https://worker.test/mirror/pending?limit=5', {
      method: 'GET',
      headers: { 'x-worker-secret': SECRET },
    })
    const res = await worker.fetch(req, makeEnv(), fakeCtx())
    expect(res.status).toBe(200)
    expect(getPendingCards).toHaveBeenCalledTimes(1)
  })

  it('POST /mirror/upload writes the image via uploadCardImage', async () => {
    const req = new Request('https://worker.test/mirror/upload', {
      method: 'POST',
      headers: { 'x-worker-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ tcgplayer_product_id: 1, imageBase64: btoa('x'), contentType: 'image/jpeg', source: 'tcgplayer' }),
    })
    const res = await worker.fetch(req, makeEnv(), fakeCtx())
    expect(res.status).toBe(200)
    expect(uploadCardImage).toHaveBeenCalledTimes(1)
  })
})
