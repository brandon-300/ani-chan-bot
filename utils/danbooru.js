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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// name -> danbooru tag slug. Danbooru character tags are lowercase,
// space/apostrophe/period -> underscore (e.g. "Levi" -> "levi", "Rem" ->
// "rem", "Marin Kitagawa" -> "marin_kitagawa") — unlike AniList, there's no
// family-name-first quirk to work around; given-name-first is already the
// convention here.
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/['".]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
    throw err;
  }
}

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

// Finds every character tag Danbooru has that matches `name`, most-used
// first. category:4 is Danbooru's "character" tag type — this deliberately
// does NOT try to filter by series here: Danbooru's copyright tags are
// internal slugs (shingeki_no_kyojin, kimetsu_no_yaiba, etc.), not English
// titles, so a plain match against a catalogue card's `series` field
// (e.g. "Attack on Titan") would almost always miss even for the RIGHT
// character — a much less reliable signal here than it was for AniList
// (which returns human-readable English/romaji titles directly).
async function findCharacterTagCandidates(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const data = await danbooruGet('/tags.json', {
    'search[name_matches]': `${slug}*`,
    'search[category]': 4,
    limit: 50,
  });
  const tags = Array.isArray(data) ? data : [];
  return tags
    .filter(t => t.post_count > 0)
    .sort((a, b) => b.post_count - a.post_count);
}

// Main entrypoint. Given a character name, returns the best available
// Danbooru artwork or null if nothing usable was found.
//
// Disambiguation strategy (e.g. multiple different "Rem"s across
// different series): without a reliable series-slug match (see above),
// this picks the candidate character tag with the highest post_count —
// i.e. whichever "Rem" has the most art on the site. That's a real
// heuristic, not a guarantee: it's usually the most well-known instance of
// a name, but for a genuinely obscure/ambiguous name it can still pick the
// wrong series. That tradeoff is deliberate — matches the "auto-apply the
// best match everywhere, spot-check after" approach chosen for the
// catalogue image upgrade this was built for, rather than the much more
// conservative skip-on-any-doubt behavior .backfillimages uses for
// AniList. Every result carries back `tagUsed` specifically so a spot-
// check later has something concrete to verify against.
async function findCharacterArtwork(name) {
  const candidates = await findCharacterTagCandidates(name);
  if (!candidates.length) return null;

  const tag = candidates[0].name;
  const posts = await searchPosts(tag);
  const best = selectBestImage(posts);
  if (!best) return null;

  return { ...best, tagUsed: tag, source: 'danbooru' };
}

module.exports = { findCharacterArtwork, searchPosts, selectBestImage, validatePost };
