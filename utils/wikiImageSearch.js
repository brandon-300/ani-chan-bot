// ─── Keyless anime image discovery: Fandom wikis + Zerochan + Wikipedia ────
//
// WHY THIS FILE EXISTS (history, shortest version): Google's Custom Search
// JSON API is closed to new Cloud projects — confirmed, not a setup mistake;
// a new project gets a 403 "This project does not have access" no matter
// what the console says is enabled, and Bing's Image Search API was fully
// retired in August 2025. The previous backend here used Wikipedia's API,
// which works but has thin anime coverage (most anime characters simply
// have no Wikipedia article — that's why well-known cards like "Rias
// Gremory" came back with zero candidates).
//
// WHAT THIS VERSION DOES INSTEAD — three keyless sources, widest-first:
//
//   1. FANDOM (primary). Big anime wikis run the same MediaWiki software
//      as Wikipedia, so each wiki's api.php supports the exact
//      generator=search + prop=pageimages pattern this project already
//      proved works. Character articles carry infobox renders/official
//      art as page images. We query a curated list of the largest anime
//      wikis in small concurrent batches. A wiki that doesn't cover a
//      character just returns nothing — it's one silent miss among many,
//      not an error.
//   2. ZEROCHAN (secondary). Its JSON endpoint (?json) returns direct
//      hotlinkable image URLs plus per-image tags; entries tagged
//      "Official Art" / "Render" are boosted to the front, "Scan"/
//      "Screenshot" pushed to the back. The validator's Gemini Vision
//      check remains the real quality gate — this is only an ordering hint.
//   3. WIKIPEDIA (fallback). Kept from the previous version — when a
//      character DOES have an article, its infobox image is usually
//      excellent official art.
//
// CONTRACT WITH THE REST OF THE PIPELINE (unchanged): exports
// searchCandidateImages(name, series), isConfigured(), buildQuery() and
// returns candidates shaped { imageUrl, sourcePageUrl, title, snippet,
// displayLink, width, height, byteSize }. repairCardImages.js and
// utils/imageValidator.js need no changes — fandom.com, zerochan.net and
// wikipedia.org are all already in ACCEPTABLE_DOMAINS there.
//
// FAILURE MODEL: each source fails OPEN (logs a warning, contributes
// nothing) so one blocked/down site can't kill a batch on flaky mobile
// data. searchCandidateImages only throws if EVERY source failed —
// that's treated as "connection dead right now", and the repair script
// skips just that card and keeps going.
//
// UNCERTAINTY FLAGS (no live network in the sandbox this was written in):
//   - The Fandom query uses the long-stable MediaWiki conventions the
//     Wikipedia backend already uses in production here; subdomain drift
//     (a wiki renamed/moved) shows up as one silent empty source.
//   - Zerochan's ?json shape is its public frontend API; if it changes,
//     that source silently yields nothing and the log line below says so.
//   Neither case can corrupt anything — worst case is fewer candidates,
//   and the audit log still tells you exactly why.

const axios = require('axios');

const USER_AGENT = 'AniChanBot/1.0 (WhatsApp anime trading-card bot; run by a hobbyist on Termux)';
const REQUEST_TIMEOUT_MS = 15000;

const WIKI_LANG = process.env.WIKI_SEARCH_LANG || 'en';
const WIKI_API_URL = `https://${WIKI_LANG}.wikipedia.org/w/api.php`;

// ─── Tuning (env-overridable, same philosophy as repairCardImages.js) ──────
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
const PER_WIKI_RESULTS = clampInt(process.env.FANDOM_PER_WIKI, 2, 1, 5);
const WIKI_BATCH_SIZE = 4;            // concurrent api.php calls at a time
const ZEROCHAN_RESULTS = clampInt(process.env.ZEROCHAN_RESULTS, 8, 1, 15);
const MAX_TOTAL_CANDIDATES = clampInt(process.env.REPAIR_CANDIDATE_POOL, 12, 5, 20);

