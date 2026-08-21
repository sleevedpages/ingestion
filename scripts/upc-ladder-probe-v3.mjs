#!/usr/bin/env node
/**
 * upc-ladder-probe.mjs v3 — SleevedPages sealed-UPC resolution ladder diagnostic
 *
 * v3 changes:
 *  - D1 output parsing FIXED. v2 grabbed wrangler's summary block ("Rows read: 200") instead
 *    of the results array; v3 scans every JSON block in the output and picks the one carrying
 *    `results`, falling back to printing the raw text.
 *  - NEW: `wrangler secret list` on the Ingestion project (confirms the eBay app-token secrets).
 *  - NEW: KV listing for the resolver cache keys (the cached-miss that pins a UPC to found:false).
 *  - NEW: source dump of the two worker resolvers, so the match logic and cache TTL can be read
 *    directly instead of inferred.
 *
 * Zero dependencies. Node 18+. READ-ONLY — no writes, no secret values printed, no cache deletes.
 *
 * USAGE (from anywhere; paths below are the defaults for a standard checkout)
 *   node upc-ladder-probe-v3.mjs 196214136144 ^
 *     --ingestion G:\SleevedPages\Ingestion ^
 *     --content-dir G:\SleevedPages\Content
 *
 * FLAGS
 *   --ingestion <dir>    Ingestion project root (wrangler secret list, KV, source dump, .dev.vars)
 *   --content-dir <dir>  directory holding the wrangler config with the D1 binding
 *   --worker <url>       worker origin        (else env WORKER_URL / .dev.vars INGESTION_WORKER_URL)
 *   --secret <s>         x-worker-secret      (else env WORKER_SECRET / .dev.vars)
 *   --cookie <c>         session cookie, enables P4
 *   --content <url>      Content origin (default https://sleevedpages.com)
 *   --db <name>          D1 database (default sleevedpagesdb);  --local => sleevedpagesdb-uat
 *   --skip-d1 --skip-kv --skip-src --json
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWorkerSecret } from './lib/workerSecret.mjs';

// ---------------------------------------------------------------- config

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const INGESTION_DIR = opt('--ingestion', process.cwd());
const CONTENT_DIR = opt('--content-dir', '');

function loadLocalVars() {
  const found = {};
  const dirs = ['.', '..', '../..', '../../..', INGESTION_DIR];
  for (const dir of dirs) {
    for (const file of ['.dev.vars', '.env']) {
      let p;
      try { p = resolve(dir, file); } catch { continue; }
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const val = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in found) && val) { found[m[1]] = val; found[`__src_${m[1]}`] = p; }
      }
    }
  }
  return found;
}
const localVars = loadLocalVars();

const UPCS = args.filter((a) => /^\d{8,14}$/.test(a));
const WORKER_URL = opt('--worker', process.env.WORKER_URL || localVars.INGESTION_WORKER_URL
  || 'https://sleevedpages-ingestion.sleevedpages.workers.dev');
// ⛔ NEVER hardcode the secret here. It WAS hardcoded in this file (found 2026-08-21 — the
// third occurrence of the mistake `scripts/lib/workerSecret.mjs` exists to prevent). The file
// was never committed, so nothing leaked to git, but it sits in a directory that is otherwise
// tracked and one `git add scripts/` would have published a credential that grants every admin
// endpoint plus R2 writes. Resolve it the ONE supported way: env var, else the gitignored
// `Ingestion/.dev.vars`.
const WORKER_SECRET = opt('--secret', resolveWorkerSecret({ required: false, scriptName: 'upc-ladder-probe-v3.mjs' }) || '');
const SESSION_COOKIE = opt('--cookie', process.env.SESSION_COOKIE || '');
const CONTENT_URL = opt('--content', 'https://sleevedpages.com').replace(/\/+$/, '');
const DB = flag('--local') ? 'sleevedpagesdb-uat' : opt('--db', 'sleevedpagesdb');
const SKIP_D1 = flag('--skip-d1');
const SKIP_KV = flag('--skip-kv');
const SKIP_SRC = flag('--skip-src');
const JSON_ONLY = flag('--json');
const TIMEOUT_MS = 15000;
const BODY_CLIP = 2000;
const SRC_CLIP = 24000;

if (UPCS.length === 0) {
  console.error('No UPC supplied. Example: node upc-ladder-probe-v3.mjs 196214136144 --ingestion G:\\SleevedPages\\Ingestion');
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

const report = { version: 3, ranAt: new Date().toISOString(), db: DB, probes: [] };
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };
const rule = (t = '') => log('\n' + '─'.repeat(72) + (t ? `\n${t}` : ''));

function redact(s) {
  let out = String(s ?? '');
  for (const secret of [WORKER_SECRET, SESSION_COOKIE]) {
    if (secret && secret.length > 6) out = out.split(secret).join('«redacted»');
  }
  return out;
}
const clip = (s, max = BODY_CLIP) => {
  const t = redact(s);
  return t.length > max ? `${t.slice(0, max)}\n…[${t.length - max} more chars]` : t;
};

/** Pull every balanced top-level JSON block out of mixed CLI output. */
function jsonBlocks(text) {
  const blocks = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { blocks.push(JSON.parse(text.slice(i, j + 1))); } catch { /* not JSON */ }
          i = j;
          break;
        }
      }
    }
  }
  return blocks;
}

