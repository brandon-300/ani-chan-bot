const axios = require('axios');

const DANBOORU_URL = 'https://danbooru.donmai.us';

// Auth is optional — Danbooru works fine anonymously (~500 reads/hour), just
// slower than an authenticated account (~10/sec). Set DANBOORU_LOGIN +
// DANBOORU_API_KEY in .env (free account, danbooru.donmai.us -> My Account ->
// API Key) if a batch run needs to move faster than the anon limit allows.
const LOGIN = process.env.DANBOORU_LOGIN || null;
const API_KEY = process.env.DANBOORU_API_KEY || null;

// Danbooru requires a unique identifying User-Agent on every request (their
// own API docs: "Don't impersonate browsers or use the default header of
// your library. Badly-behaved bots will be banned swiftly.") — this is that
// header, not decorative.
const USER_AGENT = `AniChanBot/1.0 (${LOGIN || 'anonymous'})`;

console.log(
  LOGIN && API_KEY
    ? `[danbooru] Using authenticated requests (login: ${LOGIN})`
    : '[danbooru] Using anonymous requests (no DANBOORU_LOGIN/DANBOORU_API_KEY set)'
);

// ─── Gelbooru (secondary source) ───────────────────────────────────────────
// Used only when Danbooru has nothing usable for a character — free, no
// account required for basic anonymous search. Optional GELBOORU_USER_ID +
// GELBOORU_API_KEY in .env raise the rate limit the same way Danbooru's
// login/api_key pair does; anonymous works, just slower.
//
// UNCERTAINTY FLAG: Gelbooru's public API has changed shape a few times
// over the years and I can't make a live test call from this environment
// (no network access here) to confirm the exact current response format.
// The parsing below defensively handles the two shapes I'm aware of
// (a bare array, like Danbooru, OR an object with a "tag"/"post" wrapper
// key, which is how Gelbooru's dapi has returned JSON in the past). If a
// real run shows this never finds anything, it's almost certainly because
// the response shape changed again — run .upgradeimages once, and if
// Gelbooru isn't contributing any matches, share the raw JSON from a
// manual test (see the curl command in the deploy notes) so the parsing
// can be corrected against real data instead of guessed again.
const GELBOORU_URL = 'https://gelbooru.com/index.php';
const GELBOORU_USER_ID = process.env.GELBOORU_USER_ID || null;
const GELBOORU_API_KEY = process.env.GELBOORU_API_KEY || null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// name -> slug. Both Danbooru and Gelbooru character tags are lowercase,
// space/apostrophe/period -> underscore (e.g. "Levi" -> "levi", "Rem" ->
// "rem", "Marin Kitagawa" -> "marin_kitagawa").
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/['".]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// BUGFIX (Aug 2026): the old candidate search matched any tag whose name
// merely STARTED WITH the slug as a raw substring (Danbooru's name_matches
// wildcard, "levi*"). That's a prefix match, not a word match, so it also
// pulled in completely unrelated tags that just happen to share the first
// few letters — "levi" matched "leviathan_(nikke)", "rem" matched
// "remielle_dan" — and since the only ranking signal was raw post_count, a
// popular unrelated character could easily outrank the real one.
//
// A real Danbooru/Gelbooru character tag for a given slug is always either
// the slug itself, or the slug followed by an underscore (a surname, or a
// "_(series)" disambiguator) — e.g. "levi_ackerman", "levi_(shingeki_no_
// kyojin)", "zero_two_(darling_in_the_franxx)". Requiring that underscore
// boundary keeps "levi_ackerman" while dropping "leviathan_(nikke)".
function isBoundaryMatch(tagName, slug) {
  return tagName === slug || tagName.startsWith(`${slug}_`);
}

// AniList character names come back "Given Family" (Western order, e.g.
// "Ai Hoshino"). Danbooru/Gelbooru character tags for Japanese-origin
// characters are conventionally "family_given" (e.g. "hoshino_ai",
// "shinomiya_kaguya", "fujiwara_chika") — the opposite order. When a
// straight slug search comes back completely empty (not just badly
// ranked — actually empty), this builds the swapped-order name as a
// second attempt before giving up. Assumes the LAST word is the family
// name, which matches how AniList orders these names in practice.
function swapNameOrder(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const family = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return [family, ...rest].join(' ');
}

// Shared GET wrapper: identifies itself properly, attaches auth if
// configured, and retries a couple times on rate-limit/server errors before
// giving up — same retry shape as commands/cardmanager.js's
// fetchAniListCharacter, so both external lookups in this bot behave the
// same way under a flaky connection.
async function danbooruGet(path, params, attempt = 1) {
  try {
    const { data } = await axios.get(`${DANBOORU_URL}${path}`, {
      params: {
        ...params,
        ...(LOGIN && API_KEY ? { login: LOGIN, api_key: API_KEY } : {}),
      },
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const retryable = status === 429 || status === 421 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return danbooruGet(path, params, attempt + 1);
    }
    // BUGFIX (Aug 2026): this used to just re-throw with nothing logged, so
    // a run that failed across every single card (auth/network-level, not
    // a per-character miss) left pm2 logs completely empty — the only clue
    // was Axios's generic "Request failed with status code N" surfaced in
    // the WhatsApp reply, with no way to tell WHY. Logging the actual
    // response body here (Danbooru's JSON error responses usually explain
    // exactly what went wrong — bad login/api_key, banned account, etc.)
    // makes that diagnosable from `pm2 logs` instead of guesswork.
    console.error(
      `Danbooru request failed: ${path} status=${status ?? err.code ?? 'unknown'} ` +
      `auth=${LOGIN && API_KEY ? `yes(${LOGIN})` : 'no'} ` +
      `body=${JSON.stringify(err.response?.data).slice(0, 300)}`
    );
    throw err;
  }
}

// Same shape as danbooruGet, pointed at Gelbooru's dapi instead. Gelbooru's
// dapi is deliberately Danbooru-API-compatible (that's what "dapi" means),
// so the param names line up, but see the UNCERTAINTY FLAG above the
// GELBOORU_URL constant re: response shape.
async function gelbooruGet(params, attempt = 1) {
  try {
    const { data } = await axios.get(GELBOORU_URL, {
      params: {
        page: 'dapi',
        json: 1,
        ...params,
        ...(GELBOORU_USER_ID && GELBOORU_API_KEY
          ? { user_id: GELBOORU_USER_ID, api_key: GELBOORU_API_KEY }
          : {}),
      },
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const retryable = status === 429 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return gelbooruGet(params, attempt + 1);
    }
    console.error(
      `Gelbooru request failed: status=${status ?? err.code ?? 'unknown'} ` +
      `auth=${GELBOORU_USER_ID && GELBOORU_API_KEY ? 'yes' : 'no'} ` +
      `body=${JSON.stringify(err.response?.data).slice(0, 300)}`
    );
    throw err;
  }
}

// Pulls an array out of a dapi JSON response regardless of which of the two
// shapes it came back in (bare array vs. {wrapperKey: [...]}).
function unwrapList(data, wrapperKey) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[wrapperKey])) return data[wrapperKey];
  return [];
}

