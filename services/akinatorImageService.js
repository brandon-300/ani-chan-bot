/**
 * Character lookup for the Akinator game.
 *
 * The reasoning model proposes a character and the anime it is from. Before the bot
 * announces it, the pair is checked against a real database and a real picture is
 * fetched (the model never draws or invents the picture):
 *
 *   1. AniList (GraphQL)       - already used by the card system, so it is known to be
 *                                reachable from this phone.
 *   2. Jikan (MyAnimeList)     - fallback.
 *
 * A candidate is only accepted when BOTH the character name and the anime match a
 * database entry. Names are compared loosely on purpose: MyAnimeList stores
 * "Burnedead, Mash" while the model says "Mash Burnedead"; word order, commas,
 * accents, case and a missing family name must not make a correct guess fail.
 */
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const {
  AKINATOR_ANILIST_URL,
  AKINATOR_ANILIST_ENABLED,
  AKINATOR_JIKAN_API_BASE,
  AKINATOR_JIKAN_ENABLED,
  AKINATOR_LOOKUP_TIMEOUT_MS,
  AKINATOR_JIKAN_MIN_INTERVAL_MS,
  AKINATOR_LOOKUP_SEARCH_LIMIT,
  AKINATOR_IMAGE_MAX_BYTES,
  AKINATOR_IMAGE_HOSTS,
} = require('../utils/config');

const USER_AGENT = 'AniChan-Akinator/1.0 (anime character lookup)';
const MAX_JIKAN_DETAIL_LOOKUPS = 3;

// ─── Name / title matching ───────────────────────────────────────────────────

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nameTokens(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(' ') : [];
}

// 3 = same words in any order ("Mash Burnedead" = "Burnedead, Mash")
// 2 = one name is contained in the other ("Mash" / "Mash Burnedead")
// 0 = different
function nameScore(expected, actual) {
  const a = nameTokens(expected);
  const b = nameTokens(actual);
  if (!a.length || !b.length) return 0;
  const sortedA = [...a].sort().join(' ');
  const sortedB = [...b].sort().join(' ');
  if (sortedA === sortedB) return 3;
  const setA = new Set(a);
  const setB = new Set(b);
  const aInB = a.every(token => setB.has(token));
  const bInA = b.every(token => setA.has(token));
  if (aInB || bInA) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    // A single short token ("Ai") matching a long name is too weak to trust.
    if (shorter === 1 && longer > 1 && [...(aInB ? a : b)][0].length < 3) return 0;
    return 2;
  }
  return 0;
}

function bestNameScore(expected, names) {
  return names.reduce((best, name) => Math.max(best, nameScore(expected, name)), 0);
}

// Series titles differ between databases ("Shingeki no Kyojin" / "Attack on Titan",
// "Naruto: Shippuuden" / "Naruto Shippuden"), so equality is too strict.
function animeScore(expected, actual) {
  const a = normalizeName(expected);
  const b = normalizeName(actual);
  if (!a || !b) return 0;
  if (a === b) return 3;
  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shortTokens = short.split(' ');
  // "mashle" inside "mashle magic and muscle"; "attack on titan" inside "attack on titan season 2"
  const longPadded = ` ${long} `;
  if ((shortTokens.length >= 2 || short.length >= 5) && longPadded.includes(` ${short} `)) return 2;
  // Romanisation differs between sources ("Shippuden" / "Shippuuden"): a long word that
  // is one letter off still counts as the same word.
  const common = tokensA.filter(token => tokensB.some(other => tokensClose(token, other))).length;
  const union = tokensA.length + tokensB.length - common;
  if (union && common / union >= 0.7 && common >= 2) return 1;
  return 0;
}

function tokensClose(a, b) {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6 || Math.abs(a.length - b.length) > 1) return false;
  // at most one insertion, deletion or substitution
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const restA = a.slice(i);
  const restB = b.slice(i);
  if (restA.length === restB.length) return restA.slice(1) === restB.slice(1);
  return restA.length > restB.length ? restA.slice(1) === restB : restB.slice(1) === restA;
}

function bestAnimeScore(expected, titles) {
  return titles.reduce((best, title) => Math.max(best, animeScore(expected, title)), 0);
}

// ─── Image host safety ───────────────────────────────────────────────────────

function allowedImageUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (!AKINATOR_IMAGE_HOSTS.includes(parsed.hostname.toLowerCase())) return '';
    return parsed.href;
  } catch (_err) {
    return '';
  }
}

// ─── AniList ─────────────────────────────────────────────────────────────────

const ANILIST_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    characters(search: $search, sort: [SEARCH_MATCH]) {
      id
      siteUrl
      name { full native alternative }
      image { large medium }
      media(perPage: 25, sort: POPULARITY_DESC) {
        nodes { title { romaji english native } synonyms }
      }
    }
  }
}`;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function anilistRequest(search, attempt = 1) {
  try {
    const { data } = await axios.post(
      AKINATOR_ANILIST_URL,
      { query: ANILIST_QUERY, variables: { search, perPage: AKINATOR_LOOKUP_SEARCH_LIMIT } },
      {
        timeout: AKINATOR_LOOKUP_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      }
    );
    return Array.isArray(data?.data?.Page?.characters) ? data.data.Page.characters : [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return [];
    if ((status === 429 || (status && status >= 500)) && attempt < 2) {
      const retryAfter = Number(err.response?.headers?.['retry-after']);
      await wait(Math.min(5000, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1.5) * 1000));
      return anilistRequest(search, attempt + 1);
    }
    throw err;
  }
}

function anilistMediaTitles(character) {
  const out = [];
  for (const node of character?.media?.nodes || []) {
    out.push(node?.title?.romaji, node?.title?.english, node?.title?.native, ...(node?.synonyms || []));
  }
  return out.filter(Boolean);
}

// Picks the best result for (name, anime). Pure, so it is unit-tested without a network.
function pickAniListMatch(results, candidateName, animeTitle) {
  let best = null;
  for (const character of results || []) {
    const names = [character?.name?.full, character?.name?.native, ...(character?.name?.alternative || [])].filter(Boolean);
    const nScore = bestNameScore(candidateName, names);
    if (!nScore) continue;

    let mediaMatch = null;
    let mScore = 0;
    for (const node of character?.media?.nodes || []) {
      const titles = [node?.title?.romaji, node?.title?.english, node?.title?.native, ...(node?.synonyms || [])].filter(Boolean);
      const score = bestAnimeScore(animeTitle, titles);
      if (score > mScore) { mScore = score; mediaMatch = node; }
    }
    if (!mScore) continue;

    const total = nScore * 10 + mScore;
    if (!best || total > best.total) best = { total, character, mediaMatch };
  }
  if (!best) return null;
  const { character, mediaMatch } = best;
  return {
    source: 'anilist',
    candidate: character.name?.full || candidateName,
    anime: mediaMatch?.title?.english || mediaMatch?.title?.romaji || animeTitle,
    imageUrl: allowedImageUrl(character.image?.large || character.image?.medium),
    sourceUrl: character.siteUrl || `https://anilist.co/character/${character.id}`,
  };
}

function searchTerms(candidateName) {
  const terms = [String(candidateName || '').trim()];
  const tokens = nameTokens(candidateName);
  // A second, shorter search catches names the model wrote differently from the database.
  const longest = [...tokens].sort((x, y) => y.length - x.length)[0];
  if (tokens.length > 1 && longest && longest.length >= 3) terms.push(longest);
  return [...new Set(terms.filter(Boolean))].slice(0, 2);
}

async function lookupAniList(candidateName, animeTitle) {
  for (const term of searchTerms(candidateName)) {
    const match = pickAniListMatch(await anilistRequest(term), candidateName, animeTitle);
    if (match) return match;
  }
  return null;
}

// ─── Jikan (MyAnimeList) ─────────────────────────────────────────────────────

let jikanQueue = Promise.resolve();
let lastJikanRequestAt = 0;

