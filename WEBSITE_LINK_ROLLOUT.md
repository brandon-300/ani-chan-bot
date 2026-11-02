# AniChan — website-only registration, login and WhatsApp linking

## User-approved experience

- First contact in a private DM, bot-directed group message, group command, or @mention checks registration.
- New users receive: "Send .reg privately to AniChan to register or log in on the website."
- **.reg is the ONLY WhatsApp registration command**. Sending it in the bot's DM issues a private one-use website URL. It does not ask for or accept a code.
- The user follows the private link, registers or logs in, verifies email on the website, and the browser links their WhatsApp identity automatically.
- The user returns to WhatsApp and sends a normal message; the bot recognizes the linked website identity and creates/activates the original gameplay account where appropriate.
- For users with a pre-existing WhatsApp gameplay account, the same MongoDB ID is retained; coins, bank, cards, guilds, loans, achievements, and session history are not overwritten.
- If an older already-registered user links their account, the bot syncs their website profile on the next interaction without requiring another command.
- Website-linked sessions locked due to inactivity are unlocked by signing in to the website again. No WhatsApp OTP for these sessions.
- No new WhatsApp commands and no ".reg 12345678" or similar code-based chat steps.

## Security architecture

- Cloudflare Pages staging: `https://anichan-api-stage.pages.dev`, from `feature/typescript-express-mongodb`.
- wweb.js bot branch: `feature/website-link-main`.
- The bot verifies the WhatsApp sender's canonical ID using `msg.getContact()` in a private DM and rejects unresolved LIDs.
- The bot calls `POST /api/internal/handoff` with `BOT_LINK_SECRET` authentication. Server issues a cryptographically random 256-bit, single-use, 15-minute token.
- Bot sends website URL `/register#wa=<random-ticket>` privately to that same WhatsApp contact. URL fragments are not transmitted in HTTP requests or ordinary referrers. Do not share the private link.
- The browser immediately captures and removes the token from the URL bar, keeping it only in sessionStorage until completion.
- Browser signup/login uses HttpOnly, Secure, SameSite=Lax sessions. Email verification and recovery are completed on the website with the original branded Gmail SMTP template.
- With a verified website session and the private ticket, `POST /api/link/complete` atomically consumes the token and attaches the WhatsApp identity to exactly one website account.
- MongoDB has a unique index on linked WhatsApp identities and a TTL index on short-lived handoffs.
- The bot's protected `GET /api/internal/profile?waid=...` lets the normal registration gate safely restore linked identity and the website profile when the user next interacts.
- The API never directly changes bot game collections. Bot updates use a conditional filter and only mutate website identity and basic profile fields.
- A website login timestamp can unlock a locked *linked* bot account when it is strictly newer than the bot's lock time. Legacy OTP handling remains temporarily for unlinked legacy bot accounts to prevent lockout.

## Release status

Automated CI verifies API TypeScript compilation, browser script syntax, one-use ticket behavior, logged-in website-only completion, email verification requirement, replay/conflict protection, and bot registration gate without chat codes.

**Not yet completed:** Real WhatsApp/website end-to-end pilot, live Gmail inbox receipt verification, and owner-controlled staging shared-secret configuration. `anichan-api-stage` still requires its own `BOT_LINK_SECRET` plus `WHATSAPP_LINK_ENABLED=true`; the staged bot must have the same secret and `ANICHAN_REG_LINK_ENABLED=true` with `ANICHAN_SITE_URL=https://anichan-api-stage.pages.dev`. Never enable these before running a backed-up and authorized pilot.

Production `main`, `baileys-migration`, live `website-cloudflare`, and website `https://anichan.pages.dev` are not changed. Old chat-code documentation is obsolete and must not be restored.
