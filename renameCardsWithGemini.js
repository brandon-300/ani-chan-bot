// ─── One-off catalogue rename: fix name/series using Gemini ───────────────
//
// WHY THIS EXISTS: .upgradeimages matches booru art against `name` — but a
// chunk of the catalogue has bad name/series data at the source (e.g. a
// card literally named "Slime" with series "Common", when the description
// field makes clear it's actually Rimuru Tempest from "That Time I Got
// Reincarnated as a Slime" — "Common" is a tier value that ended up in the
// series field somewhere upstream). No amount of tag-matching logic in
// utils/danbooru.js can fix a name/series problem that starts in the data
// itself, so this fixes it at the source instead.
//
// HOW IT WORKS: every catalogue card already has a `description` field
// (pulled from AniList when the card was created) that almost always
// states the character's real name and real series in plain text. This
// sends that description to Gemini per card (batched, see BATCH_SIZE) and
// asks it to extract the real name/series, explicitly told to leave a
// field unchanged if it isn't confident.
//
// SAFETY: defaults to DRY RUN — prints every proposed change and writes an
// audit log AFTER EVERY BATCH (not just at the end — see the Aug 2026
// bugfix note below), but touches nothing in MongoDB unless you pass
// --apply. Only touches CardCatalogue.name/series (+ resets the render
// cache on anything that changes, same as .editcard) — never tier,
// description, imageUrl, or OwnedCard, matching how .editcard already
// behaves.
//
// USAGE:
//   node renameCardsWithGemini.js                        dry run, all cards
//   node renameCardsWithGemini.js --limit=10              dry run, first 10 only (test this first!)
//   node renameCardsWithGemini.js --apply                 actually writes changes
//   node renameCardsWithGemini.js --resume=rename-audit-....json
//                                                          continue a previous run using the SAME
//                                                          log file, skipping anything already
//                                                          resolved (applied/unchanged/proposed) —
//                                                          only retries cards that were skipped
//                                                          last time (almost always quota
//                                                          exhaustion, not a real "can't tell").
//                                                          Combine with --apply as needed.
//
// BUGFIX (Aug 2026, after a live run hit Gemini's free-tier request quota
// partway through and got Ctrl-C'd): the first version of this script only
// wrote its audit log once, after the ENTIRE run finished — so interrupting
// it (deliberately, or via an unrecoverable quota error) lost every
// proposed change from the whole run, dry-run or not, with no way to see
// what had already been figured out. It also retried rate limits on a
// fixed 4.5s/9s schedule regardless of what Gemini's own error said to
// wait, and kept using that same short pacing for every LATER batch even
// after repeatedly getting rate-limited — so it kept re-triggering the
// same wall instead of backing off. Fixed here: the audit log is
// (re)written after every single batch, and the delay between batches
// grows for the rest of the run whenever a rate limit is hit (see
// `throttle` below), rather than resetting straight back to the original
// pace next batch.
//
// MODEL CHOICE (this is what actually caused the quota wall): your .env's
// GEMINI_TEXT_MODEL is set to gemini-3.5-flash, which — per the error your
// run hit — has a very small free-tier requests-per-minute allowance.
// That's presumably deliberately chosen for the bot's live chat/persona
// features. This bulk classification task doesn't need that model at all,
// so rather than touch your live GEMINI_TEXT_MODEL (which could break
// something that specifically depends on it), this script reads a
// SEPARATE env var, GEMINI_RENAME_MODEL, and only falls back to whatever
// TEXT_MODEL is if that's unset.
//
// I'm not hardcoding a specific "lighter" model name as the default here —
// utils/gemini.js's own comments already document that Google has been
// restricting which models a given key can use every few weeks, and you
// already have probe-gemini-models.sh in this project for exactly this
// reason. Run that, note whichever *-lite model comes back ✅ WORKS for
// your actual key, and set GEMINI_RENAME_MODEL to it before running this
// at scale — a Lite-tier model's free quota is typically far more
// generous for a bulk job like this than a full Flash model's.
//
// Other optional env overrides (.env):
//   GEMINI_RENAME_BATCH_SIZE   cards per Gemini call (default 15 — for a
//                              free-tier quota counted in REQUESTS, not
//                              tokens, fewer/larger batches cost less than
//                              more/smaller ones)
//   GEMINI_RENAME_DELAY_MS     starting pause between calls (default 8000)
//   GEMINI_RENAME_MAX_DELAY_MS ceiling the adaptive backoff won't exceed
//                              (default 90000)
//
// UNCERTAINTY FLAG: the quota-exceeded errors in your last run reported
// two different numbers ("limit: 5" and later "limit: 20") for what looked
// like the same model+metric — I can't explain that discrepancy from here
// (no access to your Google AI Studio dashboard). If this still hits walls
// after switching models, check https://ai.dev/rate-limit directly for
// your key's actual current limits rather than trusting either number.

const mongoose = require('mongoose');
require('dotenv').config();
const fs = require('fs');

const { CardCatalogue } = require('./models/Card');
const { generateText } = require('./utils/gemini');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const resumeArg = args.find(a => a.startsWith('--resume='));
const RESUME_PATH = resumeArg ? resumeArg.split('=')[1] : null;

