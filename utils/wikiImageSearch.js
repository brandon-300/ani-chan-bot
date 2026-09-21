// ─── Wikipedia image discovery (replaces the retired utils/googleImageSearch.js) ─
//
// WHAT CHANGED AND WHY: Google's Custom Search JSON API turned out to be
// closed to new Cloud projects — confirmed against Google's own developer
// forums and the Programmable Search Engine community: existing customers
// are grandfathered in (with a migration deadline of January 1, 2027), but
// a newly created project — like the one you set up — gets a 403 "This
// project does not have access" no matter what you enable in the console.
// That was NOT a setup mistake on your end; the free tier you configured
// correctly just isn't issued to new projects anymore. Bing's Image Search
// API is an even harder dead end on top of that — Microsoft fully retired
// it on August 11, 2025, so there's no key left to request there either.
//
// This uses Wikipedia's API instead: genuinely free, no API key, no
// per-project approval step, and — unlike a commercial search product —
// not the kind of thing that gets suddenly closed to new users. It's the
// same basic MediaWiki Action API that's powered bots and tools for well
// over a decade, on a single fixed domain (no "which wiki?" problem the
// way Fandom's per-franchise subdomains would have).
//
// THE REAL TRADE-OFF: coverage is narrower than a full web image search.
// Well-known characters/series usually have a Wikipedia page with an
// infobox image; obscure side characters or niche series often don't. A
// card with no good Wikipedia hit is flagged needs_review by
// repairCardImages.js and left on its CURRENT art — never broken, just
// not upgraded yet. If you want broader coverage later, SerpApi
// (serpapi.com) is a real, currently-working paid alternative with a
// 250-searches/month free tier — genuinely optional, not needed to use
// this file.
//
// UNCERTAINTY FLAG: Google's CSE closure and Bing's retirement were
// verified against current sources before this was written. The exact
// Wikipedia API response shape below is based on long-stable, widely-used
// MediaWiki API conventions (generator=search + prop=pageimages is a
// extremely common, years-old pattern), but could NOT be exercised against
// a live network call from the sandbox this was written in (no outbound
// network there). Test with `--only=<a well-known character name>` first
// (repairCardImages.js's --only now also accepts a plain name, not just a
// 6-character code). If the response shape is off, the error message
// below surfaces the raw response — that's a quick parsing fix, not a
// redesign, and paste it back if you hit one.
const axios = require('axios');

const WIKI_LANG = process.env.WIKI_SEARCH_LANG || 'en';
const WIKI_API_URL = `https://${WIKI_LANG}.wikipedia.org/w/api.php`;

// Wikimedia's API etiquette explicitly asks for a descriptive User-Agent
// identifying the calling application (see
// https://meta.wikimedia.org/wiki/User-Agent_policy) — an unset or generic
// one risks being throttled. Same reasoning utils/danbooru.js already
// applies to Danbooru's own required User-Agent.
const USER_AGENT = 'AniChanBot/1.0 (WhatsApp anime trading-card bot; run by a hobbyist on Termux)';

const REQUEST_TIMEOUT_MS = 15000;
const RESULTS_PER_QUERY = Math.min(10, Math.max(1, parseInt(process.env.WIKI_SEARCH_NUM || '5', 10)));

// No key/signup needed — always available. Kept as a function (rather than
// just not calling it) so repairCardImages.js's startup checks don't need
// to know or care which discovery backend is plugged in.
function isConfigured() {
  return true;
}

function buildQuery(name, series) {
  return series ? `${name} ${series}` : name;
}

// generator=search finds pages matching the query; prop=pageimages pulls
// each matching page's own infobox/lead image (piprop=original — the
// full-resolution file, not a cropped thumbnail); prop=info gives a real
// page URL; prop=extracts gives a short plain-text snippet for
// utils/imageValidator.js's text-match check. exlimit=max is required —
// without it, the extracts module silently only returns text for the
// FIRST matched page, not all of them.
async function searchCandidateImages(name, series) {
  const query = buildQuery(name, series || '');

  let res;
  try {
    res = await axios.get(WIKI_API_URL, {
      params: {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrlimit: RESULTS_PER_QUERY,
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
  } catch (err) {
    const raw = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    const wrapped = new Error(`Wikipedia search failed: ${raw}`);
    wrapped.code = 'WIKI_SEARCH_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }

  const pages = res.data?.query?.pages;
  if (!pages) return [];

  return Object.values(pages)
    .filter(p => p.original?.source) // drop pages that matched the search but have no image at all
    .map(p => ({
      imageUrl: p.original.source,
      sourcePageUrl: p.fullurl || `https://${WIKI_LANG}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
      title: p.title,
      snippet: p.extract || '',
      displayLink: `${WIKI_LANG}.wikipedia.org`,
      width: p.original.width || null,
      height: p.original.height || null,
      byteSize: null,
    }));
}

module.exports = { searchCandidateImages, isConfigured, buildQuery };
