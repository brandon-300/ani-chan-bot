// ─── Keyless anime image discovery: Fandom wikis + Zerochan + Wikipedia ────
//
// WHY THIS FILE EXISTS (history, shortest version): Google's Custom Search
// JSON API is closed to new Cloud projects — confirmed, not a setup mistake;
// a new project gets a 403 "This project does not have access" no matter
// what the console says is enabled, and Bing's Image Search API was fully
// retired in August 2025. Wikipedia's API alone had thin anime coverage.
//
// WHAT THIS VERSION DOES — three keyless sources, widest-first:
//
//   1. FANDOM (primary). Big anime wikis run MediaWiki, so each wiki's
//      api.php supports generator=search + prop=pageimages. Character
//      articles carry infobox renders/official art as page images.
//      FIX IN THIS VERSION: each wiki is searched with "name + series",
//      and results are FILTERED so the page title must contain the
//      character name — this is what previously let One Piece's wiki
//      return SBS header images and the Protagonist wiki return wrong
//      characters for "Rias Gremory".
//   2. ZEROCHAN (secondary). Its JSON endpoint (?json) returns direct
//      hotlinkable image URLs plus per-image tags; "Official Art"/"Render"
//      tagged entries are boosted, "Scan"/"Screenshot" pushed back. (The
//      301 seen in curl probes is just an http->https redirect — axios
//      follows it automatically, not an error.)
//   3. WIKIPEDIA (fallback). Kept — when a character HAS an article its
//      infobox image is usually excellent official art.
//
// CONTRACT WITH THE REST OF THE PIPELINE: exports searchCandidateImages(
// name, series, aliases?), isConfigured(), buildQuery(). Candidates are
// shaped { imageUrl, sourcePageUrl, title, snippet, displayLink, width,
// height }.
//
// ALIAS FALLBACK (added after the "Kazuto Kirigaya"/"Asuna Yuuki" case —
// renameCardsWithGemini.js corrects catalogue names to a character's real
// full name, but Fandom wikis and Wikipedia almost always title the page
// after the popular nickname instead, e.g. "Kirito", not "Kazuto
// Kirigaya" — the two share no substring at all, so every source came
// back with zero hits, not just Fandom's title filter). If searching the
// canonical `name` finds NOTHING across all three sources, and the card
// has `aliases` (see models/Card.js — populated by
// backfillAliasesFromRenameLog.js for already-renamed cards), each alias
// is tried in turn, stopping at the first one that returns candidates.
// Cards whose primary-name search already succeeds make zero extra
// requests — this only fires for the genuinely-empty case.
//
// TERMUX NOTES: no new npm dependencies; short timeouts; Fandom wikis are
// queried in small concurrent batches so one flaky wiki can't stall the
// batch; sources run sequentially to be gentle on unstable data.

const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15000;

// Curated largest anime wikis (host without .fandom.com suffix). A wiki
// that doesn't cover a character returns zero rows — one silent miss
// among many, not an error. Add series-specific hosts as your catalogue
// grows; keep names lowercase, exactly as the subdomain appears.
const FANDOM_WIKIS = [
  { host: 'highschooldxd', label: 'High School DxD' },
  { host: 'naruto', label: 'Naruto' },
  { host: 'onepiece', label: 'One Piece' },
  { host: 'bleach', label: 'Bleach' },
  { host: 'dragonball', label: 'Dragon Ball' },
  { host: 'fairytail', label: 'Fairy Tail' },
  { host: 'attackontitan', label: 'Attack on Titan' },
  { host: 'myheroacademia', label: 'My Hero Academia' },
  { host: 'kimetsunoyaiba', label: 'Demon Slayer' },
  { host: 'jujutsu-kaisen', label: 'Jujutsu Kaisen' },
  { host: 'tokyoghoul', label: 'Tokyo Ghoul' },
  { host: 'swordartonline', label: 'Sword Art Online' },
  { host: 'rezero', label: 'Re:Zero' },
  { host: 'onepunchman', label: 'One Punch Man' },
  { host: 'jojo', label: 'JoJo' },
  { host: 'hunterxhunter', label: 'Hunter x Hunter' },
  { host: 'blackclover', label: 'Black Clover' },
  { host: 'drstone', label: 'Dr. Stone' },
  { host: 'haikyuu', label: 'Haikyuu' },
  { host: 'nanatsu-no-taizai', label: 'Seven Deadly Sins' },
  { host: 'toarumajutsunoindex', label: 'Toaru' },
  { host: 'date-a-live', label: 'Date A Live' },
  { host: 'kancolle', label: 'KanColle' },
  { host: 'genshin-impact', label: 'Genshin Impact' },
].map(w => ({ ...w, host: `${w.host}.fandom.com` }));

