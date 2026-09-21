// ─── One-off catalogue image repair: replace booru/AniList art with vetted,
// higher-quality art via Wikipedia image search + Gemini Vision ──────────
//
// WHY THIS EXISTS: .upgradeimages (commands/cardmanager.js) already moved
// the catalogue from AniList's inconsistent art to Danbooru/Gelbooru/
// Safebooru, but booru art is still fan art by nature — some of it is
// gorgeous, some of it is genuinely ugly or off-model, and there's no tag
// on a booru post that says "this one looks bad." This script searches for
// cleaner/more official-looking art per card instead, scores every
// candidate itself (never just trusting a single AI's say-so — see
// utils/imageValidator.js's scoreCandidate()), and only replaces a card's
// art when a candidate clears a real bar. Anything that doesn't is flagged
// imageReviewStatus: 'needs_review' and left on its CURRENT art — this
// never blanks out or breaks a card's image, only upgrades it.
//
// DISCOVERY BACKEND: utils/wikiImageSearch.js (Wikipedia's API) — see that
// file's header for the full story, short version: Google's Custom Search
// JSON API is closed to new projects (confirmed, not a setup mistake —
// existing customers are grandfathered until a Jan 2027 migration
// deadline, new ones get a 403 no matter what's enabled in the console),
// and Bing's Image Search API was fully retired in August 2025. Wikipedia
// has real but narrower coverage than a full web image search — obscure
// characters often won't have a hit, and are flagged needs_review rather
// than force-fed a bad match.
//
// A NOTE ON WHAT "GEMINI DOES" HERE: Gemini's API doesn't have an image-
// search mode that returns real, hotlinkable image URLs — its Google
// Search grounding tool grounds TEXT with citations, and those citations
// are redirect links to pages, not images. Gemini's actual job in this
// pipeline is VISION — looking at each downloaded candidate and judging
// whether it depicts the right character (utils/imageValidator.js's
// visionCheckCandidate()) — exactly what utils/gemini.js's existing
// generateVision() already does elsewhere in this bot (.copilot on an
// image, etc.), completely unmodified.
//
// METADATA (name/series) IS *NOT* TOUCHED HERE — if a card's name/series
// is wrong at the source, that's what renameCardsWithGemini.js already
// exists to fix, using the card's AniList-sourced description as ground
// truth. Run that FIRST if you suspect bad metadata — searching for art
// under a wrong name will find wrong art. This script trusts
// CardCatalogue.name/series as already correct.
//
// SAFETY: defaults to DRY RUN — runs real searches, real downloads, real
// Gemini Vision checks, and writes a full audit log every card, but
// touches NEITHER Cloudinary NOR MongoDB unless you pass --apply. Only
// touches CardCatalogue.imageUrl/imageSource/imageSourceUrl/
// imageSourceTitle/imageQualityScore/imageConfidence/imageHash/
// imageVerifiedAt/imageReviewStatus (+ resets the render cache, same as
// .editcard/.upgradeimages) — never touches name/series/tier/description
// or OwnedCard.
//
// COST: Wikipedia's API needs no key and has no published hard daily quota
// the way Google's CSE did — but it's a shared public resource, so this
// still paces itself (REPAIR_DELAY_MS between cards, a real User-Agent)
// rather than hammering it. Gemini Vision still uses your normal
// GEMINI_API_KEY quota (up to REPAIR_VISION_TOP_N calls/card), and
// Cloudinary gets one upload per ACCEPTED card, only in --apply mode.
//
// USAGE:
//   node repairCardImages.js                                 dry run, all pending cards
//   node repairCardImages.js --limit=10                       dry run, first 10 pending (TEST THIS FIRST)
//   node repairCardImages.js --apply --limit=10                write real changes for 10 cards
//   node repairCardImages.js --resume=<audit-log.json> [--apply]
//   node repairCardImages.js --only="Rias Gremory"             just this card, by NAME (same lookup .ci uses — no code needed)
//   node repairCardImages.js --only=ABC123,"Rias Gremory"      mix of codes and/or names, comma-separated
//   node repairCardImages.js --review-only                     only cards already flagged needs_review
//   node repairCardImages.js --all                             reprocess EVERY card, even already-verified ones
//   node repairCardImages.js --no-vision                        skip Gemini Vision (domain/resolution/text score only — cheaper, less reliable)
//   node repairCardImages.js --min-score=70                     override REPAIR_MIN_SCORE for this run
//
// "pending" (the default, no flags) means: every card whose
// imageReviewStatus isn't currently 'verified'. Re-running the plain
// command later only processes NEW/still-unresolved cards; --all forces a
// full re-sweep (e.g. after you've tuned the scoring weights).
//
// RESUME SEMANTICS (same philosophy as renameCardsWithGemini.js): entries
// logged 'verified' are never revisited. Entries logged 'proposed' (a dry
// run found an acceptable candidate but didn't write it) are, on
// --apply --resume=<file>, WRITTEN using that already-chosen candidate —
// re-downloading just that one URL to upload it, but WITHOUT a new search
// or new Vision calls, since that decision was already made and reviewed.
// 'needs_review' and 'skipped' entries are deliberately left out of the
// resume carry-forward — they fall through and get a fresh attempt.
//
// Optional env overrides (.env) — all have working defaults:
//   WIKI_SEARCH_LANG          Wikipedia language edition (default 'en')
//   WIKI_SEARCH_NUM           candidate pages fetched per card, max 10 (default 5)
//   REPAIR_MAX_CANDIDATES     of those, how many actually get downloaded (default 5)
//   REPAIR_VISION_TOP_N       how many downloaded candidates get a Gemini Vision check (default 2)
//   REPAIR_MIN_SCORE          acceptance threshold, 0-100 (default 65 — see
//                             utils/imageValidator.js's own tuning note)
//   REPAIR_DELAY_MS           pause between cards (default 2000)

