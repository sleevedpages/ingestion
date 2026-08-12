#!/usr/bin/env node
/**
 * audit-extended-data.mjs — survey TCGCSV `extendedData` shapes across every ingested game.
 *
 * The reproducible form of the diagnostic behind Content migration 0125. Read-only, no
 * credentials, no D1 access, never wired to a cron. Re-run it before changing anything in
 * `src/lib/productAttributes.ts` or the read-side facet map — TCGplayer's per-game key sets drift.
 *
 * Findings + the schema decisions they drove:
 *   Content/docs/audits/2026-08-11_tcgcsv-extended-data-diagnostic.md
 *
 *   node scripts/audit-extended-data.mjs --summary
 *   node scripts/audit-extended-data.mjs --out ed.json
 *   node scripts/audit-extended-data.mjs --games Magic,Pokemon --sets 6 --summary
 *
 * ⚠️ TCGCSV returns 401 without a User-Agent header. A bare `fetch()` probe will look like an auth
 * problem and is not.
 */
import { writeFileSync } from 'node:fs';

const BASE = 'https://tcgcsv.com';
const USER_AGENT = 'SleevedPages/1.0.0';

// Mirrors prod `tcg_supported_games` (label -> match terms) as of 2026-08-11. Category resolution
// uses the SAME substring logic as src/ingestion/categories.ts matchCategory(), so the sample comes
// from exactly the categories runIngestion() would sync.
const SUPPORTED = [
  ['Digimon',           ['Digimon', 'Digimon Card Game']],
  ['Dragon Ball Super', ['Dragon Ball Super Fusion World', 'Dragon Ball']],
  ['Flesh & Blood',     ['Flesh & Blood', 'Flesh & Blood TCG']],
  ['Gundam',            ['Gundam Card Game', 'Gundam']],
  ['Lorcana',           ['Lorcana']],
  ['Magic',             ['Magic']],
  ['One Piece',         ['One Piece']],
  ['Pokemon',           ['Pokemon']],
  ['Pokemon Japan',     ['Pokemon Japan']],
  ['Riftbound',         ['Riftbound']],
  ['Yu-Gi-Oh!',         ['yugioh', 'yu-gi-oh']],
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const OUT      = arg('out');
const SUMMARY  = process.argv.includes('--summary');
const SET_COUNT = Number(arg('sets', '4'));
const ONLY     = arg('games') ? arg('games').split(',').map(s => s.trim().toLowerCase()) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  await sleep(120); // the worker's own 100ms floor, with headroom
  const res = await fetch(BASE + path, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function matchCategory(results, term) {
  const lower = term.toLowerCase();
  return results.find(
    c => c.name.toLowerCase().includes(lower) || (c.displayName ?? '').toLowerCase().includes(lower)
  );
}

const HTML_RE = /<[^>]+>|&[a-z]+;|&#\d+;/i;

const cats = await get('/tcgplayer/categories');
const report = {};

for (const [label, terms] of SUPPORTED) {
  if (ONLY && !ONLY.includes(label.toLowerCase())) continue;

  let cat;
  for (const t of terms) { cat = matchCategory(cats.results, t); if (cat) break; }
  if (!cat) { report[label] = { error: 'category not resolved' }; continue; }

  const groups = (await get(`/tcgplayer/${cat.categoryId}/groups`)).results;
  // Spread the sample across eras — the key set has drifted over time within a game.
  const sorted = [...groups].sort((a, b) =>
    String(b.publishedOn ?? '').localeCompare(String(a.publishedOn ?? ''))
  );
  const picks = [];
  const push = g => { if (g && !picks.some(p => p.groupId === g.groupId)) picks.push(g); };
  for (let i = 0; i < Math.max(0, SET_COUNT - 2); i++) push(sorted[i]);
  push(sorted[Math.floor(sorted.length / 2)]);
  push(sorted[sorted.length - 1]);

  const keys = {};
  let products = 0;
  let noExtended = 0;
  let duplicateKeys = 0;
  let maxKeysOnOneProduct = 0;
  const sampledGroups = [];

  for (const g of picks) {
    let prods;
    try {
      prods = (await get(`/tcgplayer/${cat.categoryId}/${g.groupId}/products`)).results;
    } catch (e) {
      sampledGroups.push({ groupId: g.groupId, name: g.name, error: String(e) });
      continue;
    }
    sampledGroups.push({ groupId: g.groupId, name: g.name, publishedOn: g.publishedOn, products: prods.length });

    for (const p of prods) {
      products++;
      const ed = p.extendedData;
      if (!Array.isArray(ed) || ed.length === 0) { noExtended++; continue; }
      maxKeysOnOneProduct = Math.max(maxKeysOnOneProduct, ed.length);
      const seen = new Set();
      for (const f of ed) {
        if (seen.has(f.name)) duplicateKeys++;
        seen.add(f.name);
        const rec = (keys[f.name] ||= {
          displayName: f.displayName, count: 0, values: new Map(),
          maxLen: 0, html: 0, multiline: 0, delimiter: 0, numeric: 0, empty: 0,
        });
        rec.count++;
        const v = f.value == null ? '' : String(f.value);
        if (v === '') rec.empty++;
        rec.maxLen = Math.max(rec.maxLen, v.length);
        if (HTML_RE.test(v)) rec.html++;
        if (/[\r\n]/.test(v)) rec.multiline++;
        if (/[,;·]|\s\/\s/.test(v)) rec.delimiter++;
        if (/^-?\d+(\.\d+)?$/.test(v.trim())) rec.numeric++;
        if (rec.values.size < 400) rec.values.set(v, (rec.values.get(v) ?? 0) + 1);
      }
    }
  }

  report[label] = {
    categoryId: cat.categoryId,
    categoryName: cat.name,
    totalGroups: groups.length,
    sampledGroups,
    productsSampled: products,
    productsWithNoExtendedData: noExtended,
    duplicateKeys,
    maxKeysOnOneProduct,
    keys: Object.entries(keys)
      .map(([name, r]) => ({
        name,
        displayName: r.displayName,
        count: r.count,
        pct: products ? +((r.count / products) * 100).toFixed(1) : 0,
        distinctSeen: r.values.size,
        maxLen: r.maxLen,
        emptyValues: r.empty,
        htmlHits: r.html,
        multilineHits: r.multiline,
        delimiterHits: r.delimiter,
        numericHits: r.numeric,
        samples: [...r.values.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([v, n]) => `${JSON.stringify(v.length > 160 ? v.slice(0, 160) + '…' : v)} x${n}`),
      }))
      .sort((a, b) => b.count - a.count),
  };

  if (SUMMARY) {
    const r = report[label];
    console.log(`\n==== ${label}  category=${r.categoryId}  sets=${r.totalGroups}  sampled=${r.productsSampled} products  emptyExtendedData=${r.productsWithNoExtendedData}  dupKeys=${r.duplicateKeys}  maxKeys=${r.maxKeysOnOneProduct}`);
    for (const k of r.keys) {
      console.log(`   ${k.name} [${k.displayName}] ${k.pct}%  distinct=${k.distinctSeen} maxLen=${k.maxLen} html=${k.htmlHits} nl=${k.multilineHits} delim=${k.delimiterHits}`);
      console.log(`      ${k.samples.slice(0, 6).join('  ')}`);
    }
  } else {
    console.error(`done ${label}: ${products} products, ${Object.keys(keys).length} keys`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error(`written ${OUT}`);
} else if (!SUMMARY) {
  process.stdout.write(JSON.stringify(report, null, 2));
}
