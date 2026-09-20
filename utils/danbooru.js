const axios = require('axios');

const DANBOORU_URL = 'https://danbooru.donmai.us';

// Auth is optional — Danbooru works fine anonymously (\~500 reads/hour), just
// slower than an authenticated account (\~10/sec). Set DANBOORU_LOGIN +
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
// Gelbooru requires an account (user_id + api_key) for API access at all —
// anonymous requests get a flat 401. Create a free account at gelbooru.com,
// then "My Account" -> "Options" -> API Access Credentials, and set
// GELBOORU_USER_ID + GELBOORU_API_KEY in .env. Not required; Danbooru alone
// already covers most characters.
const GELBOORU_URL = 'https://gelbooru.com/index.php';
const GELBOORU_USER_ID = process.env.GELBOORU_USER_ID || null;
const GELBOORU_API_KEY = process.env.GELBOORU_API_KEY || null;
const GELBOORU_ENABLED = !!(GELBOORU_USER_ID && GELBOORU_API_KEY);

console.log(
  GELBOORU_ENABLED
    ? '[gelbooru] Credentials configured — Gelbooru fallback enabled.'
    : '[gelbooru] No GELBOORU_USER_ID/GELBOORU_API_KEY set — Gelbooru fallback disabled. Danbooru alone still runs normally.'
);

// ─── Safebooru (third-tier fallback) ───────────────────────────────────────
// ADDED Aug 2026: for characters neither Danbooru nor Gelbooru has usable
// art for. Safebooru is a long-running SFW-only mirror — no account needed
// for basic search, and everything on it is pre-filtered to a safe rating
// by the site itself (on top of the same rating:general filter applied
// below, belt-and-suspenders).
//
// UNCERTAINTY FLAG: I can't make a live call from this sandbox to confirm
// Safebooru's exact response field names. Safebooru runs older Gelbooru-
// lineage software, not Danbooru's own code. The field names used below
// (file_url, score, width, height, rating, tags) match what Gelbooru-style
// APIs have historically returned; if a live test shows different names,
// adjust validatePostSafebooru / selectBestImageSafebooru accordingly.
const SAFEBOORU_URL = 'https://safebooru.org/index.php';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Character tags on Danbooru are either the bare slug ("rem") or a
// disambiguated form that continues after an underscore (a middle/family
// name, or a "_(series)" disambiguator) — e.g. "levi_ackerman",
// "zero_two_(darling_in_the_franxx)". Requiring that underscore boundary
// keeps "levi_ackerman" while dropping unrelated tags that merely start
// with the same letters (e.g. "leviathan_(nikke)").
function isBoundaryMatch(tagName, slug) {
  return tagName === slug || tagName.startsWith(`${slug}_`);
}

// AniList character names come back "Given Family" (Western order, e.g.
// "Ai Hoshino"). Character tags for Japanese-origin characters are
// conventionally "family_given" (e.g. "hoshino_ai", "shinomiya_kaguya") —
// the opposite order. When a straight slug search comes back completely
// empty, this builds the swapped-order name as a second attempt. Assumes
// the LAST word is the family name, matching how AniList orders these.
function swapNameOrder(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const family = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return [family, ...rest].join(' ');
}

