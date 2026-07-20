# ╭━━★彡 AniChan Bot 彡★━━╮
> A full-featured WhatsApp bot by Riz, powered by whatsapp-web.js

---

## 🚀 Setup Guide

### 1. Prerequisites
- Node.js v18+ installed
- MongoDB Atlas account (free): https://mongodb.com/atlas
- OpenAI API key: https://platform.openai.com
- RapidAPI key: https://rapidapi.com

### 2. Install Dependencies
```bash
cd ani-chan-bot
npm install
```

### 3. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and fill in:
| Variable | Description |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `OPENAI_API_KEY` | For .gpt, .copilot, .imagine, .translate, .transcribe |
| `RAPIDAPI_KEY` | For downloaders (.ig, .ttk, .yt, .x, .fb), .pinterest |
| `SAUCENAO_KEY` | For .sauce (free at saucenao.com) |
| `OWNER_NUMBER` | Your WhatsApp number with country code |
| `PREFIX` | Default is `.` |
| `BOT_NAME` | Default is `Ani-Chan Bot` |

### 4. Seed Card Database (run once)
```bash
node utils/seedCards.js
```

### 5. Start the Bot
```bash
node index.js
# or with PM2 (recommended for 24/7):
npm install -g pm2
pm2 start index.js --name ani-chan-bot
pm2 save
pm2 startup
```

### 6. Scan QR Code
Open WhatsApp on your phone → Linked Devices → Link a Device → Scan the QR code printed in terminal.

---

## 📦 RapidAPI Subscriptions Needed
Subscribe to these APIs on RapidAPI (most have free tiers):
- `instagram-downloader` — for .ig
- `tiktok-downloader-download-videos-without-watermark` — for .ttk
- `youtube-mp36` — for .yt and .play
- `twitter241` — for .x
- `social-media-video-downloader` — for .fb
- `pinterest-scraper` — for .pinterest
- `ai-image-upscaler` — for .upscale

---

## 🎴 Commands Reference

### Cards
| Command | Description |
|---|---|
| `.cards [on/off]` | Enable/disable card drops in group |
| `.card [index]` | View a card in your collection |
| `.ci [name] [tier]` | Card info from catalogue |
| `.si [series]` | Series info |
| `.ss [series]` | Your cards from a series |
| `.slb [series]` | Series leaderboard |
| `.clb` | Card collection leaderboard |
| `.deck` | View your battle deck |
| `.col` | View full collection |
| `.cardshop` | Browse cards for sale |
| `.sellc [index] [price]` | List card for sale |
| `.rc [index]` | Remove card from sale |
| `.vs @user` | Deck battle |
| `.claim [id]` | Claim a dropped card or buy from shop |
| `.sc @user [index] [price]` | Sell card to a user |
| `.tc @user [idx] [idx]` | Trade cards |
| `.lendcard` | Lend your top card to group |
| `.auction` | View active auctions |
| `.submit [id] [amount]` | Bid on auction |
| `.myauc` | Your active auctions |
| `.remauc [id]` | Remove your auction |
| `.listauc` | List all auctions |
| `.stardust` | Check stardust balance |
| `.anticamp` | View camp stats |

### Economy
| Command | Description |
|---|---|
| `.balance / .bal` | Check wallet, bank, orbs |
| `.orbs` | Check orbs |
| `.ebal [@user]` | Check another user's balance |
| `.daily` | Claim daily reward |
| `.withdraw [amount]` | Withdraw from bank |
| `.deposit [amount]` | Deposit to bank |
| `.donate @user [amount]` | Donate coins |
| `.lottery` | Try your luck (100 coin ticket) |
| `.rich` | Top 10 richest users |
| `.richg` | Richest in this group |
| `.profile / .p` | View profile |
| `.edit` | Edit profile |
| `.bio [text]` | Set bio |
| `.setage [age]` | Set age |
| `.inventory / .inv` | View inventory |
| `.use [item]` | Use an item |
| `.sell [item]` | Sell an item |
| `.shop` | View shop |
| `.buy [item]` | Buy an item |
| `.dig` | Dig for loot (30 min cooldown) |
| `.fish` | Fish for coins (20 min cooldown) |
| `.leaderboard / .lb` | XP/level leaderboard |
| `.roast [@user]` | Get roasted |
| `.gamble [amount]` | Gamble coins (50/50) |
| `.beg` | Beg for coins (5 min cooldown) |

