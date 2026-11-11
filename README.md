# AniChan Bot
> A full-featured WhatsApp bot owned and maintained by **Brandon**, powered by **@whiskeysockets/baileys** (v7.0.0-rc14).
>
> Runs on Node.js in Termux on Android — no VPS required. The bot's persona is Marin Kitagawa from *My Dress-Up Darling*.
>
> The code is TypeScript now — everything in `src/` is `.ts` and runs directly with tsx. See [TypeScript](#typescript).

---

## Setup Guide

### 1. Prerequisites
- Node.js v20+ (developed and run on Node 24.18.0 aarch64 in Termux)
- Termux (Android) or any Linux/macOS/Windows environment — see the [Termux / Android notes](#-termux--android-notes) below if running on a phone
- MongoDB Atlas account (free tier works): https://mongodb.com/atlas
- A Google AI Studio (Gemini) API key: https://aistudio.google.com
- A Fish Audio API key + a voice reference id: https://fish.audio
- A Cloudinary account (free tier works): https://cloudinary.com
- A RapidAPI account: https://rapidapi.com
- A SauceNAO API key (free): https://saucenao.com

### 2. Install Dependencies
```bash
cd ani-chan-bot
git checkout baileys-migration
npm install
```
On Termux, always run `npm` installs with patience over mobile data — see the Termux notes below.

### 3. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and fill in the values — every variable the bot actually reads is documented inline in `.env.example`, including:

| Variable | Used for |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `BOT_NAME` / `BOT_PREFIX` | Bot display name and command prefix (default `.`) |
| `BOT_NUMBER` | **Required for Termux** — Your WhatsApp account phone number in international format, digits only (e.g., `2348012345678`) |
| `PHONE_NUMBER` | **Required for Baileys** — Same as BOT_NUMBER, used for pairing code generation |
| `OWNER_NUMBER` / `OWNER_IDS` / `MOD_NUMBERS` | Owner and moderator WhatsApp IDs (supports both LID `@lid` and PN `@s.whatsapp.net` formats) |
| `GEMINI_API_KEY` (+ optional `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL`) | `.copilot`, `.gpt`, `.voice`, `.imagine`, `.translate`, `.transcribe` |
| `FISH_API_KEY` / `FISH_VOICE_ID` (+ optional `FISH_MODEL`) | `.voice` and `.tts` spoken voice-note replies |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) | `.setpic` profile pictures |
| `RAPIDAPI_KEY` | Downloaders (`.ig`, `.ttk`, `.yt`, `.x`, `.fb`, `.play`) and `.pinterest` |
| `SAUCENAO_KEY` | `.sauce` / `.reverseimg` |
| `PUPPETEER_EXECUTABLE_PATH` | Termux only — path to Chromium (default: `/data/data/com.termux/files/usr/bin/chromium-browser`) |
| `MIN_REGISTRATION_AGE` / `AGE_VERIFICATION_LOCKOUT_DAYS` | Optional — registration's minimum age (default 18) and the `.setdob` retry lockout in days after an under-age denial (default 30) |
| `NEWS_RSS_QUERY` | Optional — the Google News search topic for `.news` (default `anime OR manga OR manhwa OR donghua`) |

### 4. Seed the Card Database (run once)
```bash
npx tsx src/utils/seedCards.ts
```

### 5. Start the Bot
```bash
npm start        # run the bot (TypeScript runs directly via tsx)
npm run dev      # same, but auto-restarts when you change code
# or with PM2 (recommended for 24/7 uptime on Termux):
npm install -g pm2
npm run pm2      # starts via ecosystem.config.cjs
pm2 save
```

### 6. Pair with WhatsApp (Baileys)
**Baileys uses pairing codes instead of QR codes for Termux:**

1. Start the bot: `npm start`
2. The bot will display: `WhatsApp pairing code: ABC123`
3. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device
4. Select "Pair with phone number" and enter the pairing code
5. The bot will connect automatically

**Important:**
- On first run, a new `auth_info_baileys/` directory will be created
- **DO NOT commit this directory to Git** — it contains your authentication credentials
- **DO NOT share or backup this directory publicly**
- If you need to pair again, delete the `auth_info_baileys/` directory and restart

### 7. Reconnect Behavior
- **First connection**: Bot initializes and starts all background systems (scheduler, card drops, games, etc.)
- **Normal restart**: Bot reconnects and restores WhatsApp connection — background systems are NOT re-initialized
- **Logged out**: Delete `auth_info_baileys/` and restart to pair again
- **Auth directory deleted**: New authentication required

---

## Baileys v7 Migration Notes

### What Changed
- **Library**: Migrated from `whatsapp-web.js` to `@whiskeysockets/baileys` v7.0.0-rc14
- **Authentication**: Uses pairing codes instead of QR codes (better for Termux)
- **Auth directory**: `auth_info_baileys/` (was `.wwebjs_auth/`)
- **Identity**: Supports both LID (Lightweight ID) and PN (Phone Number) formats
- **Reactions**: Uses native Baileys `messages.reaction` event
- **Message store**: Real getMessage() implementation for Baileys callback

### Compatibility
- All existing commands work without changes
- AI stickers, reactions, and games work with the new library
- Group operations (promote, demote, add, remove) use Baileys methods

### Known Differences
- **Pairing**: Uses pairing code instead of QR code
- **Reconnection**: Background systems only initialize once, not on every reconnect
- **Voice notes**: Properly detected with explicit `ptt` flag (not just MIME type)
- **Sticker metadata**: Pack name and author are explicitly enforced

---

## WhatsApp Authentication (Baileys)

### First Run (Pairing)
```
WhatsApp pairing code: ABC123
Enter this code on the linked-device screen in WhatsApp.
```
1. On your phone: WhatsApp → Settings → Linked Devices → Link a Device
2. Select "Pair with phone number"
3. Enter the pairing code displayed by the bot
4. Connection established!

### Normal Restart
```
WhatsApp ready
```
- Bot reconnects automatically
- All background systems remain active
- No new pairing required

### Logged Out
```
WhatsApp logged this device out. Remove auth_info_baileys only if you intend to pair again.
```
1. Delete the `auth_info_baileys/` directory
2. Restart the bot
3. Pair again with a new code

### Recovery
- **Backup**: The `auth_info_baileys/` directory is your credential — back it up securely
- **Security**: Never commit, share, or upload this directory
- **Multiple devices**: Each device needs its own authentication

---

## Security Notice

### Authentication Directory
**`auth_info_baileys/` is a sensitive credential directory.**

- **DO NOT commit to Git** — it's in `.gitignore`
- **DO NOT upload to cloud storage**
- **DO NOT share with anyone**
- **DO NOT paste contents in AI tools**
- **DO NOT include in screenshots**

This directory contains long-lived authentication tokens equivalent to your WhatsApp account access.

### Identity System
AniChan now properly handles both:
- **Phone Number JIDs**: `123456@s.whatsapp.net`
- **Lightweight IDs (LIDs)**: `123456@lid`

Owner and moderator configuration works with both formats.

---

## Termux / Android Notes

This bot is actively developed and run entirely on an Android phone (Infinix Hot 50i) inside Termux — no server or VPS needed. Important considerations:

- **No native npm binary dependencies.** Packages like `canvas`, `sharp`, and `jimp` don't reliably build in Termux. Every image the bot generates (chess/Tic Tac Toe boards, the Battle HUD, card grids) is drawn with a pure-JS pixel renderer instead — see `src/utils/pngEncoder.ts` and the `*BoardImage.ts` files under `src/commands/games/`. Connect 4's board is plain emoji/text instead of a rendered image.
- **ffmpeg is required** and used directly (via `fluent-ffmpeg`) for stickers, video/audio conversion, and voice notes — install it with `pkg install ffmpeg`.
- **Mobile data is often unstable.** `npm install` and any first-time API call can be slow or need a retry — this is expected, not a bug.
- **MongoDB free tier caps out at 512MB** — keep an eye on collection sizes if you're running this long-term on the free Atlas tier.
- **Chromium required for card rendering** — install with `pkg install chromium` and set `PUPPETEER_EXECUTABLE_PATH` in `.env` if not using the default path.

### Termux Setup Commands
```bash
# Update packages
pkg update && pkg upgrade

# Install dependencies
pkg install nodejs git ffmpeg chromium

# Clone and setup
cd ~/whatsapp-bot
git clone https://github.com/brandon-300/ani-chan-bot.git
cd ani-chan-bot
git checkout baileys-migration
npm install

# Copy env and configure
cp .env.example .env
nano .env

# Keep Termux awake so Android does not kill the bot in the background
termux-wake-lock

# Start the bot
npm start
```

---

## RapidAPI Subscriptions Needed

Subscribe to these APIs on RapidAPI (most have free tiers):
- `instagram-downloader` — for `.ig`
- `tiktok-downloader-download-videos-without-watermark` — for `.ttk`
- `youtube-mp36` — for `.yt` and `.play`
- `twitter241` — for `.x`
- `social-media-video-downloader` — for `.fb`
- `pinterest-scraper` — for `.pinterest`
- `ai-image-upscaler` — for `.upscale`

---

## TypeScript

All bot code in `src/` is now **TypeScript** (`.ts` files). You do not need to compile anything to run the bot — it runs TypeScript directly with **tsx**:

| Command | What it does |
|---|---|
| `npm start` | Run the bot |
| `npm run dev` | Run the bot, auto-restart when you edit code |
| `npm run build` | Compile everything to plain JavaScript in `dist/` |
| `npm run start:prod` | Run the compiled version (`node dist/index.js`) |
| `npm run typecheck` | Report type mistakes without running the bot |
| `npm test` | Run the test suite |

Details in `TYPESCRIPT_MIGRATION.md`.

## REST API + Cloudflare Tunnel (for your website / Discord bot)

The bot has a built-in read-only REST API, so your website can show the same data the bot uses (leaderboards, cards, guilds, auctions...). Turn it on in `.env`:

```bash
API_ENABLED="true"
API_PORT=3000
API_KEY="pick-a-long-random-secret"   # only needed for /api/admin/* routes
```

Endpoints (all start with `/api`): `health`, `stats`, `leaderboard?type=coins|xp|level|orbs|tradesCompleted`, `users/:id`, `users/:id/cards`, `cards?q=&tier=&sort=`, `cards/:cardId`, `guilds?sort=reputation`, `guilds/:id`, `auctions`, and `admin/users` (send header `X-API-Key: <API_KEY>`).

To put the API on the internet without opening ports on your phone, use a Cloudflare Tunnel (needs the `cloudflared` app installed and a domain whose DNS is on Cloudflare):

```bash
# one-time setup
bash scripts/setup-cloudflare-tunnel.sh api.your-domain.com

# keep this running next to the bot
cloudflared tunnel run ani-chan-bot
```

Your API is then live at `https://api.your-domain.com/api/health`. See `cloudflared.config.example.yml` for the manual config version.

---

## Architecture Overview

```
AniChan Bot
├── Application Logic (commands, games, AI)
│   ├── MongoDB (user data, cards, guilds, economy)
│   ├── AI Services (Gemini, Fish Audio)
│   └── Business Logic (scheduler, news, etc.)
│
└── WhatsApp Adapter (src/whatsapp/)
    ├── Identity Service (LID/PN resolution)
    ├── Groups Service (metadata, participants)
    ├── Media Service (upload/download)
    ├── Messages Service (send/receive)
    └── Socket Manager (Baileys connection)
        └── @whiskeysockets/baileys v7.0.0-rc14
```

The adapter provides a clean abstraction over Baileys, allowing the application logic to remain library-independent.

---

## Commands Reference

The bot's owner-only admin tools (card catalogue management, testing commands, etc.) are intentionally left out of this list — this is the public command set, kept in sync with the in-chat `.menu` command from a single shared source (`src/utils/commandReference.ts`). These tables are regenerated from that file by the `generate_readme_commands.cjs` script at the repo root — run `node generate_readme_commands.cjs` (or `npx tsx generate_readme_commands.cjs`) after changing commandReference.ts rather than hand-editing the tables below.

<!-- COMMAND_TABLES_START — auto-generated by generate_readme_commands.js from utils/commandReference.js. Do not hand-edit below this line; run `node src/utils/generate_readme_commands.js` instead. -->

### GENERAL
| Command | Description |
|---|---|
| `.rules` | View this group's saved rules |
| `.setrules [text]` | Set this group's rules (admin only) |
| `.ping / .test` | Check the bot is online and its response latency |
| `.stats` | Full bot + per-group usage stats, incl. daily 8AM WAT digest (owner only, DM only) |
