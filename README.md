# ╭━━★彡 AniChan Bot 彡★━━╮
> A full-featured WhatsApp bot owned and maintained by **Brandon**, powered by `whatsapp-web.js`.
>
> Runs on Node.js in Termux on Android — no VPS required. The bot's persona is Marin Kitagawa from *My Dress-Up Darling*.

---

## 🚀 Setup Guide

### 1. Prerequisites
- Node.js v20+ (developed and run on Node 24.18.0 aarch64 in Termux)
- Termux (Android) or any Linux/macOS/Windows environment — see the [Termux / Android notes](#-termux--android-notes) below if running on a phone
- MongoDB Atlas account (free tier works): https://mongodb.com/atlas
- A Google AI Studio (Gemini) API key: https://aistudio.google.com
- A Fish Audio API key + a voice reference id: https://fish.audio
- A Cloudinary account (free tier works): https://cloudinary.com
- An Apify account for Pinterest: https://apify.com
- A RapidAPI account for other downloaders/upscaling: https://rapidapi.com
- A SauceNAO API key (free): https://saucenao.com

### 2. Install Dependencies
```bash
cd ani-chan-bot
npm install
```
On Termux, always run `pip`/`npm` installs with patience over mobile data — see the Termux notes below.

### 3. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and fill in the values — every variable the bot actually reads is documented inline in `.env.example`, including:

| Variable | Used for |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `BOT_NAME` / `BOT_PREFIX` | Bot display name and command prefix (default `.`) |
| `BOT_NUMBER` | Optional — link by phone number instead of scanning a QR code |
| `OWNER_NUMBER` / `OWNER_IDS` / `MOD_NUMBERS` | Owner and moderator ids |
| `GEMINI_API_KEY` (+ optional `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL`) | `.copilot`, `.gpt`, `.voice`, `.imagine`, `.translate`, `.transcribe` |
| `FISH_API_KEY` / `FISH_VOICE_ID` (+ optional `FISH_MODEL`) | `.voice` and `.tts` spoken voice-note replies |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) | `.setpic` profile pictures |
| `RAPIDAPI_KEY` | Downloaders (`.ig`, `.ttk`, `.yt`, `.x`, `.fb`, `.play`) and `.upscale` |
| `APIFY_TOKEN` | `.pinterest` / `.pint`, using `accountable_eel/pinterest-search-lookup`; set privately with `node scripts/configure-apify.js` |
| `APIFY_PINTEREST_MAX_PINS` / `APIFY_PINTEREST_CACHE_MINUTES` | Optional — pins per paid run (1–50, default 25) and recent-search cache duration (0–1440 minutes, default 30) |
| `SAUCENAO_KEY` | `.sauce` / `.reverseimg` |
| `PUPPETEER_EXECUTABLE_PATH` | Termux only — path to Chromium (a sensible default is already set) |
| `MIN_REGISTRATION_AGE` / `AGE_VERIFICATION_LOCKOUT_DAYS` | Optional — registration's minimum age (default 18) and the `.setdob` retry lockout in days after an under-age denial (default 30) |
| `NEWS_RSS_QUERY` | Optional — the Google News search topic for `.news` (default `anime OR manga OR manhwa OR donghua`) |

### 4. Seed the Card Database (run once)
```bash
node utils/seedCards.js
```

### 5. Start the Bot
```bash
node index.js
# or with PM2 (recommended for 24/7 uptime):
npm install -g pm2
pm2 start index.js --name ani-chan-bot
pm2 save
pm2 startup
```

### 6. Link WhatsApp
Open WhatsApp on your phone → Linked Devices → Link a Device → scan the QR code printed in the terminal (or skip this by setting `BOT_NUMBER` in `.env` to link by phone number instead).

---

## 📱 Termux / Android Notes
This bot is actively developed and run entirely on an Android phone (Infinix Hot 50i) inside Termux — no server or VPS needed. A few things that matter if you're doing the same:
- **No native npm binary dependencies.** Packages like `canvas`, `sharp`, and `jimp` don't reliably build in Termux. Every image the bot generates (chess/Tic Tac Toe boards, the Battle HUD, card grids) is drawn with a pure-JS pixel renderer instead — see `utils/pngEncoder.js` and the `*BoardImage.js` files under `commands/games/`. Connect 4's board is plain emoji/text instead of a rendered image.
- **ffmpeg is required and used directly** (via `fluent-ffmpeg`) for stickers, video/audio conversion, and voice notes — install it with `pkg install ffmpeg`.
- **Mobile data is often unstable.** `npm install` and any first-time API call can be slow or need a retry — this is expected, not a bug.
- **MongoDB free tier caps out at 512MB** — keep an eye on collection sizes if you're running this long-term on the free Atlas tier.