/** wrangler's --json emits a summary block AND a results block; we want the results one. */
function pickResults(text) {
  const blocks = jsonBlocks(text);
  for (const b of blocks) {
    const arr = Array.isArray(b) ? b : [b];
    for (const el of arr) {
      if (el && typeof el === 'object' && Array.isArray(el.results)) return el.results;
    }
  }
  // Some versions emit a bare array of row objects that isn't the summary table.
  for (const b of blocks) {
    if (Array.isArray(b) && b.length && !('Total queries executed' in (b[0] || {}))) return b;
  }
  return null;
}

async function probe(name, url, { headers = {}, note = '' } = {}) {
  const started = Date.now();
  const entry = { probe: name, url: redact(url), note };
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'sleevedpages-upc-probe/3', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    entry.status = res.status;
    entry.ms = Date.now() - started;
    const interesting = ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'content-type', 'cf-ray'];
    entry.headers = Object.fromEntries(interesting.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v != null));
    const text = await res.text();
    entry.bytes = text.length;
    try { entry.body = JSON.parse(text); } catch { entry.bodyText = clip(text); }
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = redact(err?.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS}ms` : err?.message || String(err));
  }
  report.probes.push(entry);
  log(`\n▸ ${name}\n  ${entry.error ? `ERROR ${entry.error}` : `HTTP ${entry.status} · ${entry.ms}ms · ${entry.bytes}B`}`);
  if (Object.keys(entry.headers || {}).length) log(`  headers: ${JSON.stringify(entry.headers)}`);
  if (entry.body !== undefined) log(`  body: ${clip(JSON.stringify(entry.body, null, 2))}`);
  else if (entry.bodyText) log(`  body: ${entry.bodyText}`);
  return entry;
}

function sh(label, cmdline, { cwd, timeout = 180000 } = {}) {
  const entry = { probe: label, cmd: redact(cmdline), cwd: cwd || process.cwd() };
  const started = Date.now();
  const r = spawnSync(cmdline, { encoding: 'utf8', shell: true, timeout, cwd: cwd || undefined });
  entry.ms = Date.now() - started;
  entry.exit = r.status;
  entry.out = clip(`${r.stdout || ''}${r.stderr || ''}`, 6000);
  report.probes.push(entry);
  log(`\n▸ ${label}  (${entry.ms}ms, exit ${entry.exit})\n${entry.out.split('\n').map((l) => `  ${l}`).join('\n')}`);
  return entry;
}

const TMP = mkdtempSync(join(tmpdir(), 'upcprobe-'));
let qn = 0;

function d1(label, sql) {
  const entry = { probe: `D1 ${label}`, sql };
  const file = join(TMP, `q${++qn}.sql`);
  writeFileSync(file, sql, 'utf8');
  const cwdArg = CONTENT_DIR ? ` --cwd "${CONTENT_DIR}"` : '';
  const started = Date.now();
  const r = spawnSync(
    `npx wrangler d1 execute ${DB} --remote --json -y --file "${file}"${cwdArg}`,
    { encoding: 'utf8', shell: true, timeout: 180000 },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  entry.ms = Date.now() - started;
  entry.exit = r.status;
  if (r.error || r.status !== 0) {
    entry.error = redact(r.error?.message || `wrangler exited ${r.status}`);
    entry.raw = clip(out, 4000);
  } else {
    const rows = pickResults(out);
    if (rows) entry.rows = rows;
    else entry.raw = clip(out, 4000);
  }
  report.probes.push(entry);
  log(`\n▸ D1 ${label}  (${entry.ms}ms, exit ${entry.exit})`);
  log(entry.error ? `  ERROR ${entry.error}\n  ${entry.raw || ''}` : `  ${clip(JSON.stringify(entry.rows ?? entry.raw, null, 2), 4000)}`);
  return entry;
}

function dumpSource(relPaths) {
  for (const rel of relPaths) {
    const p = resolve(INGESTION_DIR, rel);
    const entry = { probe: `SRC ${rel}`, path: p };
    if (!existsSync(p)) {
      entry.error = 'not found';
      // Help locate it if the layout differs.
      try {
        const dir = resolve(INGESTION_DIR, 'src/lib');
        if (existsSync(dir)) entry.siblings = readdirSync(dir).filter((f) => /upc|ebay/i.test(f));
      } catch { /* ignore */ }
      report.probes.push(entry);
      log(`\n▸ SRC ${rel}\n  NOT FOUND at ${p}${entry.siblings ? `\n  candidates in src/lib: ${entry.siblings.join(', ')}` : ''}`);
      continue;
    }
    const text = readFileSync(p, 'utf8');
    entry.bytes = text.length;
    entry.source = clip(text, SRC_CLIP);
    report.probes.push(entry);
    log(`\n▸ SRC ${rel}  (${entry.bytes} bytes)\n${entry.source.split('\n').map((l) => `  | ${l}`).join('\n')}`);
  }
}

// ---------------------------------------------------------------- run

log('SleevedPages — sealed UPC resolution ladder probe (v3)');
log(`when:      ${report.ranAt}`);
log(`upcs:      ${UPCS.join(', ')}`);
log(`worker:    ${WORKER_URL || '(NOT SET — pass --worker)'}`);
log(`secret:    ${WORKER_SECRET ? 'set' : 'NOT SET'}`);
log(`ingestion: ${INGESTION_DIR}`);
log(`d1:        ${SKIP_D1 ? 'skipped' : `${DB}${CONTENT_DIR ? ` (wrangler cwd ${CONTENT_DIR})` : ''}`}`);

// --- A. Which secrets does the deployed worker actually have? -------------
rule('A. Worker secret inventory (names only — values are never exposed by wrangler)');
sh('wrangler secret list (Ingestion)', 'npx wrangler secret list', { cwd: INGESTION_DIR, timeout: 120000 });

// --- B. The resolver source: match logic + cache policy -------------------
if (!SKIP_SRC) {
  rule('B. Resolver source');
  dumpSource(['src/lib/upcitemdbUpc.ts', 'src/lib/ebayUpc.ts', 'src/lib/upcLookup.ts', 'src/lib/upcMatch.ts']);
}

// --- C. Live rung probes --------------------------------------------------
for (const upc of UPCS) {
  rule(`C. UPC ${upc}`);
  const forms = new Set([upc]);
  if (upc.length === 13 && upc.startsWith('0')) forms.add(upc.slice(1));
  if (upc.length === 12) forms.add(`0${upc}`);
  log(`  query forms: ${[...forms].join(', ')}`);

  await probe(`P1 upcitemdb trial API (direct, this machine's IP) — ${upc}`,
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`);

  if (WORKER_URL) {
    const h = WORKER_SECRET ? { 'x-worker-secret': WORKER_SECRET } : {};
    await probe(`P2 worker rung 3 — /upcitemdb/upc — ${upc}`, `${WORKER_URL}/upcitemdb/upc?upc=${upc}`, { headers: h });
    await probe(`P3 worker rung 2 — /ebay/upc — ${upc}`, `${WORKER_URL}/ebay/upc?upc=${upc}`, { headers: h });
  }

  if (SESSION_COOKIE) {
    await probe(`P4 Content full ladder — ${upc}`, `${CONTENT_URL}/api/products/upc-lookup?upc=${upc}`,
      { headers: { cookie: SESSION_COOKIE } });
  }

  if (!SKIP_D1) {
    const list = [...forms].map((f) => `'${f}'`).join(',');
    d1(`product_upcs rows for ${upc}`,
      `SELECT id, upc, canonical_product_id, source, confidence, created_at FROM product_upcs WHERE upc IN (${list});`);
  }
}

// --- D. Is there anything to match against? -------------------------------
if (!SKIP_D1) {
  rule('D. Catalogue + map state');
  d1('product_upcs totals by source', 'SELECT source, COUNT(*) AS n FROM product_upcs GROUP BY source ORDER BY n DESC;');
  d1('sealed catalogue — Mega Evolution', "SELECT id, name, product_kind, tcgplayer_product_id FROM products WHERE product_kind='sealed' AND LOWER(name) LIKE '%mega evolution%' LIMIT 25;");
  d1('sealed catalogue — recent booster boxes', "SELECT id, name FROM products WHERE product_kind='sealed' AND LOWER(name) LIKE '%booster box%' ORDER BY id DESC LIMIT 15;");
  d1('sealed catalogue size', "SELECT COUNT(*) AS sealed_products FROM products WHERE product_kind='sealed';");
  d1('pricecharting UPC coverage', 'SELECT COUNT(*) AS with_upc FROM pricecharting_products WHERE upc IS NOT NULL;');
}

// --- E. The cached miss ---------------------------------------------------
if (!SKIP_KV) {
  rule('E. KV cache state (read-only listing — nothing is deleted)');
  for (const prefix of ['upcitemdb', 'ebay_upc', 'upc']) {
    sh(`kv key list --prefix ${prefix}`,
      `npx wrangler kv key list --binding SLEEVEDPAGES_KV --remote --prefix "${prefix}"`,
      { cwd: INGESTION_DIR, timeout: 120000 });
  }
}

rule('MACHINE-READABLE REPORT — paste everything below this line');
console.log(JSON.stringify(report, null, 2));