// Curated list of the largest anime-character wikis on Fandom. Order is
// roughly "most likely to cover a random character" — anime.fandom.com is
// the general Animepedia and catches a lot on its own. A wiki that has no
// article for the character just contributes zero results; dead/renamed
// subdomains are harmless (one silent miss). Prune/add based on what your
// audit logs actually hit — see the failure-model note above.
const FANDOM_WIKIS = [
  { host: 'anime.fandom.com', label: 'Animepedia' },
  { host: 'hero.fandom.com', label: 'Heroes Wiki' },
  { host: 'onepiece.fandom.com', label: 'One Piece Wiki' },
  { host: 'naruto.fandom.com', label: 'Narutopedia' },
  { host: 'dragonball.fandom.com', label: 'Dragon Ball Wiki' },
  { host: 'myheroacademia.fandom.com', label: 'My Hero Academia Wiki' },
  { host: 'kimetsu-no-yaiba.fandom.com', label: 'Kimetsu no Yaiba Wiki' },
  { host: 'jujutsu-kaisen.fandom.com', label: 'Jujutsu Kaisen Wiki' },
  { host: 'attackontitan.fandom.com', label: 'Attack on Titan Wiki' },
  { host: 'bleach.fandom.com', label: 'Bleach Wiki' },
  { host: 'fairytail.fandom.com', label: 'Fairy Tail Wiki' },
  { host: 'blackclover.fandom.com', label: 'Black Clover Wiki' },
  { host: 'rezero.fandom.com', label: 'Re:Zero Wiki' },
  { host: 'konosuba.fandom.com', label: 'KonoSuba Wiki' },
  { host: 'swordartonline.fandom.com', label: 'Sword Art Online Wiki' },
  { host: 'date-a-live.fandom.com', label: 'Date A Live Wiki' },
  { host: 'highschooldxd.fandom.com', label: 'High School DxD Wiki' },
  { host: 'typemoon.fandom.com', label: 'TYPE-MOON Wiki' },
  { host: 'fategrandorder.fandom.com', label: 'FGO Wiki' },
  { host: 'evangelion.fandom.com', label: 'EvaGeeks' },
  { host: 'gundam.fandom.com', label: 'Gundam Wiki' },
  { host: 'toarumajutsunoindex.fandom.com', label: 'Toaru Wiki' },
  { host: 'overlordmaruyama.fandom.com', label: 'Overlord Wiki' },
];

function isConfigured() {
  return true; // every source here is keyless — nothing to configure
}

function buildQuery(name, series) {
  return series ? `${name} ${series}` : name;
}

// Shared candidate shape → keeps repairCardImages.js / imageValidator.js
// completely backend-agnostic.
function toCandidate({ imageUrl, sourcePageUrl, title, snippet, displayLink, width, height }) {
  return {
    imageUrl,
    sourcePageUrl,
    title: String(title || '').trim(),
    snippet: String(snippet || '').trim(),
    displayLink,
    width: width || null,
    height: height || null,
    byteSize: null,
  };
}

// ─── Source 1: Fandom wikis (MediaWiki API, same pattern as Wikipedia) ─────
async function searchOneFandomWiki(host, label, query) {
  const res = await axios.get(`https://${host}/api.php`, {
    params: {
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: PER_WIKI_RESULTS,
      gsrnamespace: 0,               // articles only, not file pages
      prop: 'pageimages|info|extracts',
      piprop: 'original',            // full-resolution page image
      inprop: 'url',
      exintro: 1,
      explaintext: 1,
      exlimit: 'max',
      exchars: 300,
      format: 'json',
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const pages = res.data && res.data.query && res.data.query.pages;
  if (!pages) return [];

  return Object.values(pages)
    .filter(p => p.original && p.original.source)
    .map(p => toCandidate({
      imageUrl: p.original.source,
      sourcePageUrl: p.fullurl || `https://${host}/wiki/${encodeURIComponent(p.title)}`,
      title: p.title,
      snippet: p.extract || '',
      displayLink: host,
      width: p.original.width || null,
      height: p.original.height || null,
    }));
}

async function searchFandom(query) {
  const found = [];
  for (let i = 0; i < FANDOM_WIKIS.length; i += WIKI_BATCH_SIZE) {
    const batch = FANDOM_WIKIS.slice(i, i + WIKI_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(w => searchOneFandomWiki(w.host, w.label, query))
    );
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') {
        found.push(...s.value);
      } else {
        const reason = (s.reason && (s.reason.code || s.reason.message)) || 'unknown';
        // Expected noise level: a wiki without an article, a renamed
        // subdomain, a flaky-data timeout. One line each, batch continues.
        console.warn(`[wikiImageSearch] fandom:${batch[j].host} skipped (${reason})`);
      }
    });
  }
  return found;
}

