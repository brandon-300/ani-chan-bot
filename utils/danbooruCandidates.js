// ─── Multiple booru candidates, for Gemini Vision to choose among ─────────
//
// WHY THIS EXISTS (replacing utils/wikiImageSearch.js, which replaced the
// Google Custom Search module before it): Wikipedia turned out to be
// structurally weak for this specific job — verified, not assumed:
//   1. Almost no individual anime character has a standalone Wikipedia
//      article. "Rias Gremory" is a REDIRECT to "List of High School DxD
//      characters" — confirmed by actually fetching the page. MediaWiki's
//      search doesn't follow a redirect to its target's own data unless
//      you explicitly request that.
//   2. Even fixing that, Wikipedia's non-free-content policy generally
//      doesn't allow a dedicated non-free character image on a "List of X
//      characters" article — usually only the parent work's own article
//      gets ONE fair-use image (the show's key visual), which isn't a
//      specific character's portrait anyway. A "working" query would
//      mostly still come back empty for exactly what this pipeline needs.
//
// What's actually well-populated per-character, and ALREADY working in
// this project with no new signup, is Danbooru — utils/danbooru.js. Its
// real problem was never availability, it was that .upgradeimages only
// ever looks at post #1 (whatever selectBestImage() ranks first by
// community score) and takes it uncritically — so an oddly-stylized or
// borderline-fanart pick never gets compared against anything else.
//
// This file does NOT modify utils/danbooru.js. It composes pieces that
// file ALREADY exports (searchPosts, selectBestImage, validatePost,
// findCharacterTagCandidates, swapNameOrder, findCharacterArtwork) to pull
// the top several DISTINCT posts instead of just the first one, so
// utils/imageValidator.js's Gemini Vision check has an actual pool to pick
// the cleanest / least fan-art-looking one FROM. That's what this project
// was originally asking for — just aimed at a source that's actually
// available, instead of one that isn't.
//
// FALLBACK: if Danbooru's own tag search comes up empty, this falls back
// to danbooru.js's existing findCharacterArtwork() orchestrator, which
// already tiers through Gelbooru then Safebooru — but only as a SINGLE
// candidate, not a pool, since those two sites' internal tag/post-search
// helpers aren't exported from danbooru.js (only Danbooru's are). Getting
// a real pool from them too would mean modifying danbooru.js itself,
// which this deliberately avoids — it's working, in-production code this
// project depends on for other commands, and doesn't need touching for
// this to work.
const {
  searchPosts, selectBestImage, findCharacterTagCandidates, swapNameOrder, findCharacterArtwork,
} = require('./danbooru');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// No key/signup needed — this reuses utils/danbooru.js's own config
// (DANBOORU/GELBOORU env vars, already set up and working).
function isConfigured() {
  return true;
}

function sourcePageUrlFor(source, postId) {
  if (source === 'gelbooru') return `https://gelbooru.com/index.php?page=post&s=view&id=${postId}`;
  if (source === 'safebooru') return `https://safebooru.org/index.php?page=post&s=view&id=${postId}`;
  return `https://danbooru.donmai.us/posts/${postId}`;
}

function toCandidateShape(pick, tagUsed, source) {
  return {
    imageUrl: pick.url,
    sourcePageUrl: sourcePageUrlFor(source, pick.postId),
    title: tagUsed,
    snippet: '',
    displayLink: source === 'gelbooru' ? 'gelbooru.com' : source === 'safebooru' ? 'safebooru.org' : 'danbooru.donmai.us',
    width: pick.width || null,
    height: pick.height || null,
    byteSize: null,
    // Not part of the shape utils/imageValidator.js's other sources fill
    // in — used only by the scoreCandidate() communityScore bonus, which
    // treats a missing value as 0 for any source that doesn't have one.
    communityScore: pick.score || 0,
  };
}

// Peels off the top `limit` DISTINCT posts for one matched tag by
// repeatedly calling danbooru.js's own selectBestImage() with a growing
// exclude set — reuses its exact validation + series-match-boost +
// score-sort logic UNMODIFIED, rather than reimplementing it here (that
// logic isn't exported on its own, only bundled inside selectBestImage).
function pickTopN(posts, seriesHint, excludePostId, limit) {
  const excluded = new Set(excludePostId != null ? [excludePostId] : []);
  const picks = [];
  for (let i = 0; i < limit; i++) {
    const remaining = posts.filter(p => !excluded.has(p.id));
    const best = selectBestImage(remaining, null, seriesHint);
    if (!best) break;
    picks.push(best);
    excluded.add(best.postId);
  }
  return picks;
}

// Returns an array of candidates (possibly empty for a genuinely
// unmatched/obscure character — not an error). Throws only when a booru
// site rate-limits us (propagated with code BOORU_RATE_LIMIT) so
// repairCardImages.js can stop the whole run early instead of quietly
// grinding through hundreds of cards that will all fail identically —
// same reasoning utils/danbooru.js's own header comment gives for letting
// a 429 propagate uncaught.
async function searchCandidateImages(name, series, { limit = 8, excludePostId = null } = {}) {
  try {
    let tagCandidates = await findCharacterTagCandidates(name);
    if (!tagCandidates.length) {
      const swapped = swapNameOrder(name);
      if (swapped) tagCandidates = await findCharacterTagCandidates(swapped);
    }

    for (const tagCandidate of tagCandidates.slice(0, 5)) {
      try {
        const posts = await searchPosts(tagCandidate.name, 40);
        const picks = pickTopN(posts, series, excludePostId, limit);
        if (picks.length) {
          return picks.map(p => toCandidateShape(p, tagCandidate.name, 'danbooru'));
        }
      } catch (err) {
        // A rate limit means EVERY remaining attempt (this tag, the next
        // ones, and the Gelbooru/Safebooru fallback below) would just
        // fail the same way — propagate it immediately so
        // repairCardImages.js can stop the whole run, same reasoning
        // danbooru.js's own header already documents for this. Anything
        // else (a timeout, a 5xx) is a one-off blip on THIS tag only —
        // matching how danbooru.js's own findCharacterArtworkDanbooru
        // isolates failures inside its equivalent loop, log it and try
        // the next tag candidate instead of losing the whole card to one
        // bad request.
        if (err.status === 429) throw err;
        console.warn(`[danbooruCandidates] tag "${tagCandidate.name}" attempt failed (${err.message}), trying next`);
      }
      await sleep(300);
    }

    // Danbooru's own tag search had nothing usable — fall back to the
    // existing single-best orchestrator (Gelbooru → Safebooru tiers).
    // Only one candidate, not a pool, but still strictly better than
    // skipping the card entirely.
    const single = await findCharacterArtwork(name, excludePostId, series);
    return single ? [toCandidateShape(single, single.tagUsed || name, single.source)] : [];
  } catch (err) {
    if (err.status === 429) {
      const wrapped = new Error(`A booru site rate-limited this run: ${err.message}`);
      wrapped.code = 'BOORU_RATE_LIMIT';
      throw wrapped;
    }
    console.warn(`[danbooruCandidates] lookup failed for "${name}": ${err.message}`);
    return [];
  }
}

module.exports = { searchCandidateImages, isConfigured };