---

## 📦 RapidAPI Subscriptions Needed
Subscribe to these APIs on RapidAPI (most have free tiers):
- `instagram-downloader` — for `.ig`
- `tiktok-downloader-download-videos-without-watermark` — for `.ttk`
- `youtube-mp36` — for `.yt` and `.play`
- `twitter241` — for `.x`
- `social-media-video-downloader` — for `.fb`
- `ai-image-upscaler` — for `.upscale`

Pinterest uses [accountable_eel/pinterest-search-lookup on Apify](https://apify.com/accountable_eel/pinterest-search-lookup).
Run `node scripts/configure-apify.js` on the device to enter your API token with
hidden input. It updates only `APIFY_TOKEN` in the existing `.env`, then restart
PM2 with `--update-env`. Never put tokens in chat or commit your `.env`.

Each command sends one image and retains per-chat pin deduplication. Recent
results are reused for 30 minutes across chats (at most 50 cached queries),
so repeating a term can select another unseen pin without paying for another
actor run. This memory cache resets on restart. An exhausted result batch asks
for a different term; it does not automatically start another paid run.

The actor bills per returned pin. The default requests at most 25 pins per run;
`maxResults` is also set to that cap. The published base price checked on
26 October 2026 was $0.003 per pin, about $0.075 for 25 pins, plus applicable
actor-start charges. Check Apify for current pricing and account limits.
No automatic POST retries are made. The run timeout is 60 seconds and the HTTP
timeout is 90 seconds; after a lost connection, check the run in Apify before
repeating a search because the run may have started.

---

## 🎴 Commands Reference
The bot's owner-only admin tools (card catalogue management, testing commands, etc.) are intentionally left out of this list — this is the public command set, kept in sync with the in-chat `.menu` command from a single shared source (`utils/commandReference.js`). These tables are regenerated from that file by `generate_readme_commands.js` — run `node generate_readme_commands.js` after changing commandReference.js rather than hand-editing the tables below.

<!-- COMMAND_TABLES_START — auto-generated by generate_readme_commands.js from utils/commandReference.js. Do not hand-edit below this line; run `node generate_readme_commands.js` instead. -->

### ⚙️ GENERAL
| Command | Description |
|---|---|
| `.rules` | View this group's saved rules |
| `.setrules [text]` | Set this group's rules (admin only) |
| `.ping / .test` | Check the bot is online and its response latency |
| `.mods` | List the bot's owner and moderators |
| `.owner` | Send the bot owner's contact card |
| `.url` | Get this group's invite link (admin only) |
| `.otp` | Generate a random 6-digit code (just for fun/utility) |
| `.afk [reason]` | Mark yourself AFK — the bot notifies anyone who mentions you |

### 🎴 CARDS
| Command | Description |
|---|---|
| `.cards [on/off]` | Enable/disable random card drops in this group |
| `.card [index]` | View one of your cards up close (index from .col) |
| `.ci [name] [tier] / .ci [code] / .cardinfo` | Look up a card's full details — by name+tier, or by claim code |
| `.si [series]` | Info about a card series |
| `.ss [series]` | Your owned cards from one series |
| `.clb` | Leaderboard by total cards owned |
| `.vlb` | Leaderboard by total collection value |
| `.tlb` | Leaderboard by highest-tier card owned |
| `.sslb` | Leaderboard by number of SS/SSS cards owned |
| `.mclb` | Leaderboard by best-completed series |
| `.slb [series]` | Leaderboard for who owns the most of one series |
| `.deck [page]` | Visual grid image of your whole card collection — full rendered card art, 12 per page |
| `.col` | View your full card collection, numbered |
| `.cardshop` | Browse cards for sale — player listings and unclaimed catalogue cards |
| `.sellc [index] [price]` | List one of your cards for sale to other players |
| `.buyc [code]` | Buy an unclaimed catalogue card directly at its tier price |
| `.rc [index]` | Remove your card listing from the shop |
| `.claim [id]` | Claim a dropped card, or buy one from the shop |
| `.sc @user [index] [price]` | Propose selling a card directly to another user (they must .acceptsale) |
| `.acceptsale / .declinesale` | Respond to a pending direct-sale offer |
| `.tc @user [idx] [idx]` | Propose a card trade with another user |
| `.accepttrade / .declinetrade` | Respond to a pending trade offer |
| `.lendcard [index] / .lc` | Temporarily lend one of your cards to the group |
| `.unlendcard [index] / .ulc` | Reclaim a lent card early instead of waiting out the hour |
| `.fuse / .fusion` | Fuse duplicate cards into a higher-tier card |
| `.wishlist [add\|remove] [name]` | Manage (or view) your card wishlist |
| `.wishlb` | Leaderboard by wishlist size |
| `.auction / .listauc` | View active auctions; .auction create [card index] [bank price] [5m–24h, default 1h] |
| `.submit [id] [amount] / .bid` | Bid bank coins held in escrow; an outbid player is refunded |
| `.myauc` | View your own active auctions |
| `.remauc [id]` | Cancel an auction before any bids |
| `.stardust` | Check your stardust balance (from converting duplicates) |
| `.anticamp` | Check your camp count — hoarding duplicates decays them over time |
| `.tier [tier]` | View drop-rate odds for every card tier |
| `.cs [name/series]` | Search cards by name or series |
| `.myseries` | View your collection grouped by series, with completion status |
| `.resell [index]` | Instantly sell a card to the bot for 50% of tier value |

### 💰 ECONOMY
New accounts must start registration with `.reg`, then complete their name, date of birth, bio, and profile picture via `.setname` / `.setdob` / `.bio` / `.setpic`, in any order (`.edit` shows what's left). You must be 18+ to register — an under-18 `.setdob` is denied and locks that number out of retrying `.setdob` for 30 days.

| Command | Description |
|---|---|
| `.balance / .bal` | Check your wallet, bank, and orbs |
| `.orbs` | Check your orbs balance |
| `.ebal [@user]` | Check another user's balance |
| `.daily` | Claim your daily coin reward |
| `.withdraw [amount] / .wd` | Withdraw coins from your bank to your wallet |
| `.deposit [amount] / .dep` | Deposit coins from your wallet into your bank |
| `.donate @user [amount]` | Send coins to another user |
| `.lottery` | Buy a 100-coin lottery ticket for a chance to win big |
| `.rich` | Top 10 richest users bot-wide |
| `.richg` | Richest users in this group |
| `.profile / .p` | View your profile card (your email and session status are only shown in a private chat with me) |
| `.setemail [email]` | Private chat only — add or change your verified recovery email, used to unlock your account after 30 days of inactivity (reply to my message with the emailed 6-digit code) |
| `.edit` | Profile dashboard — your current name/bio/DOB/age/picture status (DOB shown in DM only), and the commands to update each |
| `.reg` | Start or resume private profile registration; account activates after all required steps are complete |
| `.setname [name]` | Set your display name on your profile |
| `.setdob [DD/MM/YYYY]` | Set your date of birth — age is calculated automatically; 18+ required |
| `.bio [text] / .setbio` | Set your profile bio |
| `.setage [age]` | Legacy — manually set age; new registrations should use .setdob instead |
| `.setpic` | Set your profile picture (reply to an image) |
| `.removepic` | Clear your profile picture |
| `.inventory / .inv` | View your items |
| `.use [item]` | Use an item from your inventory |
| `.sell [item]` | Sell an item from your inventory |
| `.shop` | Browse the item shop |
| `.buy [item]` | Buy an item from the shop |
| `.dig` | Dig for coins/loot (cooldown: 30 min) |
| `.fish` | Fish for coins (cooldown: 20 min) |
| `.leaderboard / .lb` | XP/level leaderboard |
| `.achievements / .ach` | List your unlocked and locked achievements |
| `.level / .xp [@user]` | View your (or someone else's) level and XP progress |
| `.roast [@user]` | Get roasted (or roast someone else) |
| `.gamble [amount]` | Gamble coins on a 50/50 coin flip |
| `.loan request/repay/status` | Take a bank loan against a staked card, repay it, or check its status |
| `.beg` | Beg for coins (cooldown: 5 min) |

### 🎮 GAMES
Chess, Tic Tac Toe, and Connect 4 share the same flow: `.<game> start` opens a lobby — anyone (including whoever opened it) can `.<game> join`, and the match starts the moment a 2nd player joins, or the lobby auto-closes if nobody does within the time window. `.<game> startbot [easy|medium|hard]` skips the lobby and plays the bot directly. Real PvP turns have a 30-second window — miss it and your turn is skipped (never forfeited), passing to the other player. Chess and Tic Tac Toe show a rendered board image; Connect 4 shows an emoji grid. Battle keeps its own `@mention`-based challenge flow. Only one game can be active per chat at a time — `.quitgame` forfeits whichever one is running.

| Command | Description |
|---|---|
| `.chess start` | Open a Chess lobby (60s window) |
| `.chess join` | Join an open Chess lobby |
| `.chess startbot [easy\|medium\|hard]` | Play Chess against the bot (defaults to medium) |
| `.move [e2e4]` | Make a chess move — shared by PvP and vs-bot games |
| `.ttt start` | Open a Tic Tac Toe lobby (60s window) |
| `.ttt join` | Join an open Tic Tac Toe lobby |
| `.ttt startbot [easy\|medium\|hard]` | Play Tic Tac Toe against the bot |
| `.ttt [1-9]` | Make a move in whichever Tic Tac Toe game is active |
| `.c4 start` | Open a Connect 4 lobby (60s window) |
| `.c4 join` | Join an open Connect 4 lobby |
| `.c4 startbot [easy\|medium\|hard]` | Play Connect 4 against the bot |
| `.drop [1-7]` | Drop a piece into a Connect 4 column |
| `.startbattle @user` | Challenge another player to an HP battle (image HUD) |
| `.startbattle [easy\|medium\|hard]` | Battle the bot |
| `.attack` | Deal random damage to your battle opponent |
| `.defend` | Skip your attack to heal instead |
| `.flee` | Forfeit the current battle |
| `.quitgame / .quit` | Forfeit whichever game (Chess/TTT/Connect 4/Battle) is active, or end a Quiz match you started (joiners: use .quiz leave instead) |
| `.akinator / .aki` | Guess-the-character game |
| `.greekgod / .gg` | Find out which Greek god you embody |
| `.wcg` | Start a 30-second group A/B vote; .wcg A or .wcg B to vote |
| `.quiz start [easy\|normal\|hard]` | Open an Anime/Manga Character Quiz lobby — you join automatically as Player 1 (up to 5 total); starts 30s later with whoever joined |
| `.quiz join` | Take a slot in an open Quiz lobby (up to 5 players) |
| `.quiz leave` | Back out of a Quiz lobby you joined (not the starter — they use .quiz end) |
| `.quiz end` | Cancel a pending Quiz lobby, or end an active match early — starter only |

### 🏰 GUILDS
| Command | Description |
|---|---|
| `.guild info` | View your guild |
| `.guild create [name]` | Create a guild (costs 1000 coins) |
| `.guild description [text]` | View (no text), or set (leader only) your guild's description |
| `.guild invite @user` | Invite a user to your guild (leader/officer) |
| `.guild accept` | Accept a pending guild invite |
| `.guild decline` | Decline a pending guild invite |
| `.guild emblem [emoji]` | Set your guild's emblem (leader only) |
| `.guild members` | List guild members with roles and contribution |
| `.guild promote [name]` | Promote a member one rank: member → veteran → officer (leader only) |
| `.guild demote [name]` | Demote a member one rank: officer → veteran → member (leader only) |
| `.guild remove [name]` | Remove a member from the guild (leader/officer) |
| `.guild donate [amount]` | Donate coins to the guild bank — also raises your contribution |
| `.guild leaderboard [level\|xp\|wealth] / .guildlb` | Top 10 guilds by level, XP, or bank (defaults to level) |
| `.guild leave` | Leave your current guild |
| `.guild transfer @member` | Leader hands over to an existing member and becomes an officer |
| `.guild disband` | Disband your guild (leader only) |

### 🎰 GAMBLE
| Command | Description |
|---|---|
| `.slots [amount]` | Spin the slot machine |
| `.cf [amount]` | Coin flip bet |
| `.dice [amount]` | Roll dice against the bot |
| `.db [amount]` | Double or Bust — higher risk, higher reward |
| `.dp [amount]` | Double or Pass — lower risk, lower reward |
| `.roulette [amount] [bet]` | Roulette — bet red/black/even/odd/a number |
| `.horse [1-5] [amount]` | Bet on a horse race |

### 🎭 INTERACTION
| Command | Description |
|---|---|
| `.hug / .kiss / .slap / .wave / .pat` | Reply to another user — caption mentions you and the quoted user (anime GIF) |
| `.lick / .punch / .bonk / .spank / .tickle / .kill` | Reply to another user — GIF caption mentions both users |
| `.fuck` | API-backed insult reaction GIF — reply to another user |
| `.kidnap` | Anime carry GIF — reply to another user |
| `.die` | API-backed death reaction GIF — reply to another user |
| `.dance / .sad / .smile / .laugh / .angry` | Reply to another user — API GIF caption mentions both users |

### 😂 FUN
| Command | Description |
|---|---|
| `.gay / .lesbian / .simp` | Percentage meter card — reply to or @mention someone, or use it alone for yourself |
| `.pick [what]` | Group only — picks a random member for anything (e.g. .pick gay) |
| `.skill / .duality` | Random silly label generators |
| `.ship [@user1] [@user2]` | Ship two people together with a compatibility score |
| `.gen / .pov / .social / .relation / .pp` | More random silly generators |
| `.wouldyourather / .wyr` | Would You Rather prompt |
| `.joke` | Random joke |
| `.truth / .dare / .td` | Truth, dare, or a random pick of either |
| `.uno` | Multiplayer UNO: .uno start, join, begin; hands sent privately |
| `.meme <text>` | Caption a replied sticker/image as a meme (use \| for top\|bottom text) |

### ⬇️ DOWNLOADERS
| Command | Description |
|---|---|
| `.ig [url]` | Download an Instagram post/reel — shows a thumbnail preview first for video posts |
| `.ttk [url]` | Download a TikTok video (no watermark) — shows a thumbnail preview first |
| `.yt [url or search]` | Download a YouTube video or Short (shows a thumbnail preview first) — music.youtube.com links convert to mp3 audio instead |
| `.x [url]` | Download a Twitter/X video — shows a thumbnail preview first for videos |
| `.fb [url]` | Download a Facebook video — shows a thumbnail preview first for videos |
| `.play [song name]` | Search YouTube and send back the audio — shows a thumbnail preview while it processes |

### 🔍 SEARCH
| Command | Description |
|---|---|
| `.pinterest [query] / .pint` | Search Pinterest images |
| `.sauce / .reverseimg` | Reverse image search a replied image (SauceNAO) |
| `.wallpaper [query]` | Search wallpapers (wallhaven.cc) |
| `.lyrics [song name]` | Look up song lyrics |

### 🤖 AI
| Command | Description |
|---|---|
| `.copilot [msg]` | AI chat as the active persona (Gemini), shared group history and private DM history — text, emojis, and optional stickers |
| `.gpt [msg]` | Ask Gemini one question directly — no persona, no memory, no reactions or stickers, text reply only |
| `.voice [msg]` | Same AI chat as .copilot, replied as a spoken voice note (Fish Audio TTS) |
| `.imagine [prompt]` | AI image generation (Gemini 2.5 Flash Image) |
| `.upscale` | Upscale a replied image |
| `.translate [lang] [text] / .tt` | Translate text |
| `.transcribe / .tb` | Transcribe a replied voice note to text |
| `.tts [text]` | Turn text into a voice note; only the reaction and final audio are sent (reply to a message to use its text) |

### 🔄 CONVERTER
| Command | Description |
|---|---|
| `.sticker / .s` | Convert an image/GIF/video to a sticker |
| `.take` | Re-save a sticker under your own pack name/author |
| `.toimg` | Convert a sticker/webp back to an image |
| `.tovid` | Convert a GIF/image/video to an MP4 |
| `.tomp3` | Extract audio from a video as MP3 |
| `.tovn` | Convert audio to a WhatsApp voice note |
| `.rotate [degrees]` | Rotate a replied image |
| `.flip` | Horizontally flip a replied image |
| `.resize [width] [height]` | Resize a replied image (pixels, min 100px per side — not a percentage) |
| `.tourl` | Upload replied media and get a direct link |

### 🌸 ANIME SFW
| Command | Description |
|---|---|
| `.waifu / .neko / .maid` | Random SFW anime character images |
| `.selfies / .uniform` | More SFW anime image categories |
| `.mori-calliope / .raiden-shogun / .kamisato-ayaka` | Character-themed SFW anime images |

### 🔞 ANIME NSFW
| Command | Description |
|---|---|
| `.nsfw on/off` | Enable/disable NSFW commands in this group (admin only) |
| `.oppai / .milf / .ass / .hentai / .oral / .ecchi` | NSFW anime image categories (requires .nsfw on) |
| `.paizuri / .ero` | More NSFW anime image categories (requires .nsfw on) |
| `.ehentai [tag]` | Link to an e-hentai search for a tag |
| `.nhentai [code or tag]` | Link to an nhentai search or gallery |

### 🛡️ ADMIN
| Command | Description |
|---|---|
| `.kick @user` | Remove a user from the group |
| `.delete` | Delete a replied message |
| `.pin [24h/7d/30d]` | Pin a replied message (defaults to 30d) — admin only, groups only |
| `.unpin` | Unpin a replied message — admin only, groups only |
| `.antilink [on/off]` | Auto-remove messages containing links |
| `.antilink action [warn/kick]` | Set what happens when antilink triggers |
| `.antibot [on/off]` | Delete messages from other bots, warn them, and remove them at the warning limit — admin only |
| `.antibot id` | Reply to a message to see how Anti-Bot detects it (admin only) |
| `.antism on/off` | Auto-remove status/channel forward spam |
| `.warn @user [reason]` | Issue a warning to a user |
| `.resetwarn @user` | Clear a user's warnings |
| `.groupstats / .gs` | View group settings and member statistics |
| `.welcome on/off` | Toggle welcome messages for new members |
| `.setwelcome [message]` | Set the welcome message (use @user as a placeholder) |
| `.leave on/off` | Toggle goodbye messages when members leave |
| `.setleave [message]` | Set the goodbye message |
| `.purge [count]` | Revoke recent eligible messages (default 10, maximum 100; group admin) |
| `.blacklist add/remove/list` | Manage blacklisted words |
| `.promote @user` | Promote a user to group admin |
| `.demote @user` | Demote a group admin |
| `.mute [time] / .unmute` | Lock the group to admins-only messaging — optionally for a set time (e.g. .mute 30s, .mute 5m, .mute 2h), after which it auto-unmutes; .unmute unlocks it early at any point |
| `.hidetag [message]` | Mention everyone silently (no notification) |
| `.tagall [message]` | Mention everyone with a visible notification |
| `.activity` | Show member activity stats |
| `.active / .inactive` | List the most/least active members |
| `.open / .close` | Open/close the group to everyone's messages |
| `.news` | Fetch the latest anime/manga/manhwa/donghua news from Google News (admin only) — also auto-posts hourly to every group the bot is in |

### 🐾 PETS
| Command | Description |
|---|---|
| `.pet` | View your pet |
| `.pet catalogue` | Browse every adoptable pet, grouped by rarity |
| `.pet adopt [name]` | Adopt a pet (costs 500 coins) |
| `.pet feed` | Feed your pet using Pet Food from your inventory |
| `.pet play` | Play with your pet (cooldown: 2 hrs) |
| `.pet name [name]` | Rename your pet |

### 🎨 TEXT STYLES
| Command | Description |
|---|---|
| `.fancy` | Show a gallery of all 35 Unicode fancy-text styles |
| `.fancy [styleNumber] [text]` | Convert text into one of the 35 styles |

### 📬 FEEDBACK
| Command | Description |
|---|---|
| `.feedback [message]` | Send feedback directly to the bot owner |

<!-- COMMAND_TABLES_END -->

---

## 🛠 Tech Stack
- **Runtime**: Node.js (24.18.0 aarch64 in production, on Termux/Android)
- **WhatsApp**: `whatsapp-web.js` (unofficial — see note below)
- **Database**: MongoDB + Mongoose
- **AI chat / translation / transcription / image generation**: Google Gemini, called directly over REST (no SDK, to avoid an extra npm install on unstable mobile data)
- **Voice replies**: Fish Audio TTS (`.voice`, `.tts`)
- **Board/HUD images**: Hand-written pure-JS pixel renderer + a from-scratch PNG encoder (`utils/pngEncoder.js`) — no `canvas`/`sharp`/`jimp`, since none of those reliably build in Termux
- **Game AI**: Alpha-beta minimax (Chess, Connect 4), full minimax (Tic Tac Toe), heuristic decision-making (Battle)
- **Profile pictures**: Cloudinary
- **Anime images**: nekos.best (primary) with an otakugifs.xyz fallback, since nekos.best is Cloudflare-blocked on some connections
- **Anime/manga news**: Google News RSS, parsed with a small hand-rolled regex parser rather than an XML library — see `commands/news.js`
- **Media processing**: `fluent-ffmpeg` + system `ffmpeg` (stickers, video/audio/voice-note conversion)
- **Pinterest search**: Apify (keyword-search actor over REST)
- **Downloaders**: RapidAPI
- **Process management**: PM2

## ⚠️ Notes
- This bot uses `whatsapp-web.js`, which is **unofficial**. Use at your own risk — WhatsApp can change behavior without notice.
- Keep your session folder backed up to avoid re-scanning the QR code after every restart.
- If you're not on Termux, you can still run this anywhere Node.js + ffmpeg + Chromium are available (a VPS works fine too) — just adjust `PUPPETEER_EXECUTABLE_PATH` for your platform.

---

## 📄 License
This project is released into the public domain under [The Unlicense](LICENSE) — free for anyone to use, modify, sell, or distribute for any purpose, with no restrictions and no attribution required.


## Reliability and game rules

The bot uses one PM2 instance. MongoDB must support transactions (Atlas or a
replica set). Existing `.env` values remain in use; this update adds no required
API keys. whatsapp-web.js is pinned to 1.34.7 to match the checked-in patch.

- Auctions use bank coins in escrow. `.auction create [card index] [price] [duration]`
  defaults to one hour; durations range from `5m` to `24h`. Bids increase by at
  least one coin. Outbid players receive refunds. There are no fees; cancellation
  is allowed before the first bid. Expired auctions settle automatically after
  restart, and cards stay locked while an auction is active.
- UNO: `.uno start`, `.uno join`, then the host may `.uno begin`. The lobby closes
  after 60 seconds and begins automatically with at least two players. Hands go
  to each player's DM; `.uno hand` requests yours again. Use `.uno play [number]
  [wild color] [uno]`, `.uno draw`, `.uno pass`, `.uno uno`, `.uno catch @player`,
  or `.uno leave`. There is no stacking or jumping in. Legal +4 plays are enforced
  directly. Playing turns are untimed. Leaving returns a hand to the shuffled
  deck; the last remaining player wins.
- WCG: `.wcg` opens a 30-second A/B vote. Send `A`/`B` or `.wcg A`/`.wcg B`.
  One vote per registered player is counted; it may be changed before expiry.
  The result is a tally, with no invented points or economy rewards.
- Existing game turns and quiz questions retain their saved deadlines after
  restart. An expired turn is skipped once, then the next turn gets its normal
  window. A malformed session does not prevent other sessions from restoring.
- Lucky Charm halves a group's normal card-drop interval for one hour and does
  not stack. It requires enabled card drops in that group. VIP Badge appears on
  the profile; duplicate activation preserves the spare item.
- Automatic account cleanup uses **120 days** of recorded inactivity. Unknown
  activity timestamps and configured owner accounts are excluded. Active loans,
  lent/staked cards, active auctions and guild leadership block deletion. Eligible
  accounts lose their linked records and release their owned cards. Profile
  images are cleaned through a durable retry queue. Shared group AI threads are
  preserved because their messages have no per-author deletion key.
- Financial writes use transactions or revision checks; a concurrent command can
  be rejected instead of overwriting a newer balance. Check the current state
  before retrying a command after an ambiguous connection failure.

WhatsApp sends cannot participate in a MongoDB transaction. A crash between a
successful send and recording it can repeat a notification; financial settlement
is idempotent. Revocation requests depend on WhatsApp eligibility and may partly
fail. The bot reports those counts.

## Safe source exports and checks

`node scripts/export-source.js` creates a source ZIP from the latest committed
Git version. It excludes `.env`, authentication sessions, runtime caches, backups
and logs, and includes `.env.example`. A filesystem ZIP made by another program
does not automatically use these exclusions. Previously shared archives and
credentials are not changed by this utility.

Run unit tests with `node --test tests/*.test.js`. Transaction integration tests
are skipped unless `ANICHAN_TEST_MONGO_URI` points to the explicitly named local
`anichan_repair_test` database. They delete test fixtures and refuse production
or remote databases. Run them only against an isolated local replica set.