// ─── Danbooru ───────────────────────────────────────────────────────────────

// Raw post search. ALWAYS forces rating:general server-side regardless of
// what's passed in `tag` — this is a hard content-safety floor, not
// something a caller can opt out of by mistake. Danbooru's free-tier search
// historically caps unauthenticated/basic accounts at 2 combined tags per
// query, so this only ever sends exactly 2: the one character tag, plus
// rating:general.
async function searchPosts(tag, limit = 20) {
  if (!tag) return [];
  const data = await danbooruGet('/posts.json', {
    tags: `${tag} rating:general`,
    limit,
  });
  return Array.isArray(data) ? data : [];
}

// A post is usable if: it isn't deleted/banned, it actually has an image
// (not a video/ugoira/flash — file_ext check), and it's not a tiny icon-
// sized upload that would look bad stretched into a 1080x1440 card. rating
// is checked again here even though searchPosts already filtered
// server-side — defense in depth, since a retried/cached response
// shouldn't be trusted blindly for a safety-relevant check.
const SKIP_EXTENSIONS = new Set(['mp4', 'webm', 'zip', 'swf']);
function validatePost(post) {
  if (!post || post.is_deleted || post.is_banned) return false;
  if (post.rating !== 'g') return false;
  if (!post.file_ext || SKIP_EXTENSIONS.has(post.file_ext)) return false;
  const url = post.large_file_url || post.file_url;
  if (!url) return false;
  if ((post.image_width || 0) < 400 && (post.image_height || 0) < 400) return false;
  return true;
}

// Picks the single best post out of a search result: valid posts only,
// highest score first (Danbooru's own community-vetted quality signal),
// fav_count as the tiebreaker.
function selectBestImage(posts) {
  const valid = posts.filter(validatePost);
  if (!valid.length) return null;
  valid.sort((a, b) => (b.score - a.score) || (b.fav_count - a.fav_count));
  const best = valid[0];
  return {
    url: best.large_file_url || best.file_url,
    postId: best.id,
    score: best.score,
    width: best.image_width,
    height: best.image_height,
  };
}

// Finds every character tag Danbooru has that matches `name`, filtered to
// real word-boundary matches (see isBoundaryMatch above) and sorted
// most-used first. category:4 is Danbooru's "character" tag type — this
// deliberately does NOT try to filter by series here: Danbooru's copyright
// tags are internal slugs (shingeki_no_kyojin, kimetsu_no_yaiba, etc.), not
// English titles, so a plain match against a catalogue card's `series`
// field (e.g. "Attack on Titan") would almost always miss even for the
// RIGHT character — a much less reliable signal here than it was for
// AniList (which returns human-readable English/romaji titles directly).
async function findCharacterTagCandidates(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await danbooruGet('/tags.json', {
    'search[name_matches]': `${slug}*`,
    'search[category]': 4,
    limit: 100,
  });
  const tags = Array.isArray(data) ? data : [];
  return tags
    .filter(t => t.post_count > 0 && isBoundaryMatch(t.name, slug))
    .sort((a, b) => b.post_count - a.post_count);
}

