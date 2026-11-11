# TypeScript migration (baileys-migration branch)

The bot's entire `src/` tree is now TypeScript. JavaScript remains only where
it is genuinely required: the `.cjs` helper scripts at the repo root
(PM2 config, migration/seed scripts) are CommonJS by design and stay `.cjs`,
and the `tests/` suite still contains `.js` integration tests.

## How it works

- `tsconfig.json` uses `module`/`moduleResolution: NodeNext`, `outDir: dist`,
  `allowJs: true`, `checkJs: false`, `strict: false` (strictness can be
  tightened file-by-file from here; run `npm run typecheck` to see progress).
- Import specifiers keep their `.js` extension (e.g. `./serializers.js`):
  tsx and `tsc` with NodeNext both resolve them to the corresponding `.ts`
  file, and the compiled `dist/` output keeps working under plain
  `node dist/`.
- Entry point is `index.ts`, run with **tsx** (`npm start` / `npm run dev`
  for hot reload). PM2 runs it via `./node_modules/.bin/tsx index.ts`
  (see `ecosystem.config.cjs`).
- Production build: `npm run build` → `tsc` emits `dist/`, then
  `npm run start:prod`.
- The command loader in `src/index.ts` accepts **both** `.ts` and `.js`
  files in `src/commands/`, so it works identically from source (tsx) and
  from the compiled `dist/` output.

## Converted

- `index.ts` — entry point (command loader accepts `.ts` + `.js`)
- `src/api/*.ts` — `server`, `routes`, `serializers` (exported response
  interfaces: `PublicUser`, `PublicCard`, `PublicGuild`, `PublicAuction`,
  ...), `boot` — typed with `@types/express`
- `src/models/*.ts` — all 21 models (`BotState.ts` is fully typed with a
  `BotStateDoc` interface; the rest are mechanical `.js` → `.ts` renames
  ready for incremental typing)
- `src/utils/*.ts` — all 31 utility modules
- `src/whatsapp/*.ts` — all 8 adapter modules
- `src/services/*.ts` — akinator services
- `src/commands/*.ts` + `src/commands/games/*.ts` — all 23 command files
  and all 14 game modules
- `src/config/index.ts`
- `tests/api-serializers.test.ts`

## Adding types from here

1. Pick a file, add explicit param/return types and Mongoose
   `Document`/`Model` interfaces where useful.
2. Run `npm run typecheck` — with `strict` off this is a safe progress
   tracker; fix what it reports at your own pace.
3. When most files are typed, flip `strict: true` in `tsconfig.json`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | tsx watch — hot reload while coding |
| `npm start` | run with tsx |
| `npm run build` | compile everything to `dist/` |
| `npm run start:prod` | run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` — type-check progress tracker |
| `npm test` | vitest suite |

## Exposing the REST API to your website (Cloudflare Tunnel)

The bot ships a read-only REST API (mounted at `/api`, see
`src/api/routes.ts`) that your website and — later — your Discord bot can
call. To expose it publicly without opening ports on your phone/VPS, use a
Cloudflare Tunnel pointed at the API port:

```bash
bash scripts/setup-cloudflare-tunnel.sh api.your-domain.com ani-chan-bot
# then, while the bot runs:
cloudflared tunnel run ani-chan-bot
```

See `cloudflared.config.example.yml` for the manual equivalent. The API is
live at `https://api.your-domain.com/api/health`; `/api/admin/*` additionally
requires the `X-API-Key` header matching `API_KEY` in `.env`.