const BATCH_SIZE = parseInt(process.env.GEMINI_RENAME_BATCH_SIZE || '15', 10);
const START_DELAY_MS = parseInt(process.env.GEMINI_RENAME_DELAY_MS || '8000', 10);
const MAX_DELAY_MS = parseInt(process.env.GEMINI_RENAME_MAX_DELAY_MS || '90000', 10);
const RENAME_MODEL = process.env.GEMINI_RENAME_MODEL || undefined; // undefined -> generateText uses its own default
const MAX_DESCRIPTION_CHARS = 700;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const SYSTEM_PROMPT = `You correct anime/manga trading card metadata for a card-collecting bot.

You will receive a JSON array of cards. Each has: id, currentName, currentSeries, description (may be empty).

For EACH card, determine:
- "name": the character's real, commonly-used full name (matching how AniList/MyAnimeList list it), based on the description. Do NOT replace a genuinely correct generic/title name (e.g. a canonically unnamed character known only by a title) — only fix it if the description clearly gives a real name the current one is missing or wrong.
- "series": the anime/manga's title, in the same plain English/romanized style already used elsewhere (e.g. "Attack on Titan", "Genshin Impact", "Jujutsu Kaisen", "That Time I Got Reincarnated as a Slime") — never a tier label ("Common", "Rare", etc.), never empty.

RULES:
- Base your answer ONLY on the description text given. Do not use outside knowledge to invent details the description doesn't support.
- If the description is empty, too short, or doesn't clearly support a correction, return the EXACT original currentName/currentSeries unchanged for that card. Do not guess.
- If the current values already look correct, return them unchanged.
- Respond with ONLY a raw JSON array, no markdown code fences, no commentary, no explanation. Each element: {"id": "...", "name": "...", "series": "..."}. Include EVERY card from the input, in any order, matched by id.`;

function buildPrompt(batch) {
  const payload = batch.map(c => ({
    id: c.cardId,
    currentName: c.name,
    currentSeries: c.series,
    description: (c.description || '').slice(0, MAX_DESCRIPTION_CHARS),
  }));
  return `Cards:\n${JSON.stringify(payload, null, 2)}`;
}

function parseJsonArray(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('response was not a JSON array');
  return parsed;
}