const WIKI_BATCH_SIZE = 4;       // concurrent wikis per batch — gentle on data
// Per-card result-count knob. Was documented in repairCardImages.js's
// header as WIKI_SEARCH_NUM but never actually wired up here (leftover
// from before this file's Fandom/Zerochan rewrite) — now it genuinely
// bumps both Fandom's per-wiki count and Wikipedia's gsrlimit together,
// capped at 10. Unset, behavior is UNCHANGED from before (3 and 5
// respectively). Useful for a one-off retry on a card whose default pool
// comes back too thin to give Vision a real choice — see the "Kazuto
// Kirigaya"/"Kirito" case: only one (wrong) candidate surfaced at the
// defaults, and Vision correctly hard-rejected it rather than guess.
const WIKI_SEARCH_NUM_OVERRIDE = process.env.WIKI_SEARCH_NUM
  ? Math.min(10, Math.max(1, parseInt(process.env.WIKI_SEARCH_NUM, 10) || 0)) || null
  : null;
const FANDOM_RESULTS_PER_WIKI = WIKI_SEARCH_NUM_OVERRIDE || 3; // unchanged default
const ZEROCHAN_RESULTS = 5;
const MAX_TOTAL_CANDIDATES = 15; // pool size; repairCardImages.js caps downstream
const WIKIPEDIA_RESULTS = WIKI_SEARCH_NUM_OVERRIDE || 5; // unchanged default

const WIKI_LANG = process.env.WIKI_SEARCH_LANG || 'en'; // was hardcoded 'en'; now actually reads the documented env var
const WIKI_API_URL = `https://${WIKI_LANG}.wikipedia.org/w/api.php`;

// ─── Shared helpers ─────────────────────────────────────────────────────────
function buildQuery(name, series) {
  return series ? `${name} ${series}` : name;
}

function isConfigured() {
  // Keyless pipeline — nothing to configure, always ready.
  return true;
}

