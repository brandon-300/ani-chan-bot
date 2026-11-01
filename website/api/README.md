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
The staged Express API supports the existing bot's `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` and optional `EMAIL_FROM_NAME` as encrypted Cloudflare Pages production-environment variables; configure a separate cryptographically strong `OTP_SECRET` as an encrypted secret. Recommended Gmail configuration: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and the existing Gmail App Password (not a normal Google login password). The production wweb.js bot already works with these values locally; they are **not** automatically shared with Cloudflare. Never commit SMTP credentials or put them into CI logs. `emailReady` remains false until the required private values are configured. Re-deploy stage before running email verification tests.