// ─── Series-match soft boost ────────────────────────────────────────────────
// ADDED Aug 2026, after a real run picked a plague-doctor OC's art for
// Re:Zero's "Rem" — the bare tag "rem" is apparently shared by more than
// one character on Danbooru, with no "_(re_zero)"-style disambiguated
// variant existing to boundary-match against instead, so the existing
// filters had no way to tell them apart; it just picked whichever had the
// better score, which happened to be the wrong Rem entirely.
//
// This is a SOFT preference, not a hard filter: it nudges the sort toward
// posts whose own copyright tags loosely overlap the catalogue card's
// `series` field, but never excludes a candidate outright, and never blocks
// a result when nothing matches. That's deliberate — Danbooru copyright
// tags are internal, often-Japanese-romanized slugs ("shingeki_no_kyojin"
// for "Attack on Titan"), while `series` is usually the English AniList
// title, so genuine overlap is common for some franchises (native-language
// titles reused as-is: "Re:Zero", "Genshin Impact", "Naruto") and absent
// for others (translated titles: "Attack on Titan" vs "shingeki_no_kyojin")
// — a real signal when it fires, silence (not a false negative) when it
// can't, which is exactly what a tiebreaker needs and a hard filter can't
// safely provide here.
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function seriesMatchesCopyright(series, copyrightTagString) {
  const seriesNorm = normalizeForMatch(series);
  if (seriesNorm.length < 4) return false;
  const tags = String(copyrightTagString || '').split(/\s+/).filter(Boolean);
  return tags.some(tag => {
    const tagNorm = normalizeForMatch(tag);
    return tagNorm.length >= 4 && (tagNorm.includes(seriesNorm) || seriesNorm.includes(tagNorm));
  });
}

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
    console.error(
      `Danbooru request failed: ${path} status=${status ?? err.code ?? 'unknown'} ` +
        `${err.message}`
    );
    const e = new Error(err.message);
    e.status = status;
    throw e;
  }
}