const mongoose = require('mongoose');
require('dotenv').config();
const fs = require('fs');

const { CardCatalogue } = require('./models/Card');
const { searchCandidateImages } = require('./utils/wikiImageSearch');
const {
  downloadImageBuffer, getImageDimensions, sha256Hex, classifyDomain,
  matchTextSignal, visionCheckCandidate, scoreCandidate,
} = require('./utils/imageValidator');
const { uploadBufferToCloud, isCloudConfigured } = require('./utils/cloudinary');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NO_VISION = args.includes('--no-vision');
const ALL = args.includes('--all');
const REVIEW_ONLY = args.includes('--review-only');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const resumeArg = args.find(a => a.startsWith('--resume='));
const RESUME_PATH = resumeArg ? resumeArg.split('=')[1] : null;
const onlyArg = args.find(a => a.startsWith('--only='));
// Raw, case-preserved tokens — could be 6-char codes OR plain character
// names (quoted if they contain a space, e.g. --only="Rias Gremory"). Each
// token is resolved the same way .ci resolves its own argument, below.
const ONLY_TOKENS = onlyArg ? onlyArg.split('=').slice(1).join('=').split(',').map(t => t.trim()).filter(Boolean) : null;
const minScoreArg = args.find(a => a.startsWith('--min-score='));

const MAX_CANDIDATES = Math.min(10, Math.max(1, parseInt(process.env.REPAIR_MAX_CANDIDATES || '5', 10)));
const VISION_TOP_N = Math.max(0, parseInt(process.env.REPAIR_VISION_TOP_N || '2', 10));
const MIN_SCORE = minScoreArg ? parseInt(minScoreArg.split('=')[1], 10) : parseInt(process.env.REPAIR_MIN_SCORE || '65', 10);
const DELAY_MS = parseInt(process.env.REPAIR_DELAY_MS || '2000', 10);
const PROGRESS_CHUNK = 10;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Resolves one --only token to catalogue card(s) — a 6-character code
// matched exactly, OR (same fallback .ci uses) a case-insensitive
// substring match against name/aliases. Returns an array because a loose
// name match could legitimately hit more than one card — all of them get
// processed rather than silently picking one.
function resolveOnlyToken(token, allCards) {
  if (/^[A-Z0-9]{6}$/i.test(token)) {
    const code = token.toUpperCase();
    const byCode = allCards.find(c => c.cardId === code);
    if (byCode) return [byCode];
  }
  const re = new RegExp(token, 'i');
  return allCards.filter(c => re.test(c.name) || (c.aliases || []).some(a => re.test(a)));
}