// Pulls a "Please retry in 31.7s" style hint out of Gemini's error message,
// if present, so the wait actually matches what Google asked for instead
// of a fixed guess.
function parseRetryHintMs(message) {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

// Shared mutable backoff state: grows (and only grows) for the rest of the
// run every time a rate limit is hit, so later batches don't immediately
// re-trigger the same wall the earlier ones just backed off from.
function makeThrottle() {
  return { delay: START_DELAY_MS };
}
function bumpThrottle(throttle, usedMs) {
  throttle.delay = Math.min(MAX_DELAY_MS, Math.max(throttle.delay, usedMs) * 1.3);
}

async function resolveBatch(batch, throttle, attempt = 1) {
  if (!batch.length) return [];

  try {
    const raw = await generateText({
      systemPrompt: SYSTEM_PROMPT,
      prompt: buildPrompt(batch),
      maxOutputTokens: 200 + batch.length * 120,
      ...(RENAME_MODEL ? { model: RENAME_MODEL } : {}),
    });
    const results = parseJsonArray(raw);

    const byId = new Map(results.map(r => [String(r.id), r]));
    return batch.map(c => {
      const r = byId.get(c.cardId);
      if (!r || typeof r.name !== 'string' || typeof r.series !== 'string') {
        return { cardId: c.cardId, skipped: true, reason: 'missing/malformed in Gemini response' };
      }
      return { cardId: c.cardId, name: r.name.trim(), series: r.series.trim() };
    });
  } catch (err) {
    const status = err.status;
    if (status === 429 && attempt < 4) {
      const hinted = parseRetryHintMs(err.message);
      const wait = Math.max(hinted ? hinted + 1500 : throttle.delay, throttle.delay);
      bumpThrottle(throttle, wait);
      console.warn(`  Rate limited (attempt ${attempt}) — waiting ${Math.round(wait / 1000)}s before retrying this batch (pace for the rest of the run is now ${Math.round(throttle.delay / 1000)}s)...`);
      await sleep(wait);
      return resolveBatch(batch, throttle, attempt + 1);
    }
    if (batch.length === 1) {
      console.error(`  Skipping ${batch[0].cardId} — Gemini call failed: ${err.message}`);
      return [{ cardId: batch[0].cardId, skipped: true, reason: err.message }];
    }
    console.warn(`  Batch of ${batch.length} failed (${err.message}), splitting and retrying...`);
    const mid = Math.ceil(batch.length / 2);
    const [left, right] = [batch.slice(0, mid), batch.slice(mid)];
    await sleep(500);
    const leftResults = await resolveBatch(left, throttle);
    await sleep(500);
    const rightResults = await resolveBatch(right, throttle);
    return [...leftResults, ...rightResults];
  }
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in .env — nothing to do.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB. Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes will be written)'}`);
  console.log(`Model: ${RENAME_MODEL || '(GEMINI_RENAME_MODEL not set — using the same model as the live bot, GEMINI_TEXT_MODEL)'}`);
  console.log(`Batch size: ${BATCH_SIZE} | Starting delay: ${START_DELAY_MS}ms | Max delay: ${MAX_DELAY_MS}ms\n`);

  // ─── Resume support ───────────────────────────────────────────────────
  // Anything already resolved last time (applied/unchanged/proposed) is
  // carried forward as-is and NOT reprocessed — only entries that were
  // 'skipped' get dropped from the carry-over and retried, since almost
  // all skips are quota exhaustion, not a genuine "couldn't tell".
  let audit = [];
  let logPath = `./rename-audit-${Date.now()}.json`;
  let alreadyDone = new Set();

  if (RESUME_PATH) {
    if (!fs.existsSync(RESUME_PATH)) {
      console.error(`❌ --resume file not found: ${RESUME_PATH}`);
      process.exit(1);
    }
    const previous = JSON.parse(fs.readFileSync(RESUME_PATH, 'utf8'));
    audit = previous.filter(e => e.status !== 'skipped');
    alreadyDone = new Set(audit.map(e => e.cardId));
    logPath = RESUME_PATH; // keep appending to the same file
    console.log(`Resuming from ${RESUME_PATH}: ${alreadyDone.size} card(s) already resolved, will be skipped.\n`);
  }

  function flushAudit() {
    fs.writeFileSync(logPath, JSON.stringify(audit, null, 2));
  }

  // Graceful Ctrl-C: audit is already flushed after every batch below, so
  // this is just a clear confirmation of that rather than a rescue.
  process.on('SIGINT', async () => {
    console.log(`\n\n⏸️  Interrupted. Progress through the last completed batch is saved in:\n${logPath}`);
    console.log(`Resume with: node renameCardsWithGemini.js${APPLY ? ' --apply' : ''} --resume=${logPath}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });

  let query = CardCatalogue.find();
  const allCards = await query;
  let cards = allCards.filter(c => !alreadyDone.has(c.cardId));
  if (LIMIT) cards = cards.slice(0, LIMIT);

  if (!cards.length) {
    console.log('Nothing left to process.');
    return mongoose.disconnect();
  }
  console.log(`Processing ${cards.length} card(s) in batches of ${BATCH_SIZE}...\n`);

  const throttle = makeThrottle();
  let changed = 0, unchanged = 0, skipped = 0;

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(cards.length / BATCH_SIZE)}: ${batch.map(c => c.cardId).join(', ')}`);

    const results = await resolveBatch(batch, throttle);
    const byId = new Map(results.map(r => [r.cardId, r]));

    for (const card of batch) {
      const result = byId.get(card.cardId);

      if (!result || result.skipped) {
        skipped++;
        audit.push({ cardId: card.cardId, oldName: card.name, oldSeries: card.series, status: 'skipped', reason: result?.reason || 'no result returned' });
        console.log(`  ⏭️  ${card.name} [${card.cardId}] — skipped (${result?.reason || 'no result'})`);
        continue;
      }

      const nameChanged = result.name && result.name !== card.name;
      const seriesChanged = result.series && result.series !== card.series;

      if (!nameChanged && !seriesChanged) {
        unchanged++;
        audit.push({ cardId: card.cardId, oldName: card.name, oldSeries: card.series, status: 'unchanged' });
        continue;
      }

      changed++;
      audit.push({
        cardId: card.cardId,
        oldName: card.name, oldSeries: card.series,
        newName: result.name, newSeries: result.series,
        status: APPLY ? 'applied' : 'proposed',
      });
      console.log(`  ${APPLY ? '✅' : '📝'} ${card.name} [${card.cardId}]${nameChanged ? ` — name: "${card.name}" -> "${result.name}"` : ''}${seriesChanged ? ` — series: "${card.series}" -> "${result.series}"` : ''}`);

      if (APPLY) {
        card.name = result.name;
        card.series = result.series;
        card.renderedUrl = null;
        card.renderVersion = null;
        card.renderedAt = null;
        await card.save();
      }
    }

    // Written after EVERY batch now, not just at the end — see the Aug
    // 2026 bugfix note at the top of this file for why that matters.
    flushAudit();

    if (i + BATCH_SIZE < cards.length) await sleep(throttle.delay);
  }

  console.log(`\n─── Done ───`);
  console.log(`${APPLY ? 'Applied' : 'Would apply'}: ${changed}`);
  console.log(`Already correct: ${unchanged}`);
  console.log(`Skipped (left untouched): ${skipped}`);
  console.log(`Full audit log written to: ${logPath}`);
  if (skipped > 0) {
    console.log(`To retry just the skipped ones: node renameCardsWithGemini.js${APPLY ? ' --apply' : ''} --resume=${logPath}`);
  }
  if (!APPLY) console.log(`\nThis was a DRY RUN — nothing was written. Review ${logPath}, then re-run with --apply to commit these changes.`);

  await mongoose.disconnect();
})().catch(async err => {
  console.error('Fatal error:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
