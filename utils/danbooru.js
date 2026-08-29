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
// lineage software, not Danbooru's own codebase, so this is modeled on
// Gelbooru's shape (a `tags` string per post, not Danbooru's split
// tag_string_meta/tag_string_character fields) rather than Danbooru's — a
// reasonable guess, not a confirmed one. Wrapped defensively (try/catch,
// falls back to "no match" on any shape mismatch) so a wrong guess here
// can only mean "Safebooru contributes nothing," never a bad card image —
// same safety property as Gelbooru's own defensive parsing. If it turns
// out to never find anything, that's the first thing to check.
const SAFEBOORU_URL = 'https://safebooru.org/index.php';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// name -> slug. Danbooru/Gelbooru/Safebooru character tags are all
// lowercase, space/apostrophe/period -> underscore (e.g. "Levi" -> "levi",
// "Marin Kitagawa" -> "marin_kitagawa").
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/['".]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// A real character tag for a given slug is always either the slug itself,
// or the slug followed by an underscore (a surname, or a "_(series)"
// disambiguator) — e.g. "levi_ackerman", "zero_two_(darling_in_the_franxx)".
// Requiring that underscore boundary keeps "levi_ackerman" while dropping
// unrelated tags that merely start with the same letters (e.g.
// "leviathan_(nikke)").
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
      `auth=${LOGIN && API_KEY ? `yes(${LOGIN})` : 'no'} ` +
      `body=${JSON.stringify(err.response?.data).slice(0, 300)}`
    );
    const wrapped = new Error(err.message);
    wrapped.status = status;
    wrapped.code = err.code;
    throw wrapped;
  }
}

async function gelbooruGet(params, attempt = 1) {
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
    const retryable = status === 429 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return gelbooruGet(params, attempt + 1);
    }
    console.error(
      `Gelbooru request failed: status=${status ?? err.code ?? 'unknown'} ` +
      `body=${JSON.stringify(err.response?.data).slice(0, 300)}`
    );
    const wrapped = new Error(err.message);
    wrapped.status = status;
    wrapped.code = err.code;
    throw wrapped;
  }
}

async function safebooruGet(params, attempt = 1) {
  try {
    const { data } = await axios.get(SAFEBOORU_URL, {
      params: { page: 'dapi', json: 1, ...params },
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const retryable = status === 429 || (status && status >= 500) || err.code === 'ECONNABORTED';
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      return safebooruGet(params, attempt + 1);
    }
    console.error(`Safebooru request failed: status=${status ?? err.code ?? 'unknown'}`);
    const wrapped = new Error(err.message);
    wrapped.status = status;
    wrapped.code = err.code;
    throw wrapped;
  }
}

// Pulls an array out of a dapi JSON response regardless of which shape it
// came back in (bare array vs. {wrapperKey: [...]}).
function unwrapList(data, wrapperKey) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[wrapperKey])) return data[wrapperKey];
  return [];
}

// ─── Danbooru ───────────────────────────────────────────────────────────────

async function searchPosts(tag, limit = 20) {
  if (!tag) return [];
  const data = await danbooruGet('/posts.json', {
    tags: `${tag} rating:general`,
    limit,
  });
  return Array.isArray(data) ? data : [];
}

const SKIP_EXTENSIONS = new Set(['mp4', 'webm', 'zip', 'swf']);
const COMIC_META_TAGS = new Set(['comic', '4koma', 'manga']);
function isComicStrip(post) {
  const meta = String(post.tag_string_meta || '').split(/\s+/);
  return meta.some(t => COMIC_META_TAGS.has(t));
}

// Genderswap/style-reinterpretation fanart keeps a character's base tag
// (it IS still "inuyasha", just drawn as a rule_63 take) — boundary/solo/
// comic checks can't catch this since the post is a genuinely valid,
// single-character, non-comic match for the tag. These are general-
// category tags (not meta), so this checks tag_string — the FULL
// space-separated tag list across every category.
const STYLE_MISMATCH_TAGS = new Set([
  'rule_63', 'genderswap', 'genderbend', 'otoko_no_ko', 'crossdress', 'trap',
]);
function isStyleMismatch(post) {
  const allTags = String(post.tag_string || '').split(/\s+/);
  return allTags.some(t => STYLE_MISMATCH_TAGS.has(t));
}