// Downloads+scores every reachable candidate for one card, without writing
// anything anywhere. Returns { attempts, best } where `best` is the
// highest-scoring non-hard-rejected attempt (or null if none qualify) and
// `attempts` is every candidate actually tried, for the audit log.
async function evaluateCandidates(doc, candidates, useVision) {
  const attempts = [];

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    let buffer, contentType;
    try {
      const dl = await downloadImageBuffer(candidate.imageUrl);
      buffer = dl.buffer;
      contentType = dl.contentType;
    } catch (err) {
      attempts.push({ candidate, error: `download failed: ${err.message}` });
      continue;
    }

    const dims = getImageDimensions(buffer);
    // If we can't parse it as any known image format AND the server didn't
    // even claim an image content-type, this almost certainly wasn't an
    // image at all (an HTML error/login/block page served at that URL) —
    // that's the "HTML pretending to be a JPG" case, scored as a hard
    // reject rather than just "unknown dimensions".
    const formatMismatch = !dims && !(contentType || '').startsWith('image/');

    const domainTier = classifyDomain(candidate.displayLink || hostnameOf(candidate.imageUrl));
    const textMatch = matchTextSignal(doc.name, doc.series, candidate.title, candidate.snippet);

    const preScore = scoreCandidate({ candidate, dims, domainTier, textMatch, vision: null, formatMismatch });
    attempts.push({ candidate, buffer, contentType, dims, domainTier, textMatch, formatMismatch, preScore });
  }

  // Vision-check only the top N pre-scored (successfully downloaded)
  // attempts — see the file header for why: it's the expensive step.
  const downloaded = attempts.filter(a => a.buffer);
  downloaded.sort((a, b) => b.preScore.score - a.preScore.score);

  for (let i = 0; i < downloaded.length; i++) {
    const a = downloaded[i];
    if (useVision && i < VISION_TOP_N && !a.preScore.hardReject) {
      a.vision = await visionCheckCandidate({
        buffer: a.buffer,
        mimeType: a.contentType && a.contentType.startsWith('image/') ? a.contentType : 'image/jpeg',
        name: doc.name,
        series: doc.series,
      });
    }
    a.finalScore = scoreCandidate({
      candidate: a.candidate, dims: a.dims, domainTier: a.domainTier,
      textMatch: a.textMatch, vision: a.vision || null, formatMismatch: a.formatMismatch,
    });
  }

  let best = null;
  for (const a of downloaded) {
    if (a.finalScore.hardReject) continue;
    if (!best || a.finalScore.score > best.finalScore.score) best = a;
  }

  return { attempts, best };
}

// Applies an already-chosen winning attempt to Cloudinary + MongoDB.
async function applyWinner(doc, winner) {
  if (!isCloudConfigured()) {
    throw new Error('Cloudinary is not configured — set CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) in .env before running --apply');
  }
  const { url } = await uploadBufferToCloud(winner.buffer, {
    folder: 'card-source-art',
    publicId: doc.cardId,
  });

  doc.imageUrl = url;
  doc.imageSource = 'google_image_search'; // enum value kept as-is — see models/Card.js; it now covers this whole "external image-repair pipeline" family rather than literally Google
  doc.sourcePostId = null;
  doc.imageSourceUrl = winner.candidate.sourcePageUrl;
  doc.imageSourceTitle = winner.candidate.title;
  doc.imageQualityScore = winner.finalScore.score;
  doc.imageConfidence = winner.vision ? winner.vision.confidence : null;
  doc.imageHash = sha256Hex(winner.buffer);
  doc.imageVerifiedAt = new Date();
  doc.imageReviewStatus = 'verified';
  // Same cache-invalidation as .editcard/.upgradeimages — imageUrl feeds
  // the renderer, so any cached PNG is now stale.
  doc.renderedUrl = null;
  doc.renderVersion = null;
  doc.renderedAt = null;
  await doc.save();
}

// Re-downloads a previously-chosen candidate URL to materialize a
// 'proposed' resume entry under --apply, without a new search or new
// vision calls (see the RESUME SEMANTICS header comment).
async function materializeProposed(doc, entry) {
  const { buffer } = await downloadImageBuffer(entry.chosenImageUrl);
  await applyWinner(doc, {
    buffer,
    candidate: { sourcePageUrl: entry.chosenSourcePageUrl, title: entry.chosenTitle },
    finalScore: { score: entry.score },
    vision: entry.confidence != null ? { confidence: entry.confidence } : null,
  });
}

