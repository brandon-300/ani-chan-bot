# AniChan API: TypeScript + Express.js + MongoDB Atlas

## Status: staging only

This is a *new* typed API foundation. It does **not** replace the deployed
`anichan.pages.dev` website or the existing whatsapp-web.js bot. Those
remain unchanged while the integration is developed and validated.

No new WhatsApp commands are introduced. `.reg` remains the sole
onboarding entry point in the separate `feature/website-link-main` branch.

## Files

- `src/index.ts`: Express 5 HTTP API on Cloudflare Workers, using Cloudflare's
  documented `httpServerHandler` interface.
- `wrangler.jsonc`: Cloudflare Worker configuration.
- `package.json`, `tsconfig.json`: TypeScript development environment.

## Development and deployment

Install Node.js >=22, then run in this folder:

```sh
npm install
npm run check
npm run dev
```

When ready, configure an encrypted `MONGODB_URI` secret in **the future
`anichan-api` Worker**. Use a dedicated Atlas database user with least-privilege
read-only permission on the `anichan` database for this stage.

```sh
npx wrangler secret put MONGODB_URI
npm run deploy
```

Do not put `MONGODB_URI` in GitHub, a plaintext Wrangler variable, or a user
message. Do not copy the website's `BOT_LINK_SECRET` for MongoDB connectivity.

### Routes available in this stage

- `GET /api/health`: non-sensitive health information; reports whether a
  MongoDB URI is configured, not the URI itself.
- `GET /api/cards?q=&tier=&page=`: live **read-only** catalogue from MongoDB
  with safe input constraints and a 20-card page limit.

## Why no signup route yet?

The existing site already has a D1 registration/session backend, and there are
existing WhatsApp accounts in MongoDB. Cutting authentication over to a new
backend without a complete one-to-one mapping, existing-session strategy,
email verification, and a safe password migration could lock users out or
create duplicate accounts. Production will not be switched until these flows
are implemented and tested. A separate MongoDB website-account collection
will be introduced for authenticated web identities; live gameplay users
will retain their existing `id`, balances, inventory and card ownership.

## Cloudflare compatibility

Cloudflare's official Express tutorial uses `httpServerHandler` and the
`nodejs_compat` flag. Its MongoDB documentation describes direct connections
from Workers and recommends Durable Objects for connection reuse. This
staged API intentionally uses a short-lived connection only for low traffic.

Docs:
- https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/
- https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/
## Staging CI/deployment
- GitHub Actions TypeScript check: successful after including Wrangler-generated declaration file.
- Cloudflare Pages isolated staging project: `anichan-api-stage.pages.dev`. Deployment and MongoDB connectivity must be validated separately from production.
- `MONGODB_URI` must be installed as an encrypted **staging-only** secret; credentials must never be committed.

## Pages packaging
`pages-bundle.mjs` copies Wrangler's dry-run Worker bundle to `dist/_worker.js` and prefixes Node built-in import specifiers for Pages advanced-mode bundling. This is staging-only; no production cutover.

### Gmail SMTP (no Resend required)
The staged Express API supports the existing bot's `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `EMAIL_FROM` (defaults to `SMTP_USER`), and optional `EMAIL_FROM_NAME` as encrypted Cloudflare Pages production-environment variables; configure a separate cryptographically strong `OTP_SECRET` as an encrypted secret. Recommended Gmail configuration: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and the existing Gmail App Password (not a normal Google login password). The production wweb.js bot already works with these values locally; they are **not** automatically shared with Cloudflare. Never commit SMTP credentials or put them into CI logs. `emailReady` remains false until the required private values are configured. Re-deploy stage before running email verification tests.

## Verified staging integration (2026-11-01)
- Cloudflare Pages project `anichan-api-stage`: production deployment runs from `feature/typescript-express-mongodb`; existing live website `anichan.pages.dev` unchanged.
- Encrypted `MONGODB_URI` works against Atlas; read-only query returned 349 catalogue entries.
- Encrypted Gmail SMTP settings and OTP secret are present: `/api/health` reports `emailReady:true`. **An actual delivery to a user-owned inbox has NOT been tested**; do not assume SMTP send success merely from readiness.
- Full disposable e2e passed on deployed staging: register `@example.invalid` account, authenticated session lookup, profile update, logout revocation, subsequent login. Deleted its account and session afterward; 0 accounts and sessions left. No verification email was sent during this test.
- Original HTML verification email with CID-linked banner and optional avatar matches the existing wweb.js template in automated regression tests; no changes to production email sending.
- The Cloudflare runtime rejects single PBKDF2 calls above 100,000 iterations. **New staged accounts use the explicitly versioned `pbkdf2-sha256-chain6x100k-v1` composed KDF**, six sequential domain-separated PBKDF2-HMAC-SHA256 derivations, each at 100,000 iterations (600,000 total). This is NOT byte-for-byte equivalent to a single PBKDF2-150k or PBKDF2-600k call. Login rejects hashes with unknown schemes; migration of old D1 password hashes must be handled separately, preserving access via an approved recovery path.
- Temporary debugging endpoints, headers, and disposable automated-account-test workflow were removed after test success; do not publish diagnostic routes to production.
- `WHATSAPP_LINK_ENABLED` remains disabled, and the staging project does not yet have its own `BOT_LINK_SECRET`. Do not enable WhatsApp registration-only gating in the bot until the complete `.reg` code proof, collision handling, email verification and profile sync are tested with an authorized real sender.

## Website-only WhatsApp account linking (staging)

The user sends only `.reg` in the bot's private DM. The bot requests
`POST /api/internal/handoff` with a shared Bearer secret and the
canonically verified WhatsApp sender identity. The API creates a 256-bit random
15-minute single-use ticket, storing only its SHA-256 hash in an indexed TTL
MongoDB collection. The bot sends a private URL:

`https://anichan-api-stage.pages.dev/register#wa=<private-ticket>`

The website immediately captures the fragment into sessionStorage and
removes it from browser history. Once website registration/login and email
verification are complete, the browser posts `{ticket}` to
`POST /api/link/complete`, which checks the verified website session and
atomically consumes the ticket to link exactly one WhatsApp ID to one website
account. No WhatsApp-entered code is used or requested.

Returning to the bot, the existing registration gate calls authenticated
`GET /api/internal/profile?waid=...`, restores the linked website profile, and
opens regular commands/AI chatting. Existing game accounts are preserved.
Website-linked legacy session locks are unlocked by a newer successful web
login, never a chat-side OTP.

**Release gate:** Staging does not yet have `BOT_LINK_SECRET` or
`WHATSAPP_LINK_ENABLED=true`. The development bot also remains disabled.
End-to-end testing requires a backed-up wweb.js bot plus secure matching
secrets in both services. Do not deploy the changes to production until a
real-owner pilot confirms Gmail email receipt and linked identity.
