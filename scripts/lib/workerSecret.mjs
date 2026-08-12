/**
 * workerSecret.mjs — resolve `INGESTION_WORKER_SECRET` for the operator scripts.
 *
 * WHY THIS EXISTS. Every admin endpoint on the worker is gated by this ONE shared secret (it is
 * also what Content sends us), so every runbook script needs it — and the awkwardness of exporting
 * an env var per shell is what pushes people to paste the live value into a tracked source file.
 * That has happened twice. This resolves it from, in order:
 *
 *   1. `process.env.INGESTION_WORKER_SECRET` — CI, or a one-off export;
 *   2. `Ingestion/.dev.vars` — the Cloudflare convention, ALREADY gitignored (alongside
 *      `.dev.vars.uat`, `.env*`), and already where `SCRYDEX_API_KEY` / `SCRYDEX_TEAM_ID` live.
 *
 * Add the line ONCE and no script ever asks again:
 *   INGESTION_WORKER_SECRET=<the value from `wrangler secret list` / your password manager>
 *
 * NEVER hardcode the value in a script: those files are version-controlled and shareable, and a
 * leaked worker secret grants writes to R2, the catalogue, and every admin job.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const KEY = 'INGESTION_WORKER_SECRET'
const DEV_VARS = fileURLToPath(new URL('../../.dev.vars', import.meta.url))

/** Parse a `.dev.vars` / dotenv-style file into a plain object. Missing file → {}. */
function readDevVars(path = DEV_VARS) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

/**
 * The secret, or `null` when it cannot be found (callers that only read data pass `required:false`).
 * Exits with actionable instructions when it is required and absent.
 */
export function resolveWorkerSecret({ required = true, scriptName = 'this script' } = {}) {
  const secret = process.env[KEY]?.trim() || readDevVars()[KEY]?.trim() || null
  if (secret || !required) return secret

  console.error(`  ✗ ${KEY} not found — ${scriptName} talks to the worker's admin endpoints.`)
  console.error('')
  console.error('    Easiest (once, then never again — .dev.vars is gitignored):')
  console.error(`      add a line to Ingestion/.dev.vars:   ${KEY}=<value>`)
  console.error('')
  console.error('    Or for one command:')
  console.error(`      bash:        ${KEY}=... node scripts/<script>.mjs`)
  console.error(`      PowerShell:  $env:${KEY}='...'; node scripts/<script>.mjs`)
  console.error('')
  console.error('    Get the value from your password manager, or rotate + re-set it with:')
  console.error(`      npx wrangler secret put ${KEY}`)
  console.error('    ⚠️ Never paste it into a script file — those are version-controlled.')
  process.exit(1)
}
