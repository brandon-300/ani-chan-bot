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
// audit log after every batch, but touches nothing in MongoDB unless you
// pass --apply. Only touches CardCatalogue.name/series (+ resets the
// render cache on anything that changes, same as .editcard) — never tier,
// description, imageUrl, or OwnedCard, matching how .editcard already
// behaves.
//
// USAGE:
//   node renameCardsWithGemini.js                        dry run, all cards
//   node renameCardsWithGemini.js --limit=10              dry run, first 10 only (test this first!)
//   node renameCardsWithGemini.js --apply                 actually writes changes (asks Gemini fresh)
//   node renameCardsWithGemini.js --resume=<path-to-a-previous-audit-log.json>
//
// WHAT --resume DOES (BUGFIX, Aug 2026 — this is the second version of
// this behavior, see below for what was wrong with the first):
//   Every card in the resume log that was already fully decided last time
//   ('applied' or 'unchanged') is carried forward as-is and NEVER asked
//   about again — no wasted Gemini call.
//   Cards marked 'proposed' (a DRY RUN decided a rename but nothing was
//   written yet) are handled based on THIS run's mode:
//     - dry run + --resume  -> still just carried forward as 'proposed',
//       nothing written, exactly like before.
//     - --apply + --resume  -> the already-decided name/series is now
//       WRITTEN to MongoDB directly, with NO new Gemini call — you're
//       replaying a decision you already reviewed, not re-asking.
//   Only cards marked 'skipped' (almost always a quota failure, not a
//   real "couldn't tell") are actually sent to Gemini again.
//
//   THE BUG THIS FIXES: the first version of --apply --resume treated
//   'proposed' entries as "already resolved, nothing to do" and filtered
//   them out entirely — so running `--apply --resume=<dry-run-log>` after
//   a clean dry run printed "Nothing left to process" and silently wrote
//   NOTHING to the database, even though every change had already been
//   manually verified and was sitting right there in the log. If you hit
//   exactly that ("Nothing left to process" right after --apply --resume
//   on a dry-run log with proposed changes in it), that older version is
//   why — this version actually applies them.
//
// MODEL CHOICE: reads a separate GEMINI_RENAME_MODEL env var so this bulk
// job can use a different (typically higher-free-quota) model than
// whatever the live bot's GEMINI_TEXT_MODEL is set to, without touching
// that. Falls back to TEXT_MODEL if unset. Run probe-gemini-models.sh
// (already in this project) to see which models your actual key can use —
// don't guess a model name, Google's available-model list for a given key
// changes over time.
//
// Other optional env overrides (.env):
//   GEMINI_RENAME_BATCH_SIZE   cards per Gemini call (default 15)
//   GEMINI_RENAME_DELAY_MS     starting pause between calls (default 8000)
//   GEMINI_RENAME_MAX_DELAY_MS ceiling the adaptive backoff won't exceed
//                              (default 90000)

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
const RENAME_MODEL = process.env.GEMINI_RENAME_MODEL || undefined;
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

function parseRetryHintMs(message) {
  const match = /retry in ([\d.]+)\s*s/i.exec(message || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

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

// Writes an already-decided rename straight to MongoDB — no Gemini call.
// Used both by the normal per-batch loop (fresh decisions) and by the
// --resume + --apply path (replaying decisions from an earlier dry run).
async function applyToDoc(doc, name, series) {
  doc.name = name;
  doc.series = series;
  doc.renderedUrl = null;
  doc.renderVersion = null;
  doc.renderedAt = null;
  await doc.save();
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

  const allCards = await CardCatalogue.find();
  const cardById = new Map(allCards.map(c => [c.cardId, c]));

  let audit = [];
  let logPath = `./rename-audit-${Date.now()}.json`;
  const alreadyDone = new Set();
  let changed = 0, unchanged = 0, skipped = 0;

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

    let materialized = 0;
    for (const entry of previous) {
      if (entry.status === 'applied') {
        audit.push(entry);
        alreadyDone.add(entry.cardId);
        changed++;
      } else if (entry.status === 'unchanged') {
        audit.push(entry);
        alreadyDone.add(entry.cardId);
        unchanged++;
      } else if (entry.status === 'proposed') {
        alreadyDone.add(entry.cardId); // never re-ask Gemini for this one
        if (APPLY) {
          const doc = cardById.get(entry.cardId);
          if (!doc) {
            console.warn(`  ⚠️  ${entry.cardId} no longer exists in the catalogue — skipping`);
            audit.push({ ...entry, status: 'skipped', reason: 'card no longer exists in CardCatalogue' });
            skipped++;
            continue;
          }
          await applyToDoc(doc, entry.newName, entry.newSeries);
          audit.push({ ...entry, status: 'applied' });
          changed++;
          materialized++;
          console.log(`  ✅ ${entry.oldName} [${entry.cardId}] — name: "${entry.oldName}" -> "${entry.newName}", series: "${entry.oldSeries}" -> "${entry.newSeries}"`);
        } else {
          audit.push(entry); // still just proposed, dry run — nothing to write
        }
      }
      // 'skipped' entries are deliberately left OUT of audit/alreadyDone
      // here — they fall through and get retried via the normal pipeline.
    }

    flushAudit();
    console.log(`Resuming from ${RESUME_PATH}: ${alreadyDone.size} card(s) already decided.`);
    if (APPLY && materialized > 0) console.log(`Wrote ${materialized} previously-proposed change(s) to MongoDB from the resume log.`);
    console.log('');
  }

  let cards = allCards.filter(c => !alreadyDone.has(c.cardId));
  if (LIMIT) cards = cards.slice(0, LIMIT);

  if (cards.length) {
    console.log(`Processing ${cards.length} card(s) needing a fresh Gemini decision, in batches of ${BATCH_SIZE}...\n`);
    const throttle = makeThrottle();

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

        if (APPLY) await applyToDoc(card, result.name, result.series);
      }

      flushAudit();
      if (i + BATCH_SIZE < cards.length) await sleep(throttle.delay);
    }
  } else {
    console.log('No cards need a fresh Gemini decision (everything was already resolved via --resume, or nothing is left to process).\n');
  }

  console.log(`─── Done ───`);
  console.log(`${APPLY ? 'Applied' : 'Would apply'}: ${changed}`);
  console.log(`Already correct: ${unchanged}`);
  console.log(`Skipped (left untouched): ${skipped}`);
  console.log(`Full audit log written to: ${logPath}`);
  if (skipped > 0) {
    console.log(`To retry just the skipped ones: node renameCardsWithGemini.js${APPLY ? ' --apply' : ''} --resume=${logPath}`);
  }
  if (!APPLY) console.log(`\nThis was a DRY RUN. Review ${logPath}, then re-run with --apply --resume=${logPath} to write these exact decisions (no new Gemini calls).`);

  await mongoose.disconnect();
})().catch(async err => {
  console.error('Fatal error:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
