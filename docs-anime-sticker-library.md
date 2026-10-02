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
pm2 restart ani-chan-bot                                    # loads the new library
```

Then, in your private DM with the bot, send `.stickeranalyze new`.

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

## Analysing stickers (manual)

Nothing is analysed at startup, after an update, or on import. Stickers become
usable when you send these to the bot in your private DM (owner only):

```text
.stickeranalyze                 what is analysed, what is missing, what a run costs
.stickeranalyze new             analyse only stickers without a working analysis
.stickeranalyze new marin       the same, for one character
.stickeranalyze redo confirm    redo everything (asks for "confirm" first)
.stickeranalyze stop            cancel what is still waiting
```

One request judges up to `AI_STICKER_FIT_BATCH` (20) stickers for every character
together, from the saved descriptions; a sticker with no description is looked at
once (`AI_STICKER_VISION_BATCH`, 6 per request) and that look is shared by all
characters. 100 stickers is about 5 requests; 1000 is about 50. Editing a
persona file never triggers re-analysis. Gemini commands are unavailable while a
run is in progress; the logs show each step.

## Tests

```bash
node --test tests/ai-features.test.js tests/anime-sticker-library.test.js
```