async function findCharacterArtworkDanbooru(name) {
  let candidates = await findCharacterTagCandidates(name);

  if (!candidates.length) {
    const swapped = swapNameOrder(name);
    if (swapped) candidates = await findCharacterTagCandidates(swapped);
  }
  if (!candidates.length) return null;

  // Usually the top (most-used) candidate has usable art, but a tag can
  // exist with zero rating:general posts (e.g. everything tagged under it
  // happens to be questionable/explicit) — try the next few boundary-
  // matched candidates before giving up on Danbooru entirely, rather than
  // failing the whole card over one unlucky top pick.
  for (const candidate of candidates.slice(0, 5)) {
    const posts = await searchPosts(candidate.name);
    const best = selectBestImage(posts);
    if (best) return { ...best, tagUsed: candidate.name, source: 'danbooru' };
    await sleep(300);
  }
  return null;
}

// ─── Gelbooru (fallback) ────────────────────────────────────────────────────

async function findCharacterTagCandidatesGelbooru(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await gelbooruGet({
    s: 'tag',
    q: 'index',
    name_pattern: `${slug}%`,
    limit: 100,
  });
  const tags = unwrapList(data, 'tag');
  return tags
    .filter(t => (t.count ?? t.post_count ?? 0) > 0 && isBoundaryMatch(String(t.name || '').toLowerCase(), slug))
    .map(t => ({ name: t.name, post_count: t.count ?? t.post_count ?? 0 }))
    .sort((a, b) => b.post_count - a.post_count);
}

function validatePostGelbooru(post) {
  if (!post) return false;
  const rating = String(post.rating || '').toLowerCase();
  if (!['general', 'g', 'safe', 's'].includes(rating)) return false;
  const url = post.file_url;
  if (!url) return false;
  const ext = (url.split('.').pop() || '').toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  const width = post.width || post.image_width || 0;
  const height = post.height || post.image_height || 0;
  if (width < 400 && height < 400) return false;
  return true;
}

function selectBestImageGelbooru(posts) {
  const valid = posts.filter(validatePostGelbooru);
  if (!valid.length) return null;
  valid.sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = valid[0];
  return {
    url: best.file_url,
    postId: best.id,
    score: best.score || 0,
    width: best.width || best.image_width,
    height: best.height || best.image_height,
  };
}

async function findCharacterArtworkGelbooru(name) {
  try {
    let candidates = await findCharacterTagCandidatesGelbooru(name);
    if (!candidates.length) {
      const swapped = swapNameOrder(name);
      if (swapped) candidates = await findCharacterTagCandidatesGelbooru(swapped);
    }
    if (!candidates.length) return null;

    for (const candidate of candidates.slice(0, 5)) {
      const data = await gelbooruGet({
        s: 'post',
        q: 'index',
        tags: `${candidate.name} rating:general`,
        limit: 20,
      });
      const posts = unwrapList(data, 'post');
      const best = selectBestImageGelbooru(posts);
      if (best) return { ...best, tagUsed: candidate.name, source: 'gelbooru' };
      await sleep(300);
    }
    return null;
  } catch (err) {
    console.error('Gelbooru lookup failed:', err.message);
    return null;
  }
}

// ─── Main entrypoint ────────────────────────────────────────────────────────
// Given a character name, returns the best available artwork or null if
// nothing usable was found anywhere. Tries Danbooru first (generally
// sharper/better-curated), falls back to Gelbooru only if Danbooru has
// nothing at all.
//
// Disambiguation strategy (e.g. multiple different "Rem"s across different
// series, once boundary-matching has already dropped the obviously
// unrelated tags): without a reliable series-slug match (see the comment
// above findCharacterTagCandidates), this picks the candidate character tag
// with the highest post_count — i.e. whichever same-named character has the
// most art on the site. That's a real heuristic, not a guarantee — it can
// still land on the wrong series for a name that's genuinely shared by two
// well-known characters (e.g. an "Emilia" from two different shows both
// having plenty of art, both with a validly-formed tag). That tradeoff is
// deliberate — matches the "auto-apply the best match everywhere, spot-
// check after" approach chosen for the catalogue image upgrade this was
// built for, rather than the much more conservative skip-on-any-doubt
// behavior .backfillimages uses for AniList. Every result carries back
// `tagUsed` and `source` specifically so a spot-check later has something
// concrete to verify against — .upgradeimages's own reply already prints
// both for exactly this reason.
async function findCharacterArtwork(name) {
  const fromDanbooru = await findCharacterArtworkDanbooru(name);
  if (fromDanbooru) return fromDanbooru;
  return findCharacterArtworkGelbooru(name);
}

module.exports = {
  findCharacterArtwork,
  searchPosts,
  selectBestImage,
  validatePost,
  // Exported for spot-testing from a throwaway script if a match ever looks
  // wrong — lets you check what candidates a name resolves to without
  // running the full .upgradeimages batch.
  findCharacterTagCandidates,
  swapNameOrder,
};