(async () => {
  if (!NO_VISION && !process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in .env — either set it, or pass --no-vision to score without a vision check.');
    process.exit(1);
  }
  if (APPLY && !isCloudConfigured()) {
    console.error('❌ Cloudinary is not configured in .env, and --apply needs it to store accepted images. Set CLOUDINARY_URL (or the three CLOUDINARY_* vars) first, or drop --apply to just preview.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB. Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes will be written)'}`);
  console.log(`Vision checks: ${NO_VISION ? 'DISABLED (--no-vision)' : `top ${VISION_TOP_N} candidate(s)/card`} | Min accept score: ${MIN_SCORE} | Candidates/card: ${MAX_CANDIDATES}\n`);

  const allCards = await CardCatalogue.find();
  const cardById = new Map(allCards.map(c => [c.cardId, c]));

  let audit = [];
  let logPath = `./image-repair-audit-${Date.now()}.json`;
  const alreadyDone = new Set();
  let verified = 0, needsReview = 0, skipped = 0;

  function flushAudit() {
    fs.writeFileSync(logPath, JSON.stringify(audit, null, 2));
  }

  if (RESUME_PATH) {
    if (!fs.existsSync(RESUME_PATH)) {
      console.error(`❌ --resume file not found: ${RESUME_PATH}`);
      process.exit(1);
    }
    const previous = JSON.parse(fs.readFileSync(RESUME_PATH, 'utf8'));
    logPath = RESUME_PATH; // keep appending to the same file

    for (const entry of previous) {
      if (entry.status === 'verified') {
        audit.push(entry);
        alreadyDone.add(entry.cardId);
        verified++;
      } else if (entry.status === 'proposed') {
        alreadyDone.add(entry.cardId); // never re-search/re-vision this one
        if (APPLY) {
          const doc = cardById.get(entry.cardId);
          if (!doc) {
            console.warn(`  ⚠️  ${entry.cardId} no longer exists in the catalogue — skipping`);
            audit.push({ ...entry, status: 'skipped', reason: 'card no longer exists in CardCatalogue' });
            skipped++;
            continue;
          }
          try {
            await materializeProposed(doc, entry);
            audit.push({ ...entry, status: 'verified' });
            verified++;
            console.log(`  ✅ ${entry.name} [${entry.cardId}] — applied from resume log (score ${entry.score})`);
          } catch (err) {
            audit.push({ ...entry, status: 'skipped', reason: `resume re-download failed: ${err.message}` });
            skipped++;
            console.error(`  ❌ ${entry.name} [${entry.cardId}] — resume re-download failed: ${err.message}`);
          }
        } else {
          audit.push(entry); // still just proposed, dry run — nothing to write
        }
      }
      // 'needs_review' and 'skipped' entries are deliberately left OUT of
      // alreadyDone here — they fall through and get a fresh attempt via
      // the normal pipeline below, same philosophy as
      // renameCardsWithGemini.js's own resume handling.
    }

    flushAudit();
    console.log(`Resuming from ${RESUME_PATH}: ${alreadyDone.size} card(s) already decided.\n`);
  }

  let pending;
  if (ONLY_TOKENS) {
    const matched = new Map(); // cardId -> doc, de-duplicated across tokens
    const missed = [];
    for (const token of ONLY_TOKENS) {
      const hits = resolveOnlyToken(token, allCards);
      if (!hits.length) missed.push(token);
      for (const c of hits) matched.set(c.cardId, c);
    }
    if (missed.length) console.warn(`⚠️  No catalogue match for: ${missed.join(', ')}`);
    pending = [...matched.values()];
  } else if (REVIEW_ONLY) {
    pending = allCards.filter(c => c.imageReviewStatus === 'needs_review');
  } else if (ALL) {
    pending = allCards.slice();
  } else {
    pending = allCards.filter(c => c.imageReviewStatus !== 'verified');
  }
  pending = pending.filter(c => !alreadyDone.has(c.cardId));
  if (LIMIT) pending = pending.slice(0, LIMIT);

  if (!pending.length) {
    console.log('Nothing to process with the current flags/resume state.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Processing ${pending.length} card(s): ${pending.map(c => `${c.name} [${c.cardId}]`).join(', ')}\n`);

  let processedCount = 0;
  for (const doc of pending) {
    try {
      const candidates = await searchCandidateImages(doc.name, doc.series);

      if (!candidates.length) {
        needsReview++;
        audit.push({ cardId: doc.cardId, name: doc.name, series: doc.series, status: 'needs_review', reason: 'no search results found' });
        console.log(`  🔎 ${doc.name} [${doc.cardId}] — no search results, flagged for manual review`);
      } else {
        const { attempts, best } = await evaluateCandidates(doc, candidates, !NO_VISION);

        if (best && best.finalScore.score >= MIN_SCORE) {
          const entry = {
            cardId: doc.cardId, name: doc.name, series: doc.series,
            oldImageUrl: doc.imageUrl, oldImageSource: doc.imageSource,
            chosenImageUrl: best.candidate.imageUrl,
            chosenSourcePageUrl: best.candidate.sourcePageUrl,
            chosenTitle: best.candidate.title,
            score: best.finalScore.score,
            confidence: best.vision ? best.vision.confidence : null,
            reasons: best.finalScore.reasons,
            candidatesTried: attempts.length,
            status: APPLY ? 'verified' : 'proposed',
          };

          if (APPLY) {
            await applyWinner(doc, best);
            verified++;
            console.log(`  ✅ ${doc.name} [${doc.cardId}] — score ${best.finalScore.score}, from ${best.domainTier} domain (${hostnameOf(best.candidate.imageUrl)})`);
          } else {
            console.log(`  📝 ${doc.name} [${doc.cardId}] — would accept score ${best.finalScore.score} from ${hostnameOf(best.candidate.imageUrl)}`);
          }
          audit.push(entry);
        } else {
          needsReview++;
          const bestScore = best ? best.finalScore.score : null;
          audit.push({
            cardId: doc.cardId, name: doc.name, series: doc.series,
            status: 'needs_review',
            reason: best ? `best candidate scored ${bestScore} (< ${MIN_SCORE})` : 'every candidate was hard-rejected',
            attempted: attempts.map(a => ({
              imageUrl: a.candidate.imageUrl,
              error: a.error || null,
              score: a.finalScore ? a.finalScore.score : (a.preScore ? a.preScore.score : null),
              reasons: a.finalScore ? a.finalScore.reasons : (a.preScore ? a.preScore.reasons : null),
            })),
          });
          if (APPLY) {
            doc.imageReviewStatus = 'needs_review';
            await doc.save();
          }
          console.log(`  🔎 ${doc.name} [${doc.cardId}] — no candidate cleared the bar (best: ${bestScore ?? 'n/a'}), flagged for manual review`);
        }
      }
    } catch (err) {
      // Wikipedia has no hard daily-quota cliff the way Google's CSE did,
      // so a single failed request is treated as this-card-only rather
      // than aborting the whole run — it's far more likely a transient
      // network blip on an unstable connection than a systemic block.
      skipped++;
      audit.push({ cardId: doc.cardId, name: doc.name, series: doc.series, status: 'skipped', reason: err.message });
      console.error(`  ❌ ${doc.name} [${doc.cardId}] — ${err.code === 'WIKI_SEARCH_ERROR' ? 'search' : 'unexpected'} error: ${err.message}`);
    }

    processedCount++;
    flushAudit();
    if (processedCount % PROGRESS_CHUNK === 0 && processedCount < pending.length) {
      console.log(`  ⏳ Progress: ${processedCount}/${pending.length}`);
    }
    if (processedCount < pending.length) await sleep(DELAY_MS);
  }

  console.log(`\n─── Done ───`);
  console.log(`${APPLY ? 'Verified/written' : 'Would accept'}: ${verified}`);
  console.log(`Needs manual review: ${needsReview}`);
  console.log(`Skipped (errors): ${skipped}`);
  console.log(`Full audit log written to: ${logPath}`);
  if (needsReview > 0) {
    console.log(`Review those with: node repairCardImages.js --review-only${APPLY ? ' --apply' : ''}  (after manually re-checking, or adjusting REPAIR_MIN_SCORE / the domain lists in utils/imageValidator.js)`);
  }
  if (!APPLY) {
    console.log(`\nThis was a DRY RUN — nothing was written to Cloudinary or MongoDB. Review ${logPath}, then re-run with --apply --resume=${logPath} to write these exact decisions (no new searches or vision calls for anything already 'proposed').`);
  }

  await mongoose.disconnect();
})().catch(async err => {
  console.error('Fatal error:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