function jikanRequest(url, params) {
  const request = jikanQueue.then(async () => {
    const delay = Math.max(0, AKINATOR_JIKAN_MIN_INTERVAL_MS - (Date.now() - lastJikanRequestAt));
    if (delay) await wait(delay);
    lastJikanRequestAt = Date.now();
    return axios.get(url, {
      params,
      timeout: AKINATOR_LOOKUP_TIMEOUT_MS,
      maxContentLength: 2 * 1024 * 1024,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  });
  jikanQueue = request.then(() => undefined, () => undefined);
  return request;
}

function jikanImage(character) {
  const images = character?.images || {};
  return allowedImageUrl(images.jpg?.image_url || images.webp?.image_url);
}

function jikanAnimeTitles(relation) {
  const anime = relation?.anime || relation;
  if (!anime || typeof anime !== 'object') return [];
  return [anime.title, anime.title_english, anime.title_japanese, ...(anime.titles || []).map(t => t?.title)].filter(Boolean);
}

async function lookupJikan(candidateName, animeTitle) {
  for (const term of searchTerms(candidateName)) {
    const search = await jikanRequest(`${AKINATOR_JIKAN_API_BASE}/characters`, { q: term, limit: AKINATOR_LOOKUP_SEARCH_LIMIT });
    const results = Array.isArray(search.data?.data) ? search.data.data : [];
    const ranked = results
      .map(result => ({ result, score: bestNameScore(candidateName, [result.name, result.name_kanji, ...(result.nicknames || [])].filter(Boolean)) }))
      .filter(entry => entry.score > 0 && Number.isInteger(Number(entry.result.mal_id)))
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_JIKAN_DETAIL_LOOKUPS);

    for (const { result } of ranked) {
      const detail = await jikanRequest(`${AKINATOR_JIKAN_API_BASE}/characters/${Number(result.mal_id)}/full`);
      const full = detail.data?.data;
      if (!full) continue;
      let matched = null;
      let matchedScore = 0;
      for (const relation of Array.isArray(full.anime) ? full.anime : []) {
        const titles = jikanAnimeTitles(relation);
        const score = bestAnimeScore(animeTitle, titles);
        if (score > matchedScore) { matchedScore = score; matched = relation; }
      }
      if (!matched) continue;
      const titles = jikanAnimeTitles(matched);
      return {
        source: 'jikan',
        candidate: full.name || result.name,
        anime: matched.anime?.title_english || titles[0] || animeTitle,
        imageUrl: jikanImage(full) || jikanImage(result),
        sourceUrl: full.url || result.url || `https://myanimelist.net/character/${Number(result.mal_id)}`,
      };
    }
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Resolves { source, candidate, anime, imageUrl, sourceUrl } when the character AND
// its anime are confirmed by a database, otherwise null. A provider that is down is
// skipped; it only throws when every enabled provider failed to answer at all.
async function lookupCandidate(candidateName, animeTitle) {
  const name = String(candidateName || '').trim().slice(0, 160);
  const anime = String(animeTitle || '').trim().slice(0, 160);
  if (!name || !anime) return null;

  const providers = [];
  if (AKINATOR_ANILIST_ENABLED) providers.push(['AniList', lookupAniList]);
  if (AKINATOR_JIKAN_ENABLED) providers.push(['Jikan', lookupJikan]);

  const errors = [];
  for (const [label, lookup] of providers) {
    try {
      const match = await lookup(name, anime);
      if (match) return match;
    } catch (err) {
      console.warn(`[Akinator] ${label} lookup unavailable:`, err.message);
      errors.push(err);
    }
  }
  if (providers.length && errors.length === providers.length) throw errors[0];
  return null;
}

function safeFileName(name) {
  const stem = String(name || 'anime-character')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'anime-character';
  return `${stem}.jpg`;
}

async function downloadCharacterImage(imageUrl, characterName) {
  const safeUrl = allowedImageUrl(imageUrl);
  if (!safeUrl) return null;

  const response = await axios.get(safeUrl, {
    responseType: 'arraybuffer',
    timeout: AKINATOR_LOOKUP_TIMEOUT_MS,
    maxContentLength: AKINATOR_IMAGE_MAX_BYTES,
    maxBodyLength: AKINATOR_IMAGE_MAX_BYTES,
    headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': USER_AGENT },
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length > AKINATOR_IMAGE_MAX_BYTES) return null;

  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return null;

  return new MessageMedia(contentType, buffer.toString('base64'), safeFileName(characterName));
}

module.exports = {
  lookupCandidate,
  downloadCharacterImage,
  _normalizeName: normalizeName,
  _nameScore: nameScore,
  _animeScore: animeScore,
  _allowedImageUrl: allowedImageUrl,
  _pickAniListMatch: pickAniListMatch,
  _jikanAnimeTitles: jikanAnimeTitles,
  _searchTerms: searchTerms,
};
