# AniChan website: staged TypeScript / Express.js / MongoDB rollout

Status: **STAGING ONLY — no production data or login path has been switched.**

## Technology and deployment
- Primary production frontend stays `https://anichan.pages.dev`, Git branch `website-cloudflare`.
- New isolated staging site: `https://anichan-api-staging.pages.dev`, Git branch `feature/typescript-express-mongodb`, root `website`, build `npm run build`.
- `src/edge.ts`: TypeScript, Express 5 HTTP server on Cloudflare `httpServerHandler`, MongoDB native Node driver 6, Pages advanced-mode Worker entrypoint.
- `scripts/build.mjs`: esbuild creates `dist/_worker.js` and retains `dist/index.html`.
- The staging Worker exposes **only** `/api/v2/*` read-only endpoints. All other routes return 404; it does not expose the production D1 signup/login API. Production login/session behavior remains D1 until a separately audited cutover.
- New versioned read-only endpoints:
  - GET `/api/v2/health`: API health, whether Mongo URI secret is configured (never reveals it).
  - GET `/api/v2/catalogue?page=1&q=&tier=`: live AniChan MongoDB catalogue data, limited to 20 cards per page and 50 pages, with whitelist projection. Returns 503 if Mongo backend not configured.
- No credentials, usernames, passwords, sessions, cards or balances are copied or modified by these endpoints.
- Dedicated Atlas user `anichan_cf_stage_ro` is scoped to read-only access to the `anichan` database; its generated password is saved as an encrypted `MONGODB_URI` Pages staging secret and was never checked into Git.
- No new WhatsApp commands; `.reg` remains the only onboarding entrypoint in wweb.js development branch.

## Configuration and rollback
- Set `MONGODB_URI` as an encrypted secret in **staging Pages** only after creating a separate, limited-permission Atlas user. Never commit the connection string.
- Database `anichan`. Read-only catalogue requires `read` on that DB; do **not** give the staging worker write access to gameplay collections.
- Connection overhead: direct MongoDB connection per read request; plan a Durable Object connection pool if usage warrants it.
- Because the current website has no registered D1 accounts as of 2026-10-31, there is no user migration to run *yet*. Always re-check the count immediately before a later cutover.
- Never update `website-cloudflare` or production `main` until staging API route tests and account verification/recovery design pass.
- To roll back staging, revert this feature branch; production is a distinct Cloudflare Pages project and stays unaffected.

## QA gates
- [x] Initial staging deployment completed; TypeScript build and typecheck enabled. Latest release verification still required.
- [ ] Live /api/v2/health on staging returns expected JSON.
- [ ] Read-only MongoDB credentials installed and live /api/v2/catalogue returns the correct catalogue.
- [ ] API query validation and error paths tested.
- [ ] Auth/migration architecture reviewed: D1 accounts versus MongoDB canonical identity; password-hash migration; email verification and recovery.
- [ ] Existing WhatsApp account claim via the **existing .reg** workflow approved and tested, including preserving all balances and items.
- [ ] Deploy a new version of the website API only after all gates pass.