// ─── Source 2: Zerochan JSON ────────────────────────────────────────────────
// Tag lookup: the character name IS the tag ("Rias Gremory"). Unknown tags
// return a 404/HTML page — both are treated as "no results", not an error.
function zerochanRank(item) {
  const tags = (item.tags || []).join(' ').toLowerCase();
  let r = 0;
  if (tags.includes('official art')) r -= 100; // best possible source type
  if (tags.includes('render')) r -= 50;
  if (tags.includes('scan')) r += 30;          // manga/book scans — deprioritize
  if (tags.includes('screenshot')) r += 30;
  return r;
}

async function searchZerochan(name) {
  const url = `https://zerochan.net/${encodeURIComponent(name)}?json`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
    // Zerochan answers unknown tags with its HTML site — don't blow up on it
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });

  const data = res.data;
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
  if (!items.length) return [];

  return items
    .filter(it => it && it.file && it.id != null)
    .sort((a, b) => zerochanRank(a) - zerochanRank(b))
    .slice(0, ZEROCHAN_RESULTS)
    .map(it => {
      const file = String(it.file);
      const imageUrl = file.startsWith('//') ? `https:${file}` : file;
      return toCandidate({
        imageUrl,
        sourcePageUrl: `https://zerochan.net/${it.id}`,
        title: (it.tags || []).slice(0, 6).join(', '),
        snippet: '',
        displayLink: 'zerochan.net',
        width: it.width || null,
        height: it.height || null,
      });
    });
}

// ─── Source 3: Wikipedia (kept from the previous backend) ──────────────────
async function searchWikipedia(query) {
  const res = await axios.get(WIKI_API_URL, {
    params: {
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: 5,
      prop: 'pageimages|info|extracts',
      piprop: 'original',
      inprop: 'url',
      exintro: 1,
      explaintext: 1,
      exlimit: 'max',
      exchars: 300,
      format: 'json',
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const pages = res.data && res.data.query && res.data.query.pages;
  if (!pages) return [];

  return Object.values(pages)
    .filter(p => p.original && p.original.source)
    .map(p => toCandidate({
      imageUrl: p.original.source,
      sourcePageUrl: p.fullurl || `https://${WIKI_LANG}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
      title: p.title,
      snippet: p.extract || '',
      displayLink: `${WIKI_LANG}.wikipedia.org`,
      width: p.original.width || null,
      height: p.original.height || null,
    }));
}

// ─── Entry point (same contract as before) ─────────────────────────────────
async function searchCandidateImages(name, series) {
  const query = buildQuery(name, series || '');

  const sources = [
    { label: 'fandom', run: () => searchFandom(query) },
    { label: 'zerochan', run: () => searchZerochan(name) }, // name only — the character name IS the tag
    { label: 'wikipedia', run: () => searchWikipedia(query) },
  ];

  const results = [];
  let failures = 0;
  const failureNotes = [];

  // Sequential across sources (gentler on unstable data than all-at-once),
  // parallel only inside the Fandom batching above.
  for (const src of sources) {
    try {
      const found = await src.run();
      results.push(...found);
    } catch (err) {
      failures++;
      const note = `${src.label}: ${(err && (err.code || err.message)) || 'unknown'}`;
      failureNotes.push(note);
      console.warn(`[wikiImageSearch] source ${src.label} failed (${note})`);
    }
  }

  // Only a TOTAL outage is an error — repairCardImages.js treats a throw as
  // "skip this card, keep the batch going" on flaky connections.
  if (failures === sources.length) {
    const wrapped = new Error(`All image sources failed — connection likely down: ${failureNotes.join(' | ')}`);
    wrapped.code = 'WIKI_SEARCH_ERROR';
    throw wrapped;
  }

  // Dedupe (same image can appear on a wiki and Zerochan) and cap the pool.
  const seen = new Set();
  const unique = results.filter(r => {
    const key = String(r.imageUrl || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, MAX_TOTAL_CANDIDATES);
}

module.exports = { searchCandidateImages, isConfigured, buildQuery };
