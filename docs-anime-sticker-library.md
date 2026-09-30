# Anime-aware sticker library

One physical WebP per SHA-256 hash lives in Cloudinary (`ai-stickers/shared`).
MongoDB (`AiSticker`) stores, per sticker: anime, characters, source pack,
generic (persona-independent) analysis, and one independent analysis per persona.
Every persona can use every sticker; the persona-fit and reaction gates in
`utils/aiStickers.js` decide whether a sticker is sent. No good match = no sticker.

## Folder (Termux)

```text
~/whatsapp-bot/ani-chan-bot/imports/anime-stickers/
  Naruto.wastickers
  OnePiece.wastickers
  manifest.json            # optional, copy from manifest.example.json
```

`pkg install unzip` is required (the importer uses the `unzip` binary).
Use sticker packs you have the right to redistribute through a bot.

## 1. Reset the old library (once)

```bash
node scripts/reset-ai-sticker-library.js                    # dry run: counts only
pm2 stop ani-chan-bot
node scripts/reset-ai-sticker-library.js --delete --yes     # backup, then delete
```

Order: JSON backup in `backups/` -> delete Cloudinary assets -> verify they are
gone -> delete Mongo records -> verify zero. If Cloudinary fails, Mongo is left
untouched, so simply re-run. Only `ai-stickers/` IDs can ever be deleted.

## 2. Import packs

```bash
node scripts/import-anime-sticker-packs.js --dry-run        # extract + validate only
node scripts/import-anime-sticker-packs.js                  # real import
pm2 restart ani-chan-bot                                    # loads library, queues persona analysis
```

Per pack: extract -> keep valid `.webp` only -> SHA-256 dedupe -> skip hashes
already in the library -> screen up to 40 candidates with Gemini (one at a time,
retried, cached in `imports/anime-stickers/.screening-cache.json`) -> keep the 10
most varied reactions -> upload once -> insert one shared record.

- Re-runnable: existing hashes are skipped; an anime already at 10 is left alone.
- If Gemini is unavailable the pack fails cleanly (nothing imported, file kept).
- Finished packs move to `imports/anime-stickers/processed/<timestamp>/`
  (use `--keep` to leave them in place).
- Options: `--target=N`, `--max-candidates=N`, `--delay-ms=N`, `--no-screen`,
  `--dir=DIR`, `--manifest=FILE`.

Persona analysis is NOT done by the importer. On restart the bot's existing queue
analyses each sticker for each persona, `AI_STICKER_ANALYSIS_DELAY_MS` apart
(10 anime x 10 stickers x 3 personas = about 300 requests).

## Tests

```bash
node --test tests/ai-features.test.js tests/anime-sticker-library.test.js
```
