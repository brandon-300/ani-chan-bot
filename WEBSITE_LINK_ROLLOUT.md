# AniChan — approved website registration and tech-stack direction (2026-10-31)

## Governance: commands require user approval
No new WhatsApp commands are to be created, added to help menus, or merged without the owner's explicit approval.
Unapproved experimental `.website`, `.link` and `.syncprofile` handlers were removed from the active **wweb.js** development branch.
The existing `.reg` command is the only approved onboarding entry point.

## Approved .reg behavior (wweb.js development branch)
- When a new WhatsApp user talks to the bot, registration gate prompts them to send **.reg** privately.
- On `.reg` in a DM, the bot provides the existing website registration and login links:
  - https://anichan.pages.dev/register
  - https://anichan.pages.dev/login
- `.reg` does not create a duplicate MongoDB user and does not require a pre-existing password.
- Existing registered WhatsApp users continue to use their current account, cards, balances, and guilds; nobody loses progress.
- Profile-editing commands such as `.setname`, `.setdob`, `.bio`, and `.setpic` remain temporarily usable while the website linking and migration are still incomplete. They should be retired only after account verification, migration, and testing succeed.
- The existing `.reg` command now has a **feature-gated code argument**, `.reg 12345678`, for claiming a verified website login with the real WhatsApp sender. This is an extension of `.reg`, NOT a new command. With no argument, `.reg` shows the signup and login links and, once enabled, attempts safe profile recovery for already-linked website accounts.

## Stack
- Desired codebase: TypeScript, MongoDB Atlas, Express.js, whatsapp-web.js (first; Baileys later).
- Cloudflare Pages remains the frontend at https://anichan.pages.dev.
- Cloudflare Workers can host a TypeScript Express API using `httpServerHandler`; Cloudflare documents Express-on-Workers as supported. Preserve Pages as the site's frontend hostname.
- MongoDB Atlas (`anichan`) should be canonical for gameplay and linked-account identity. The website's existing D1 account and sessions must be safely migrated or integrated without losing any website-created login accounts. Do not drop D1 or automatically migrate before account/secret tests.
- The existing WhatsApp bot is JavaScript: gradually introduce TypeScript and types instead of an unsafe automated rewrite. Keep the wweb.js runtime intact until integration tests pass.

## Current safety state
- Production `main`, `baileys-migration`, and dated backup branches remain unchanged.
- wweb.js development work stays in `feature/website-link-main`. The new secure claim helper is `utils/websiteRegistration.js`; the existing `commands/economy.js` `.reg` handler calls it only after an explicit eight-digit code.
- The old unapproved command file was deleted from the active wweb.js development branch; the separate Baileys experimental branch is parked and must not be merged.
- Pages has an encrypted `BOT_LINK_SECRET` and the owner independently confirmed a 200 response to the protected API from Termux; the full WhatsApp account linking flow is not yet activated.
- Keep Pages public `WHATSAPP_LINK_ENABLED` false until `.reg CODE` has been tested from the real wweb.js bot. Keep bot `ANICHAN_REG_LINK_ENABLED` false until then. These flags are intentionally independent for safe staged activation.
- No direct MongoDB cleanup, asset deletion, or production cutover was authorized.

## Acceptance gates
1. Confirm TypeScript + Express build/deployment workflow and MongoDB connection without moving or deleting user data.
2. Review the `.reg CODE` account-claiming extension and confirm that it is the intended UX; no new command names have been introduced.
3. Test identity verification, attempts/expiry, old WhatsApp IDs, account recovery, and collision handling.
4. Verify current users keep coins, owned cards, guilds, age, session state, achievements, and loans.
5. Verify accounts created on the website can log in and no duplicate account is created for existing WhatsApp users.
6. Only then remove old WhatsApp profile mutation handlers, update the menu, and enable public website-only registration.

## Test results (mock only)
- The dedicated `utils/websiteRegistration.js` passed synthetic linking and recovery tests with a representative pre-existing `@c.us` account.
- Both methods authenticated requests, preserved the original `User.id`, and updated *only* profile and website-link fields. MongoDB coins, bank, cards, guild membership, inventory, orbs and XP were absent from the `$set` update.
- No live production WhatsApp account linking has been exercised, and the bot has not been restarted or switched to this branch.

## 2026-11-01: staged website-to-WhatsApp linking implementation

The Cloudflare Pages **staging site** is now `https://anichan-api-stage.pages.dev`
from branch `feature/typescript-express-mongodb`; this is not the production
`https://anichan.pages.dev` site. The bot development branch remains
`feature/website-link-main`. Neither production `main` nor Baileys is switched.

**Approved user experience:**
1. New WhatsApp user privately sends `.reg`, receiving signup/login links.
2. User registers/logs into the website and verifies their email.
3. Website dashboard generates an expiring eight-digit one-time code.
4. User sends `.reg 12345678` privately to AniChan, using their actual code.
5. Bot calls `/api/internal/inspect-link` using its Bearer secret, but the
   server does **not consume** the code yet.
6. Bot checks both `@c.us` and `@s.whatsapp.net` MongoDB IDs to protect
   existing progress, reject ambiguous duplicates, and reject already linked users.
7. Bot calls `/api/internal/claim-link` with the inspected `siteId`. Server
   atomically consumes the code, prevents identity collisions, and saves website
   account ↔ WhatsApp identity. Bot then updates **only** profile and link fields
   on its existing MongoDB document, with an atomic conditional write.
8. If bot profile syncing fails after website claim, send `.reg` without a
   code to restore from `/api/internal/profile`. Existing economy, cards,
   loans, guild membership, and email recovery state are never overwritten.
9. No new WhatsApp commands are introduced.

**Tested offline:** both branches have successful CI checks. The staged API
test covers Bearer authentication, inspection without consumption, site-ID match,
replay/expiration, identity conflicts, and the disabled feature gate. The
wweb.js tests cover inspection-before-claim, existing IDs, duplicate prevention,
new-user registration writes, code use ordering, recovery, and website link URLs.

**Not yet tested or enabled on live WhatsApp:**
- Cloudflare staging project does not have a `BOT_LINK_SECRET` configured.
- Website `WHATSAPP_LINK_ENABLED` and bot `ANICHAN_REG_LINK_ENABLED` must remain
  disabled until a controlled pilot with a real, owner-authorized phone.
- The bot and staging website must share a strong, new Bearer secret; do not put
  it in GitHub or chat. Do not reuse the public production secret if staging can
  have its own.
- Pilot bot environment: `ANICHAN_SITE_URL=https://anichan-api-stage.pages.dev`,
  `ANICHAN_SITE_BOT_SECRET=<the same staging secret>`,
  `ANICHAN_REG_LINK_ENABLED=true`. Start with a safe backup of the Termux bot
  MongoDB data, and do not run two wweb.js sessions for the same account.
- Staging Pages secret: `BOT_LINK_SECRET=<same staging secret>`. Only during the
  authorized pilot set `WHATSAPP_LINK_ENABLED=true` on the staging project.
- A real inbox's styled Gmail OTP must also be confirmed before approving public
  onboarding. There has not been any real Gmail delivery test yet.
- Never turn on production-only registration, retire legacy commands, migrate
  D1 passwords or deploy to `main` until the real pilot passes.