async function gelbooruGet(params, attempt = 1) {
  if (!GELBOORU_ENABLED) return null;
  try {
    const { data } = await axios.get(GELBOORU_URL, {
      params: {
        page: 'dapi',
        json: 1,
        ...params,
        user_id: GELBOORU_USER_ID,
        api_key: GELBOORU_API_KEY,
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
      return gelbooruGet(params, attempt + 1);
    }
    console.error(`Gelbooru request failed: status=${status ?? err.code ?? 'unknown'} ${err.message}`);
    const e = new Error(err.message);
    e.status = status;
    throw e;
  }
}

async function safebooruGet(params, attempt = 1) {
  try {
    const { data } = await axios.get(SAFEBOORU_URL, {
      params: {
        page: 'dapi',
        json: 1,
        ...params,
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
      return safebooruGet(params, attempt + 1);
    }
    console.error(`Safebooru request failed: status=${status ?? err.code ?? 'unknown'} ${err.message}`);
    const e = new Error(err.message);
    e.status = status;
    throw e;
  }
}

function unwrapList(data, wrapperKey) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[wrapperKey])) return data[wrapperKey];
  if (data && data[wrapperKey] && !Array.isArray(data[wrapperKey])) return [data[wrapperKey]];
  return [];
}

async function searchPosts(tag, limit = 20) {
  const data = await danbooruGet('/posts.json', {
    tags: `${tag} rating:general`,
    limit,
  });
  return Array.isArray(data) ? data : [];
}

const SKIP_EXTENSIONS = new Set(['mp4', 'webm', 'zip', 'swf']);
const COMIC_META_TAGS = new Set(['comic', '4koma', 'multiple_girls', 'multiple_boys']);
const STYLE_MISMATCH_TAGS = new Set(['3d', 'photo', 'photorealistic', 'real_life']);
const SAFETY_EXCLUDE_TAGS = new Set(['loli', 'shota', 'young', 'child', 'toddler']);

function isComicStrip(post) {
  const tags = String(post.tag_string || '').split(/\s+/);
  return tags.some((t) => COMIC_META_TAGS.has(t));
}

function isStyleMismatch(post) {
  const tags = String(post.tag_string || '').split(/\s+/);
  return tags.some((t) => STYLE_MISMATCH_TAGS.has(t));
}

function isUnsafeContent(post, tagString) {
  const tags = String(tagString || post.tag_string || '').split(/\s+/);
  return tags.some((t) => SAFETY_EXCLUDE_TAGS.has(t));
}

function validatePost(post) {
  if (!post) return false;
  if (!post.file_url) return false;
  if (!post.file_ext || SKIP_EXTENSIONS.has(post.file_ext)) return false;
  if (post.rating && !['g', 'general'].includes(String(post.rating).toLowerCase())) return false;
  const width = post.image_width || post.width || 0;
  const height = post.image_height || post.height || 0;
  if (width < 400 && height < 400) return false;
  if (isComicStrip(post)) return false;
  if (isStyleMismatch(post)) return false;
  if (isUnsafeContent(post)) return false;
  return true;
}

function selectBestImage(posts, excludePostId = null, seriesHint = null) {
  let valid = posts.filter((p) => validatePost(p) && (excludePostId == null || p.id !== excludePostId));
  if (!valid.length) return null;

  if (seriesHint) {
    valid = valid.slice().sort((a, b) => {
      const aMatch = seriesMatchesCopyright(seriesHint, a.tag_string_copyright || a.tag_string || '') ? 1 : 0;
      const bMatch = seriesMatchesCopyright(seriesHint, b.tag_string_copyright || b.tag_string || '') ? 1 : 0;
      if (bMatch !== aMatch) return bMatch - aMatch;
      return (b.score || 0) - (a.score || 0);
    });
  } else {
    valid = valid.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  const best = valid[0];
  return {
    url: best.file_url,
    postId: best.id,
    score: best.score || 0,
    width: best.image_width || best.width,
    height: best.image_height || best.height,
  };
}

async function findCharacterTagCandidates(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await danbooruGet('/tags.json', {
    'search[name_matches]': `${slug}*`,
    'search[category]': 4, // character
    'search[order]': 'count',
    limit: 20,
  });
  const tags = Array.isArray(data) ? data : [];
  return tags.filter((t) => isBoundaryMatch(t.name, slug));
}

async function findCharacterArtworkDanbooru(name, excludePostId, seriesHint) {
  try {
    let candidates = await findCharacterTagCandidates(name);
    if (!candidates.length) {
      const swapped = swapNameOrder(name);
      if (swapped) candidates = await findCharacterTagCandidates(swapped);
    }
    if (!candidates.length) return null;

    for (const candidate of candidates.slice(0, 5)) {
      const posts = await searchPosts(candidate.name);
      const best = selectBestImage(posts, excludePostId, seriesHint);
      if (best) return { ...best, tagUsed: candidate.name, source: 'danbooru' };
      await sleep(300);
    }
    return null;
  } catch (err) {
    if (err.status === 429) throw err;
    console.error('Danbooru lookup failed:', err.message);
    return null;
  }
}

// ─── Gelbooru helpers ───────────────────────────────────────────────────────
async function findCharacterTagCandidatesGelbooru(name) {
  if (!GELBOORU_ENABLED) return [];
  const slug = slugify(name);
  if (!slug) return [];
  // Gelbooru tag autocomplete is limited; we just try the slug + swapped form.
  return [{ name: slug }, ...(swapNameOrder(name) ? [{ name: slugify(swapNameOrder(name)) }] : [])];
}

function isComicStripGelbooru(post) {
  const tags = String(post.tags || '').split(/\s+/);
  return tags.some((t) => COMIC_META_TAGS.has(t));
}
function isStyleMismatchGelbooru(post) {
  const tags = String(post.tags || '').split(/\s+/);
  return tags.some((t) => STYLE_MISMATCH_TAGS.has(t));
}
function validatePostGelbooru(post) {
  if (!post || !post.file_url) return false;
  const ext = (post.file_url.split('.').pop() || '').toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  const rating = String(post.rating || '').toLowerCase();
  if (rating && !['general', 'g', 'safe', 's'].includes(rating)) return false;
  const width = post.width || 0;
  const height = post.height || 0;
  if (width < 400 && height < 400) return false;
  if (isComicStripGelbooru(post) || isStyleMismatchGelbooru(post)) return false;
  if (isUnsafeContent(post, post.tags)) return false;
  return true;
}
function selectBestImageGelbooru(posts, excludePostId = null, seriesHint = null) {
  let valid = posts.filter((p) => validatePostGelbooru(p) && (excludePostId == null || p.id !== excludePostId));
  if (!valid.length) return null;
  if (seriesHint) {
    valid = valid.slice().sort((a, b) => {
      const aMatch = seriesMatchesCopyright(seriesHint, a.tags || '') ? 1 : 0;
      const bMatch = seriesMatchesCopyright(seriesHint, b.tags || '') ? 1 : 0;
      if (bMatch !== aMatch) return bMatch - aMatch;
      return (b.score || 0) - (a.score || 0);
    });
  } else {
    valid = valid.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const best = valid[0];
  return { url: best.file_url, postId: best.id, score: best.score || 0, width: best.width, height: best.height };
}

async function findCharacterArtworkGelbooru(name, excludePostId, seriesHint) {
  if (!GELBOORU_ENABLED) return null;
  try {
    let candidates = await findCharacterTagCandidatesGelbooru(name);
    if (!candidates.length) return null;

    for (const candidate of candidates.slice(0, 5)) {
      const data = await gelbooruGet({ s: 'post', q: 'index', tags: `${candidate.name} rating:general`, limit: 20 });
      const posts = unwrapList(data, 'post');
      const best = selectBestImageGelbooru(posts, excludePostId, seriesHint);
      if (best) return { ...best, tagUsed: candidate.name, source: 'gelbooru' };
      await sleep(300);
    }
    return null;
  } catch (err) {
    if (err.status === 429) throw err;
    console.error('Gelbooru lookup failed:', err.message);
    return null;
  }
}

// ─── Safebooru helpers ──────────────────────────────────────────────────────
async function findCharacterTagCandidatesSafebooru(name) {
  const slug = slugify(name);
  if (!slug) return [];
  return [{ name: slug }, ...(swapNameOrder(name) ? [{ name: slugify(swapNameOrder(name)) }] : [])];
}

function validatePostSafebooru(post) {
  if (!post || !post.file_url) return false;
  const rating = String(post.rating || 's').toLowerCase();
  if (!['general', 'g', 'safe', 's'].includes(rating)) return false;
  const url = post.file_url;
  if (!url) return false;
  const ext = (url.split('.').pop() || '').toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  const width = post.width || 0;
  const height = post.height || 0;
  if (width < 400 && height < 400) return false;
  const allTags = String(post.tags || '').split(/\s+/);
  if (allTags.some(t => COMIC_META_TAGS.has(t) || STYLE_MISMATCH_TAGS.has(t) || SAFETY_EXCLUDE_TAGS.has(t))) return false;
  return true;
}
function selectBestImageSafebooru(posts, excludePostId = null) {
  const valid = posts.filter(p => validatePostSafebooru(p) && (excludePostId == null || p.id !== excludePostId));
  if (!valid.length) return null;
  valid.sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = valid[0];
  return { url: best.file_url, postId: best.id, score: best.score || 0, width: best.width, height: best.height };
}
async function findCharacterArtworkSafebooru(name, excludePostId) {
  try {
    let candidates = await findCharacterTagCandidatesSafebooru(name);
    if (!candidates.length) {
      const swapped = swapNameOrder(name);
      if (swapped) candidates = await findCharacterTagCandidatesSafebooru(swapped);
    }
    if (!candidates.length) return null;

    for (const candidate of candidates.slice(0, 5)) {
      const data = await safebooruGet({ s: 'post', q: 'index', tags: candidate.name, limit: 20 });
      const posts = unwrapList(data, 'post');
      const best = selectBestImageSafebooru(posts, excludePostId);
      if (best) return { ...best, tagUsed: candidate.name, source: 'safebooru' };
      await sleep(300);
    }
    return null;
  } catch (err) {
    if (err.status === 429) throw err;
    console.error('Safebooru lookup failed:', err.message);
    return null;
  }
}

// ─── Manual override ────────────────────────────────────────────────────────
// ADDED Aug 2026 for .upgradeimages settag — an escape hatch for cases the
// automatic matching genuinely can't resolve (e.g. a name shared by two
// characters where neither boundary-matching nor the series soft-boost can
// tell them apart, like Rem). Skips candidate discovery entirely and goes
// straight to a specific known tag on a specific source.
async function fetchArtworkForExactTag(tag, source, excludePostId = null) {
  if (source === 'gelbooru') {
    if (!GELBOORU_ENABLED) return null;
    const data = await gelbooruGet({ s: 'post', q: 'index', tags: `${tag} rating:general`, limit: 20 });
    const best = selectBestImageGelbooru(unwrapList(data, 'post'), excludePostId);
    return best ? { ...best, tagUsed: tag, source: 'gelbooru' } : null;
  }
  if (source === 'safebooru') {
    const data = await safebooruGet({ s: 'post', q: 'index', tags: tag, limit: 20 });
    const best = selectBestImageSafebooru(unwrapList(data, 'post'), excludePostId);
    return best ? { ...best, tagUsed: tag, source: 'safebooru' } : null;
  }
  // default: danbooru
  const posts = await searchPosts(tag);
  const best = selectBestImage(posts, excludePostId);
  return best ? { ...best, tagUsed: tag, source: 'danbooru' } : null;
}

// ─── Main entrypoint ────────────────────────────────────────────────────────
// Tries Danbooru first, then Gelbooru (if configured), then Safebooru —
// each only attempted if the previous source found nothing usable at all.
// `seriesHint` (the catalogue card's `series` field) is passed through for
// the soft series-match boost described above. `excludePostId` (retry
// support) is passed through to every source so retry can't land back on
// whichever source/post it already tried.
//
// A 429 that survives each source's own internal retries propagates up
// uncaught (rather than being swallowed into "no match") — this is
// deliberate: it lets a caller running an exhaustive batch (like
// .upgradeimages processing hundreds of cards) distinguish "this site is
// rate-limiting us, stop the whole run" from "this specific character has
// no art," which need very different responses.
async function findCharacterArtwork(name, excludePostId = null, seriesHint = null) {
  const fromDanbooru = await findCharacterArtworkDanbooru(name, excludePostId, seriesHint);
  if (fromDanbooru) return fromDanbooru;

  const fromGelbooru = await findCharacterArtworkGelbooru(name, excludePostId, seriesHint);
  if (fromGelbooru) return fromGelbooru;

  return findCharacterArtworkSafebooru(name, excludePostId);
}

// ─── Simple random-image helper (used by .waifu / .neko / NSFW commands) ─────
// Tries each tag set in order. Returns { url, id } of a random valid still
// image, or null. Keeps the same User-Agent + optional auth as the rest of
// this module so we don't get banned for inconsistent headers.
const RANDOM_HARD_EXCLUDE = '-animated -animated_gif -video -webm -comic -4koma';
const RANDOM_ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const RANDOM_MAX_BYTES = 20 * 1024 * 1024; // WhatsApp-safe

async function fetchRandomImage(tagSets, { ratingLetters = null } = {}) {
  const sets = Array.isArray(tagSets) ? tagSets : [tagSets];

  for (const rawTags of sets) {
    if (!rawTags) continue;

    // Anonymous Danbooru limit = 2 tags. Do NOT append many -exclude tags here.
    // Strip any pre-attached HARD_EXCLUDE so we stay within the limit.
    const tags = String(rawTags)
      .replace(/-animated_gif/g, '')
      .replace(/-animated/g, '')
      .replace(/-video/g, '')
      .replace(/-webm/g, '')
      .replace(/-comic/g, '')
      .replace(/-4koma/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    try {
      const data = await danbooruGet('/posts.json', {
        tags,
        limit: 50,
        random: true,
      });
      const posts = Array.isArray(data) ? data : [];
      const valid = posts.filter((p) => {
        if (!p || !p.file_url) return false;
        if (ratingLetters && ratingLetters.length) {
          const r = String(p.rating || '').toLowerCase();
          if (!ratingLetters.includes(r)) return false;
        }
        const ext = String(p.file_url.split('.').pop() || '').toLowerCase();
        if (!RANDOM_ALLOWED_EXT.has(ext)) return false; // drops webm/mp4/gif etc.
        if ((p.file_size || 0) > RANDOM_MAX_BYTES) return false;
        // Client-side exclude for comics/animated when tag_string is present
        const tagStr = String(p.tag_string || p.tag_string_general || '');
        if (/\b(animated|animated_gif|video|webm|comic|4koma)\b/i.test(tagStr)) return false;
        return true;
      });
      if (valid.length) {
        const post = valid[Math.floor(Math.random() * valid.length)];
        return { url: post.file_url, id: post.id };
      }
    } catch (err) {
      console.error(`[danbooru] fetchRandomImage failed (${tags}):`, err.message);
    }
  }
  return null;
}

module.exports = {
  findCharacterArtwork,
  fetchArtworkForExactTag,
  searchPosts,
  selectBestImage,
  validatePost,
  findCharacterTagCandidates,
  swapNameOrder,
  fetchRandomImage,
  RANDOM_HARD_EXCLUDE,
};