### Games
| Command | Description |
|---|---|
| `.ttt @user` | Start Tic Tac Toe |
| `.startbattle @user` | Start card battle RPG |
| `.attack` | Attack in battle |
| `.defend` | Defend in battle |
| `.flee` | Flee from battle |
| `.akinator` | Akinator guessing game |
| `.greekgod` | Discover your Greek god |
| `.c4 @user` | Connect 4 |
| `.drop [1-7]` | Drop piece in Connect 4 |
| `.wcg` | Would you rather group game |
| `.chess @user` | Start chess game |
| `.move [e2e4]` | Make chess move |

### Guilds
| Command | Description |
|---|---|
| `.guild info` | View your guild |
| `.guild create [name]` | Create a guild (1000 coins) |
| `.guild invite @user` | Invite to guild |
| `.guild accept` | Accept guild invite |
| `.guild decline` | Decline invite |
| `.guild emblem [emoji]` | Set guild emblem |
| `.guild leave` | Leave guild |
| `.guild disband` | Disband guild (leader only) |

### Gambling
| Command | Description |
|---|---|
| `.slots [amount]` | Spin the slots |
| `.cf [amount]` | Coin flip |
| `.dice [amount]` | Dice vs bot |
| `.db [amount]` | Double or Bust |
| `.dp [amount]` | Double or Pass |
| `.roulette [amount] [bet]` | Roulette (red/black/even/odd/number) |
| `.horse [1-5] [amount]` | Horse racing |

### Pets
| Command | Description |
|---|---|
| `.pet` | View your pet |
| `.pet adopt [type]` | Adopt a pet (500 coins) |
| `.pet feed` | Feed your pet |
| `.pet play` | Play with pet |
| `.pet name [name]` | Rename pet |

### Interactions
`.hug .kiss .slap .wave .pat .dance .sad .smile .laugh .lick .punch .kill .bonk .tickle .shrug .tickle .kidnap` and meme commands

### Fun
`.gay .lesbian .simp .ship .skill .duality .gen .pov .social .relation .pp .wouldyourather .joke .truth .dare .td .uno`

### Downloaders
`.ig .ttk .yt .x .fb .play`

### Search
`.pinterest .sauce .wallpaper .lyrics`

### AI
| Command | Description |
|---|---|
| `.copilot [msg]` | Full context-aware AI chat (GPT-4o) |
| `.gpt [msg]` | Single-turn GPT (GPT-4o-mini) |
| `.imagine [prompt]` | DALL-E 3 image generation |
| `.upscale` | Upscale a replied image |
| `.translate [lang] [text]` | Translate text |
| `.transcribe` | Transcribe a voice note |

### Converters
`.sticker .take .toimg .tovid .rotate [degrees]`

### Anime SFW
`.waifu .neko .maid .mori-calliope .raiden-shogun .oppai .selfies .uniform .kamisato-ayaka`

### Anime NSFW (admin must enable with .nsfw on)
`.milf .ass .hentai .oral .ecchi .paizuri .ero .ehentai .nhentai`

### Admin
`.kick .delete .antilink .antilink action .antism .warn .resetwarn .groupstats .welcome .setwelcome .leave .setleave .purge .blacklist .promote .demote .mute .unmute .hidetag .tagall .activity .active .inactive .open .close`

---

## 🛠 Tech Stack
- **Runtime**: Node.js
- **WhatsApp**: whatsapp-web.js
- **Database**: MongoDB + Mongoose
- **AI**: OpenAI (GPT-4o, DALL-E 3, Whisper)
- **Images**: Anime: nekos.best, waifu.im | Wallpaper: wallhaven.cc
- **Media**: sharp (images), ffmpeg (video/stickers)
- **Downloaders**: RapidAPI

## ⚠️ Notes
- This bot uses `whatsapp-web.js` which is **unofficial**. Use at your own risk.
- Host on a VPS for 24/7 uptime (DigitalOcean, Railway, etc.)
- Keep your session folder backed up to avoid re-scanning QR
