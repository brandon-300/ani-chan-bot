# AniChan: wweb.js-first website migration

This development branch is intentionally based on **main** (whatsapp-web.js). Do not copy these changes to `baileys-migration` until the wweb.js migration is complete and proven stable.

## Verified preparation
- AniChan Pages site: `https://anichan.pages.dev` (Cloudflare Pages project `anichan`, branch `website-cloudflare`).
- Bot-only authenticated API: `/api/internal/claim-link` and `/api/internal/profile`.
- The owner verified an HTTP 200 response to the authenticated profile endpoint from Termux on 2026-10-31; this establishes matching configured secrets for that test.
- The site database is D1 `anichan-website-auth`, independent of the MongoDB `anichan` gameplay database.
- WhatsApp linking is *not* enabled for public signup at this stage: `WHATSAPP_LINK_ENABLED` defaults to off.

## Development branch implementation
- `commands/website.js` supports `.website`, DM-only `.link <8 digits>`, and `.syncprofile`.
- Existing MongoDB users are located by their WhatsApp ID; the migration does not touch coins, bank, orbs, cards, guilds, inventory, achievements or progression.
- Profile updates to name, bio, date of birth, age, and (where Cloudinary is configured) avatar are applied to the matched MongoDB user.
- If the website successfully claims a code but the MongoDB profile update fails, `.syncprofile` can retry without the original code.
- The wweb.js router permits the three website commands before registration, and the old session-lock gate exempts them.
- `ANICHAN_WEB_REGISTRATION_ONLY=true` (disabled by default) blocks the old bot registration/profile-edit handlers and redirects users to the site. **Do not enable this flag until the full account migration is tested.**
- `.setemail` remains as legacy account recovery while website email verification/recovery and the old session-lock behavior are migrated.
- The command menu references website registration and linking.

## Required acceptance tests before cutover
1. **Web account signup:** verify a new 18+ test account can register, sign in, edit its profile, and sign out. Add email-ownership verification and password recovery before broad public use.
2. **Existing user claim:** snapshot their MongoDB document. Generate a code in the website dashboard after enabling linking in a controlled test. Send `.link CODE` from that *existing* account in a DM. Verify `User.id`, coins, card records, guild, loans, orbs and XP are unchanged and that the website profile is synchronized.
3. **New user claim:** use a new test WhatsApp number and confirm exactly one new MongoDB account is created with correct registration status, while an invalid or expired link code creates none.
4. **Authorization:** verify linking from a group, from a different WhatsApp number, after code expiry, or with an incorrect secret is rejected.
5. **Recovery:** simulate a MongoDB write failure after code claim, restore DB, and confirm `.syncprofile` completes without lost card/economy data.
6. **Profile edits:** change site name, bio, DOB, and avatar; run `.syncprofile`, check old WhatsApp messages/renderers still display the new values. Test legacy `@c.us` and `@s.whatsapp.net` ID mappings.
7. **Session/legacy-email lock:** test an existing user with `sessionLockedAt` set can use `.link` / `.syncprofile` safely without bypassing unrelated privileged commands.
8. **Enable website-only registration:** set `ANICHAN_WEB_REGISTRATION_ONLY=true` in the **running wweb.js bot** only after tests. Confirm `.reg`, `.setname`, `.setdob`, `.setpic`, `.removepic`, `.bio`, `.setage`, `.edit` no longer execute legacy writes. Confirm `.profile`, `.balance` and games remain available to already-active legacy users.
9. **Menu/audit:** confirm commands and help messages match the new workflow. Only then merge to `main`, and separately handle Baileys later.

## Security and rollback
- Store the same 32-byte generated key as **encrypted Pages secret** `BOT_LINK_SECRET` and **private bot `.env`** variable `ANICHAN_SITE_BOT_SECRET`. No secrets belong in Git, screenshots or chats.
- `WHATSAPP_LINK_ENABLED=true` is a separate public-link-code issuance gate on Pages, disabled unless the bot's `.link` handler is deployed and tested.
- Use HTTPS only. The WhatsApp sender ID comes from the authenticated WhatsApp message, **never a web form**.
- Disable both feature flags to return to the original registration flows if tests fail, and revert only the wweb.js development deployment.
- The original `main` and `baileys-migration` branches and dated backup branches must not be changed during this phase.
- Do not run destructive MongoDB cleanup, drop indexes or overwrite user data as part of registration migration.