function toCandidate({ imageUrl, sourcePageUrl, title, snippet, displayLink, width, height }) {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;
  return {
    imageUrl: imageUrl.replace(/^http:\/\//i, 'https://'),
    sourcePageUrl: sourcePageUrl || null,
    title: title || '',
    snippet: snippet || '',
    displayLink: displayLink || null,
    width: width || null,
    height: height || null,
  };
}

// ─── Source 1: Fandom MediaWiki APIs ────────────────────────────────────────
async function searchOneFandomWiki(host, label, query, nameForFilter) {
  const res = await axios.get(`https://${host}/api.php`, {
    params: {
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrlimit: FANDOM_RESULTS_PER_WIKI,
      prop: 'pageimages|info',
      piprop: 'original',
      inprop: 'url',
      redirects: 1,
      format: 'json',
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const pages = res.data && res.data.query && res.data.query.pages;
  if (!pages) return [];

  const needle = String(nameForFilter || '').toLowerCase();
  return Object.values(pages)
    // Title filter: kills cross-wiki noise like One Piece SBS headers or
    // a "Protagonist" wiki page for a different character with a shared
    // voice actor. A page about this character almost always names them.
    .filter(p => !needle || String(p.title || '').toLowerCase().includes(needle))
    .filter(p => p.original && p.original.source)
    .map(p => toCandidate({
      imageUrl: p.original.source,
      sourcePageUrl: p.fullurl || `https://${host}/wiki/${encodeURIComponent(p.title)}`,
      title: p.title,
      snippet: label,
      displayLink: host,
      width: p.original.width || null,
      height: p.original.height || null,
    }))
    .filter(Boolean);
}

async function searchFandom(query, nameForFilter) {
  const found = [];
  for (let i = 0; i < FANDOM_WIKIS.length; i += WIKI_BATCH_SIZE) {
    const batch = FANDOM_WIKIS.slice(i, i + WIKI_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(w => searchOneFandomWiki(w.host, w.label, query, nameForFilter))
    );
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') {
        found.push(...s.value);
      } else {
        const reason = (s.reason && (s.reason.code || s.reason.message)) || 'unknown';
        console.warn(`[wikiImageSearch] fandom:${batch[j].host} skipped (${reason})`);
      }
    });
  }
  return found;
}

// ─── Source 2: Zerochan JSON ────────────────────────────────────────────────
function zerochanRank(item) {
  const tags = (item.tags || []).join(' ').toLowerCase();
  let r = 0;
  if (tags.includes('official art')) r -= 100;
  if (tags.includes('render')) r -= 50;
  if (tags.includes('scan')) r += 30;
  if (tags.includes('screenshot')) r += 30;
  return r;
}

async function searchZerochan(name) {
  const url = `https://zerochan.net/${encodeURIComponent(name)}?json`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS,
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
    })
    .filter(Boolean);
}

// ─── Source 3: Wikipedia (fallback) ─────────────────────────────────────────
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
    }))
    .filter(Boolean);
}

// Runs all three sources for one search term (a name OR an alias) and
// returns deduped candidates. Throws WIKI_SEARCH_ERROR only when EVERY
// source failed outright (a real connectivity problem) — a term that
// simply has no matches anywhere returns [], which is not an error.
async function searchByTerm(term, series) {
  const query = buildQuery(term, series || '');

  const sources = [
    { label: 'fandom', run: () => searchFandom(query, term) },
    { label: 'zerochan', run: () => searchZerochan(term) },
    { label: 'wikipedia', run: () => searchWikipedia(query) },
  ];

  const results = [];
  let failures = 0;
  const failureNotes = [];

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

  if (failures === sources.length) {
    const wrapped = new Error(`All image sources failed — connection likely down: ${failureNotes.join(' | ')}`);
    wrapped.code = 'WIKI_SEARCH_ERROR';
    throw wrapped;
  }

  const seen = new Set();
  const unique = results.filter(r => {
    const key = String(r.imageUrl || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, MAX_TOTAL_CANDIDATES);
}

// ─── Entry point ────────────────────────────────────────────────────────────
// aliases: optional array (doc.aliases from CardCatalogue) — old
// nicknames a renamed card used to go by. Only consulted if the primary
// `name` search comes back with zero candidates; a genuine connectivity
// failure on the primary search still propagates immediately (retrying
// aliases against a dead connection would just waste time on an unstable
// link — repairCardImages.js already retries the whole card on the next
// --resume pass in that case).
async function searchCandidateImages(name, series, aliases) {
  const primary = await searchByTerm(name, series);
  if (primary.length) return primary;

  const candidates = (aliases || [])
    .filter(a => a && a.trim() && a.trim().toLowerCase() !== String(name || '').trim().toLowerCase());

  for (const alias of candidates) {
    try {
      const found = await searchByTerm(alias, series);
      if (found.length) {
        console.log(`[wikiImageSearch] "${name}" found nothing directly — alias "${alias}" succeeded`);
        return found;
      }
    } catch (err) {
      // A transient full-outage on ONE alias attempt shouldn't take down
      // the whole card when the primary search already proved the
      // connection basically works — log it and just try the next alias.
      console.warn(`[wikiImageSearch] alias "${alias}" attempt failed (${err.message}), trying next`);
    }
  }

  return []; // genuinely nothing found under the name or any alias
}

module.exports = { searchCandidateImages, isConfigured, buildQuery };