// Proactive content-safety exclusion, independent of the style-mismatch
// check above and not tied to any specific reported bug — excludes posts
// tagged with content marking a character as depicted younger than their
// canonical age, regardless of rating. A rating:general filter alone
// doesn't guarantee this is never an issue, since these tags can appear on
// fully-clothed, non-sexual posts that are still not appropriate source
// art for a general card catalogue.
const SAFETY_EXCLUDE_TAGS = new Set(['loli', 'shota']);
function isUnsafeContent(post, tagString) {
  const allTags = String(tagString ?? post.tag_string ?? '').split(/\s+/);
  return allTags.some(t => SAFETY_EXCLUDE_TAGS.has(t));
}

function validatePost(post) {
  if (!post || post.is_deleted || post.is_banned) return false;
  if (post.rating !== 'g') return false;
  if (!post.file_ext || SKIP_EXTENSIONS.has(post.file_ext)) return false;
  const url = post.large_file_url || post.file_url;
  if (!url) return false;
  if ((post.image_width || 0) < 400 && (post.image_height || 0) < 400) return false;
  if (isComicStrip(post)) return false;
  if (isStyleMismatch(post)) return false;
  if (isUnsafeContent(post)) return false;
  return true;
}

// Picks the single best post out of a search result. Sort priority:
//   1. Solo-ish first: tag_count_character <= 1 (just the one character,
//      not a group/crossover shot) beats a higher character count even if
//      the group shot scores higher.
//   2. Series match: a post whose own copyright tags loosely overlap the
//      catalogue's series field beats one that doesn't — see the
//      "Series-match soft boost" comment above for why this is a
//      preference, not a filter.
//   3. Score (Danbooru's community-vetted quality signal).
//   4. fav_count as the final tiebreaker.
// `excludePostId`: for .upgradeimages retry — asks for "anything EXCEPT
// that exact post" so a technically-valid-but-disliked pick doesn't
// deterministically come back identical every time.
function selectBestImage(posts, excludePostId = null, seriesHint = null) {
  const valid = posts.filter(p => validatePost(p) && (excludePostId == null || p.id !== excludePostId));
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const soloA = (a.tag_count_character ?? 1) <= 1 ? 1 : 0;
    const soloB = (b.tag_count_character ?? 1) <= 1 ? 1 : 0;
    if (soloA !== soloB) return soloB - soloA;
    if (seriesHint) {
      const seriesA = seriesMatchesCopyright(seriesHint, a.tag_string_copyright) ? 1 : 0;
      const seriesB = seriesMatchesCopyright(seriesHint, b.tag_string_copyright) ? 1 : 0;
      if (seriesA !== seriesB) return seriesB - seriesA;
    }
    return (b.score - a.score) || (b.fav_count - a.fav_count);
  });
  const best = valid[0];
  return {
    url: best.large_file_url || best.file_url,
    postId: best.id,
    score: best.score,
    width: best.image_width,
    height: best.image_height,
  };
}

// category:4 is Danbooru's "character" tag type — deliberately does NOT
// filter by series here at the TAG level: Danbooru's copyright tags are
// internal slugs, not English titles, so matching a catalogue card's
// `series` field against them would miss even for the right character.
// (The series signal is used at the POST level instead — see
// selectBestImage above — where each individual post's own copyright tags
// are available to compare against, not just the character tag name.)
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

async function findCharacterArtworkDanbooru(name, excludePostId, seriesHint) {
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
}

// ─── Gelbooru (fallback) ────────────────────────────────────────────────────

async function findCharacterTagCandidatesGelbooru(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await gelbooruGet({
    s: 'tag', q: 'index', name_pattern: `${slug}%`, limit: 100,
  });
  const tags = unwrapList(data, 'tag');
  return tags
    .filter(t => (t.count ?? t.post_count ?? 0) > 0 && isBoundaryMatch(String(t.name || '').toLowerCase(), slug))
    .map(t => ({ name: t.name, post_count: t.count ?? t.post_count ?? 0 }))
    .sort((a, b) => b.post_count - a.post_count);
}

