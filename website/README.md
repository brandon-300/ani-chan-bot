# AniChan Website — Cloudflare Workers + D1

Independent, original AniChan website inspired by the general layout and functionality of Tensura's public community website (not a source-code copy).

## Deployment (2026-10-31)
- Worker: `anichan-website`
- Public URL: `https://anichan-website.g09649009.workers.dev`
- Dedicated D1 database: `anichan-website-auth`
- Worker binding: `DB`
- Source: `website/worker.js`; editable HTML source: `website/index.html`
- GitHub branch: `website-cloudflare` (original bot branches unchanged).
- Cloudflare worker currently embeds the HTML as `HTML_PAGE`. To update the design, edit `index.html`, then update the embedded HTML in `worker.js` before redeploying.

## Available now
- Responsive home, searchable 349-card catalogue snapshot copied read-only from the **AniChan** MongoDB collection, Shop/Guilds/Events informational pages.
- Website account registration and login (email + 10+ character password), random per-account salt + PBKDF2-SHA256 password hash, HttpOnly Secure SameSite session cookie, per-IP write rate limits, CSRF origin checks, database prepared statements.
- Profile edits: display name, date of birth (18+), short bio, picture upload (client-side converted to 160×160 WebP, stored in D1).
- Logout; 14-day session expiry.

## Intentionally not enabled
- WhatsApp account linking and synchronization are not active yet. A secret-gated API exists: POST /api/link/start issues a hashed 8-digit expiring code, POST /api/internal/claim-link is for the bot to claim it, and GET /api/internal/profile lets the authenticated bot read the linked site profile. These return unavailable until BOT_LINK_SECRET is configured on the Worker and the bot is updated with the same secret. The current public dashboard keeps linking disabled.
- Database mirroring from D1 to MongoDB `users`, including existing user balances, cards and guilds.
- Real purchases, auctions, guild management, events, and Discord bot.
- Password reset / email ownership verification. Do not treat email as verified or use it to recover ownership yet.
- Actual card art preview (current catalogue artwork is pending design overhaul).
- Any Pokémon or Perplexity features.

### Do not disable WhatsApp registration commands yet
Website-only accounts are *not* bot accounts. To avoid locking users out, move registration gating only after WhatsApp linking, legacy-user migration, and account synchronization are implemented and tested. This protects the 3 existing AniChan users and all inventories and currencies.

## Source of truth
- AniChan gameplay and card ownership: existing **MongoDB Atlas** `anichan`.
- Website-only accounts and sessions: dedicated Cloudflare D1, not the Anivora database.
- Catalogue browser: snapshot imported from MongoDB on October 31, 2026. It must be refreshed after card changes; never treat it as live game state.
- Cloudinary: retained for the future avatar and card-image pipeline.

## Safety / operational notes
- Site login uses unverified email addresses. Add email verification and secure password recovery before broad public promotion.
- Limit account creation while onboarding is being integrated. Rate limits are basic IP controls, not full bot protection.
- Avatar data is resized on the client. A future release should validate image contents server-side and store final assets in Cloudinary rather than D1.
- Passwords are hashed with PBKDF2-SHA256; data deletion, privacy notice, account recovery and breach-prevention tests are required before broad launch.
- Do not disclose any bot authorization secret in GitHub or client JavaScript.

## Activation checklist (not yet complete)
1. Add `.link <code>` as a **DM-only** command and `.website` as an onboarding command in both bot branches, with the command allowed before registration. Never trust a WhatsApp number entered into a web form; read the actual message sender from the WhatsApp adapter.
2. Store identical high-entropy `BOT_LINK_SECRET` (Cloudflare secret) and `ANICHAN_SITE_BOT_SECRET` (bot .env). Do not add these to GitHub.
3. Build a safe MongoDB user merge: site account ID mapped to the verified sender ID, preserve all existing coins/bank/cards/guilds, update only profile fields. Handle Baileys PN/LID normalization and idempotent retries.
4. Upload final profile pictures to Cloudinary and update MongoDB's `profile.picUrl` and `profile.picPublicId`; do not store data URIs in MongoDB gameplay records.
5. Add site-exclusive registration gate **behind a feature flag**, test with existing and new users, verify rollback, THEN remove bot commands for name/bio/age/DOB/picture and turn on website-only onboarding.
6. Security review: account recovery, email verification, rate limiting, bot API secret rotation, login load testing, Privacy Policy and Terms.

## Pages deployment
- Primary site: https://anichan.pages.dev (Cloudflare Pages project `anichan`, Git branch `website-cloudflare`, root directory `website`).
- Advanced mode: `website/_worker.js` mirrors `website/worker.js`; keep both synchronized until build process consolidates them.
- Legacy Workers preview: https://anichan-website.g09649009.workers.dev (not the primary site).

## Secrets configuration (production)
- Required Pages secret: `BOT_LINK_SECRET` (encrypted; secret value never stored in Git).
- Matching Termux bot `.env` secret: `ANICHAN_SITE_BOT_SECRET`.
- Add or update the Pages secret in the `anichan` project's Production environment, then trigger a new production deployment so Pages Functions receive it.
- Bot activation requires a corresponding tested `.website`, `.link`, `.syncprofile` command implementation. Keep existing registration commands operational until verified account migration passes.

## Safe public-linking rollout flag
- Encrypted `BOT_LINK_SECRET` authenticates the WhatsApp bot to Pages.
- Public link-code generation deliberately remains disabled until the existing wweb.js or Baileys bot is running tested `.link` and `.syncprofile` handlers. Only then set Pages Production variable `WHATSAPP_LINK_ENABLED=true` (plain text is sufficient for this non-secret flag) and redeploy.
- `/api/health` exposes only a boolean for linking readiness, never secret contents.
