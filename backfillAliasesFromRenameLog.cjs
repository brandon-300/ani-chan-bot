// ─── Backfill aliases onto already-renamed cards ───────────────────────────
//
// WHY THIS EXISTS: .ci's name search now checks `aliases` alongside `name`
// specifically so an old, pre-rename name (e.g. "Kirito") still finds a
// card whose `name` was corrected to something that no longer contains it
// as a substring (e.g. "Kazuto Kirigaya"). But `aliases` only gets
// populated going forward — it's not retroactive. The 72 cards already
// renamed via renameCardsWithGemini.js --apply before this field existed
// have an empty `aliases` array, so searching their old familiar names
// currently finds nothing. This reads that same rename audit log and adds
// each card's old name to its `aliases` array.
//
// USAGE:
//   node backfillAliasesFromRenameLog.js <path-to-rename-audit.json>
//                                          dry run — prints what WOULD be
//                                          added, writes nothing
//   node backfillAliasesFromRenameLog.js <path> --apply
//                                          actually writes the aliases
//
// Safe to run more than once — only adds an alias if it isn't already
// present on that card, so re-running against the same (or an overlapping)
// log never creates duplicates.

const mongoose = require('mongoose');
require('dotenv').config();
const fs = require('fs');

const { CardCatalogue } = require('./models/Card');

const args = process.argv.slice(2);
const logPath = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');

(async () => {
  if (!logPath) {
    console.error('❌ Usage: node backfillAliasesFromRenameLog.js <path-to-rename-audit.json> [--apply]');
    process.exit(1);
  }
  if (!fs.existsSync(logPath)) {
    console.error(`❌ File not found: ${logPath}`);
    process.exit(1);
  }

  const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const renamed = entries.filter(e => e.status === 'applied' && e.oldName && e.newName && e.oldName !== e.newName);

  if (!renamed.length) {
    console.log('No renamed entries with a real name change found in that log — nothing to backfill.');
    return;
  }

  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes will be written)'}`);
  console.log(`Found ${renamed.length} renamed card(s) in the log.\n`);

  await mongoose.connect(process.env.MONGO_URI);

  let added = 0, alreadyPresent = 0, notFound = 0;

  for (const entry of renamed) {
    const doc = await CardCatalogue.findOne({ cardId: entry.cardId });
    if (!doc) {
      console.log(`  ⚠️  ${entry.cardId} — no longer in catalogue, skipping`);
      notFound++;
      continue;
    }

    if (doc.aliases.includes(entry.oldName)) {
      alreadyPresent++;
      continue;
    }

    console.log(`  ${APPLY ? '✅' : '📝'} ${doc.name} [${entry.cardId}] — add alias "${entry.oldName}"`);
    added++;

    if (APPLY) {
      doc.aliases.push(entry.oldName);
      await doc.save();
    }
  }

  console.log(`\n─── Done ───`);
  console.log(`${APPLY ? 'Added' : 'Would add'}: ${added}`);
  console.log(`Already present: ${alreadyPresent}`);
  console.log(`Not found in catalogue: ${notFound}`);
  if (!APPLY) console.log(`\nThis was a DRY RUN. Re-run with --apply to actually write these aliases.`);

  await mongoose.disconnect();
})().catch(async err => {
  console.error('Fatal error:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
