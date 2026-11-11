# TypeScript migration (baileys-migration branch)

The bot is being converted from JavaScript to TypeScript **incrementally**,
without ever breaking the running bot.

## How it works right now

- `tsconfig.json` has `allowJs: true` / `checkJs: false`, so every remaining
  `.js` file keeps compiling and running untouched. JavaScript stays wherever
  it is still needed (the `.cjs` migration scripts at the repo root are
  CommonJS by design and stay `.cjs`).
- Entry point is now `index.ts`, run with **tsx** (`npm start` / `npm run dev`
  for hot reload). PM2 runs it via `./node_modules/.bin/tsx index.ts`
  (see `ecosystem.config.cjs`).
- Production build: `npm run build` → `tsc` emits `dist/` (both the converted
  `.ts` and the not-yet-converted `.js`), then `npm run start:prod`.
- Import specifiers keep their `.js` extension (e.g. `./serializers.js`):
  tsx and `tsc` with `moduleResolution: NodeNext` both resolve them to the
  corresponding `.ts` file, and the compiled output keeps working under plain
  `node dist/`.

## Already converted

- `index.ts` — entry point
- `src/api/serializers.ts` — with exported response interfaces (`PublicUser`,
  `PublicCard`, `PublicGuild`, `PublicAuction`, ...)
- `src/api/routes.ts`, `src/api/server.ts`, `src/api/boot.ts` — typed with
  `@types/express`
- `src/models/BotState.ts` — fully typed Mongoose model (`BotStateDoc`)
- `tests/api-serializers.test.ts`

## Converting the rest (module by module)

Order suggestion: `src/models/*` (small, self-contained) → `src/utils/*` →
`src/whatsapp/*` → `src/services/*` → `src/commands/*` (largest, last).

Per file:

1. `git mv src/foo.js src/foo.ts` (imports elsewhere keep working unchanged)
2. Add types: Mongoose `Document`/`Model` interfaces for models, explicit
   param/return types elsewhere. Run `npm run typecheck` — with `strict` still
   off this only checks the `.ts` files, so it is a safe progress tracker.
3. When you want stricter checking, flip `strict: true` (and `checkJs: true`)
   in `tsconfig.json` only after the bulk of files are converted.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | tsx watch — hot reload while coding |
| `npm start` | run with tsx |
| `npm run build` | compile everything to `dist/` |
| `npm run start:prod` | run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` — type-checks the converted files |
| `npm test` | vitest suite |