function isComicStripGelbooru(post) {
  const meta = String(post.tag_string_meta || post.tags_meta || '').split(/\s+/);
  return meta.some(t => COMIC_META_TAGS.has(t));
}
function isStyleMismatchGelbooru(post) {
  const allTags = String(post.tags || post.tag_string || '').split(/\s+/);
  return allTags.some(t => STYLE_MISMATCH_TAGS.has(t));
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
  if (isComicStripGelbooru(post)) return false;
  if (isStyleMismatchGelbooru(post)) return false;
  if (isUnsafeContent(post, post.tags || post.tag_string)) return false;
  return true;
}

function selectBestImageGelbooru(posts, excludePostId = null, seriesHint = null) {
  const valid = posts.filter(p => validatePostGelbooru(p) && (excludePostId == null || p.id !== excludePostId));
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const soloA = (a.tag_count_character ?? 1) <= 1 ? 1 : 0;
    const soloB = (b.tag_count_character ?? 1) <= 1 ? 1 : 0;
    if (soloA !== soloB) return soloB - soloA;
    if (seriesHint) {
      // Gelbooru's copyright field name is unconfirmed (same uncertainty
      // as elsewhere in this file) — checked defensively, contributes
      // nothing rather than crashing if absent.
      const copyA = a.tag_string_copyright || a.copyright_tags || '';
      const copyB = b.tag_string_copyright || b.copyright_tags || '';
      const seriesA = seriesMatchesCopyright(seriesHint, copyA) ? 1 : 0;
      const seriesB = seriesMatchesCopyright(seriesHint, copyB) ? 1 : 0;
      if (seriesA !== seriesB) return seriesB - seriesA;
    }
    return (b.score || 0) - (a.score || 0);
  });
  const best = valid[0];
  return {
    url: best.file_url,
    postId: best.id,
    score: best.score || 0,
    width: best.width || best.image_width,
    height: best.height || best.image_height,
  };
}

async function findCharacterArtworkGelbooru(name, excludePostId, seriesHint) {
  if (!GELBOORU_ENABLED) return null;
  try {
    let candidates = await findCharacterTagCandidatesGelbooru(name);
    if (!candidates.length) {
      const swapped = swapNameOrder(name);
      if (swapped) candidates = await findCharacterTagCandidatesGelbooru(swapped);
    }
    if (!candidates.length) return null;

    for (const candidate of candidates.slice(0, 5)) {
      const data = await gelbooruGet({
        s: 'post', q: 'index', tags: `${candidate.name} rating:general`, limit: 20,
      });
      const posts = unwrapList(data, 'post');
      const best = selectBestImageGelbooru(posts, excludePostId, seriesHint);
      if (best) return { ...best, tagUsed: candidate.name, source: 'gelbooru' };
      await sleep(300);
    }
    return null;
  } catch (err) {
    if (err.status === 429) throw err; // let the caller detect a hard rate-limit wall
    console.error('Gelbooru lookup failed:', err.message);
    return null;
  }
}

// ─── Safebooru (third-tier fallback) ───────────────────────────────────────

async function findCharacterTagCandidatesSafebooru(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await safebooruGet({ s: 'tag', q: 'index', name_pattern: `${slug}%`, limit: 100 });
  const tags = unwrapList(data, 'tag');
  return tags
    .filter(t => (t.count ?? 0) > 0 && isBoundaryMatch(String(t.name || t.tag || '').toLowerCase(), slug))
    .map(t => ({ name: t.name || t.tag, post_count: t.count ?? 0 }))
    .sort((a, b) => b.post_count - a.post_count);
}
function validatePostSafebooru(post) {
  if (!post) return false;
  const rating = String(post.rating || '').toLowerCase();
  if (!['general', 'g', 'safe', 's'].includes(rating)) return false; // belt-and-suspenders; site is SFW-only already
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

module.exports = {
  findCharacterArtwork,
  fetchArtworkForExactTag,
  searchPosts,
  selectBestImage,
  validatePost,
  findCharacterTagCandidates,
  swapNameOrder,
};
