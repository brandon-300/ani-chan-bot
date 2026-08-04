require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeGetQuotedMessage, safeGetChat, safeGetContact, resolveSenderName, withRetry, encodeIdKey } = require('./utils/helpers');

// Shared with the LocalAuth session path below and with the browser-lock
// recovery helpers further down, so both always agree on the same binary
// and directory instead of duplicating the string in multiple places.
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/data/data/com.termux/files/usr/bin/chromium-browser';
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth', 'session');

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);

  // whatsapp-web.js throws this as a bare string (not an Error) from inside
  // an internal page-navigation listener that never gets awaited by
  // anything, which is why it surfaces here as an unhandled rejection
  // instead of through client.on('disconnected', ...). It happens whenever
  // the WhatsApp Web page reloads and doesn't finish loading its JS
  // scaffolding within authTimeoutMs — common on unstable mobile data. Left
  // alone, the client is silently dead (its message hooks never
  // re-attached) with no reconnect ever triggered, so we treat it the same
  // as a real disconnect ourselves.
  if (reason === 'auth timeout') {
    handleAuthTimeout();
  }
});

const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
};

async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
    setTimeout(connectMongo, 15000);
  }
}

connectMongo();

const clientOptions = {
  authStrategy: new LocalAuth(),
  // Default is 30s, which is tight on unstable Airtel/MTN mobile data —
  // give the WhatsApp Web page more room to finish loading its JS after a
  // reload before whatsapp-web.js gives up and throws 'auth timeout'.
  authTimeoutMs: 90000,
  puppeteer: {
    executablePath: CHROMIUM_PATH,
    headless: true,
    timeout: 60000,
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-zygote'
    ],
  }
};

if (process.env.BOT_NUMBER) {
  clientOptions.pairWithPhoneNumber = {
    phoneNumber: process.env.BOT_NUMBER,
    showNotification: true,
    intervalMs: 180000,
  };
}

const client = new Client(clientOptions);

const PREFIX = process.env.BOT_PREFIX || '.';
const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

const commands = {};
const commandDir = path.join(__dirname, 'commands');

fs.readdirSync(commandDir).forEach(file => {
  if (!file.endsWith('.js')) return;
  const module = require(path.join(commandDir, file));
  Object.entries(module).forEach(([name, fn]) => {
    if (typeof fn === 'function' && !name.startsWith('_')) {
      commands[name.toLowerCase()] = fn;
    }
  });
});

console.log(`✅ Loaded ${Object.keys(commands).length} commands`);

const aliases = {
  bal: 'balance',
  wd: 'withdraw',
  dep: 'deposit',
  p: 'profile',
  inv: 'inventory',
  lb: 'leaderboard',
  s: 'sticker',
  lc: 'lendcard',
  gs: 'groupstats',
  aki: 'akinator',
  gg: 'greekgod',
  wyr: 'wouldyourather',
  pint: 'pinterest',
  reverseimg: 'sauce',
  tt: 'translate',
  tb: 'transcribe',
  quit: 'quitgame',
};

// ─── Menu content ───────────────────────────────────────────────────────────
// Data-driven on purpose: one array entry per category, one string per
// command. To add/remove a command from the menu later, edit an array below
// — no need to touch any string-building logic.
//
// NOTE: a handful of entries here (currently: .bots, .memories, .elb,
// .estats, .guilds, .pmenu, and the newer entries inside CARDS/ECONOMY/
// GAMES/FUN/DOWNLOADERS/SEARCH/AI/CONVERTER/ANIME SFW/ANIME NSFW/ADMIN
// marked "planned") are on the roadmap but don't have a handler wired up
// in commands/ yet — they'll reply "❓ Unknown command" until built. They're
// listed now so the menu doesn't need another rewrite once they land.
const MENU_SECTIONS = [
  {
    emoji: '⚙️',
    title: 'GENERAL',
    items: ['.rules', '.setrules', '.test', '.stats', '.mods', '.owner', '.bots', '.url', '.otp', '.memories'],
  },
  {
    emoji: '🎴',
    title: 'CARDS',
    items: [
      '.cards', '.card', '.ci / cardinfo', '.si', '.ss',
      '.clb', '.vlb', '.tlb', '.sslb', '.mclb', '.slb',
      '.deck', '.col', '.cardshop', '.sellc', '.rc', '.vs', '.claim',
      '.sc', '.tc', '.accepttrade', '.declinetrade',
      '.lendcard / lc', '.fuse', '.wishlist', '.wishlb',
      '.auction', '.submit', '.myauc', '.remauc', '.listauc',
      '.stardust', '.anticamp',
      '.cg', '.tier', '.cs', '.myseries', '.fusion', '.resell', '.bid',
    ],
  },
  {
    emoji: '💰',
    title: 'ECONOMY',
    items: [
      '.balance / bal', '.orbs', '.ebal', '.daily',
      '.withdraw / wd', '.deposit / dep', '.donate',
      '.lottery', '.lotterylist', '.rich', '.richg',
      '.profile / p', '.edit', '.bio', '.setname', '.setage',
      '.inventory / inv', '.use', '.sell', '.buy', '.shop',
      '.dig', '.fish', '.leaderboard / lb', '.stlb', '.achievements / ach',
      '.roast', '.gamble', '.beg', '.loan', '.mycds', '.afk',
      '.rename', '.transactions', '.rob', '.shame', '.myshame', '.heist',
    ],
  },
  {
    emoji: '🎮',
    title: 'GAMES',
    items: [
      '.ttt', '.quitgame', '.c4', '.drop', '.chess', '.move',
      '.startbattle', '.attack', '.defend', '.flee',
      '.akinator / aki', '.greekgod / gg', '.wcg', '.aquiz',
    ],
  },
  {
    emoji: '🎉',
    title: 'EVENTS',
    items: ['.elb', '.estats'],
  },
  {
    emoji: '🏰',
    title: 'GUILDS',
    items: [
      '.guilds', '.guild info', '.guild create', '.guild invite',
      '.guild accept', '.guild decline', '.guild emblem',
      '.guild leave', '.guild disband', '.guild members', '.guild remove',
    ],
  },
  {
    emoji: '🎰',
    title: 'GAMBLE',
    items: ['.slots', '.cf', '.dice', '.db', '.dp', '.roulette', '.horse', '.bj', '.rr'],
  },
  {
    emoji: '🐉',
    title: 'POKÉMON',
    items: ['.pmenu'],
  },
  {
    emoji: '🎭',
    title: 'INTERACTION',
    items: [
      '.hug', '.kiss', '.slap', '.wave', '.pat', '.dance', '.sad', '.smile',
      '.laugh', '.lick', '.punch', '.jihad', '.crusade', '.kill', '.bonk',
      '.fuck', '.tickle', '.shrug', '.wank', '.kidnap',
    ],
  },
  {
    emoji: '😂',
    title: 'FUN',
    items: [
      '.gay', '.lesbian', '.simp', '.ship', '.skill', '.duality', '.gen',
      '.pov', '.social', '.relation', '.pp', '.wouldyourather / wyr',
      '.joke', '.truth', '.dare', '.td', '.uno', '.meme',
      '.shootmeme', '.coolmeme', '.sadmeme', '.triggered', '.couplepp',
    ],
  },
  {
    emoji: '⬇️',
    title: 'DOWNLOADERS',
    items: ['.ig', '.ttk', '.yt', '.x', '.fb', '.play', '.anime', '.manga', '.manhwa', '.novel'],
  },
  {
    emoji: '🔍',
    title: 'SEARCH',
    items: ['.pinterest / pint', '.sauce / reverseimg', '.wallpaper', '.lyrics', '.igstalk', '.shazam'],
  },
  {
    emoji: '🤖',
    title: 'AI',
    items: [
      '.copilot', '.gpt', '.imagine', '.upscale',
      '.translate / tt', '.transcribe / tb', '.ocr', '.tldr', '.tts',
    ],
  },
  {
    emoji: '🔄',
    title: 'CONVERTER',
    items: [
      '.sticker / s', '.take', '.toimg', '.tovid', '.tomp3', '.tovn',
      '.rotate', '.flip', '.resize', '.tourl', '.carbon', '.fancy',
    ],
  },
  {
    emoji: '🌸',
    title: 'ANIME SFW',
    items: [
      '.waifu', '.neko', '.maid', '.mori-calliope', '.raiden-shogun',
      '.oppai', '.selfies', '.uniform', '.kamisato-ayaka',
      '.yuri', '.yaoi', '.cosplay',
    ],
  },
  {
    emoji: '🔞',
    title: 'ANIME NSFW',
    items: [
      '.nsfw on/off', '.milf', '.ass', '.hentai', '.oral', '.ecchi',
      '.paizuri', '.ero', '.ehentai', '.nhentai', '.gelbooru',
    ],
  },
  {
    emoji: '🛡️',
    title: 'ADMIN',
    items: [
      '.kick', '.delete', '.antilink', '.antilink action', '.antism',
      '.warn', '.resetwarn', '.groupstats / gs', '.welcome', '.setwelcome',
      '.leave', '.setleave', '.purge', '.blacklist', '.promote', '.demote',
      '.mute', '.unmute', '.hidetag', '.tagall', '.activity', '.active',
      '.inactive', '.open', '.close', '.news',
    ],
  },
  {
    emoji: '🐾',
    title: 'PETS',
    items: ['.pet', '.pet adopt', '.pet feed', '.pet play', '.pet name'],
  },
  {
    emoji: '📬',
    title: 'FEEDBACK',
    items: ['.feedback'],
  },
];

async function sendQuickMenu(msg) {
  const header =
`╭━━★彡 *${BOT_NAME}* 彡★━━╮
┃  𖤓 Prefix: ${PREFIX}
┃  𖤓 Commands: ${Object.keys(commands).length}
╰━━━━━━━━━━━━━╯`;

  const body = MENU_SECTIONS.map(section => {
    const lines = section.items.map(item => `┣ ✦ ${item}`).join('\n');
    return `*${section.emoji} ${section.title} ${section.emoji}*\n${lines}\n┗━━━━━━━━━━━`;
  }).join('\n\n');

  const menu = `${header}\n\n${body}\n\nType *${PREFIX}<command>* to use one.`;

  await msg.reply(menu);
}

let reconnectTimer = null;
let cardDropsStarted = false;
let participantsSeeded = false;
let whatsappStarting = false;
let currentState = null;
let authTimeoutRecovering = false;

// Wait for the connection to look stable before running a command, instead of
// launching straight into a mid-reconnect window and failing. Cheap when
// already connected (returns almost immediately); only actually waits during
// the reconnect windows that cause the "r" / connection-hiccup failures.
async function waitForStableConnection(maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const state = await client.getState();
      currentState = state;
      if (state === 'CONNECTED') return true;
    } catch {
      // getState() itself can hit the same transient glitch — treat as
      // "not ready yet" and keep polling rather than aborting immediately.
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Overrides this message's own .reply() so every existing msg.reply(...) call
// anywhere in the codebase (index.js and every command file) automatically
// attempts a genuinely quoted reply instead of plain text — with no changes
// needed in any command file, since they all already call msg.reply() the
// normal way.
//
// quotedMessageId is a real whatsapp-web.js feature, but it's a currently-open
// bug upstream (github.com/pedroslopez/whatsapp-web.js issue #3259) that can
// throw under certain conditions on the current WhatsApp backend. So this
// tries the quoted version first and falls back to a plain reply if that
// throws — replies should never stop working even if quoting itself does.
function patchQuotedReply(msg) {
  msg.reply = async (content, chatId, options = {}) => {
    const targetChatId = chatId || msg.from;
    try {
      return await client.sendMessage(targetChatId, content, {
        ...options,
        quotedMessageId: msg.id._serialized
      });
    } catch (err) {
      console.error('Quoted reply failed, falling back to plain reply:', err.message);
      return client.sendMessage(targetChatId, content, options);
    }
  };
}

// whatsapp-web.js's Client.initialize() unconditionally calls
// puppeteer.launch() every time it's invoked — it never checks whether a
// browser from a previous initialize() is still alive. On Termux this bites
// us specifically: if the Node process gets killed abruptly (OOM, Android
// backgrounding/freezing the app, a hard pm2 restart) the child Chromium
// process can be left running as an orphan, still holding Chromium's own
// ProcessSingleton lock on the LocalAuth session directory. Every later
// reconnect attempt then fails immediately with "The browser is already
// running for <userDataDir>", which has nothing to do with WhatsApp auth —
// it's purely Chromium refusing to open a second instance against the same
// profile folder. Once that happens the bot is stuck in an infinite
// reconnect loop and can never get far enough to show a fresh pairing code.
function isBrowserLockError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('already running') || msg.includes('ProcessSingleton') || msg.includes('userDataDir');
}

// Best-effort recovery from that specific failure: kill any lingering
// Chromium process for our executable, then remove Chromium's own singleton
// lock artifacts from the session directory. Both steps are safe no-ops if
// there's nothing to clean up, so this never hurts a normal reconnect.
function recoverFromBrowserLock() {
  try {
    execSync(`pkill -9 -f "${CHROMIUM_PATH}"`, { stdio: 'ignore' });
    console.log('🧹 Killed lingering Chromium process(es)');
  } catch {
    // No matching process, or pkill isn't installed — nothing to clean up.
  }

  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(SESSION_DIR, lockFile);
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        console.log(`🧹 Removed stale ${lockFile}`);
      }
    } catch (e) {
      console.error(`Could not remove ${lockFile}:`, e.message);
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

// Recovery path for the 'auth timeout' rejection handled above. The page is
// stuck (its JS never finished loading), so we tear the browser down and
// let the existing reconnect machinery bring up a fresh one — it'll reuse
// the saved session on disk, so this does not require a new pairing code.
async function handleAuthTimeout() {
  if (authTimeoutRecovering) return;
  authTimeoutRecovering = true;
  whatsappStarting = false;

  console.log('🔁 Recovering from auth timeout (page got stuck reloading)...');
  try {
    // destroy() talks to a page that may itself be unresponsive, so it's
    // bounded here — if it doesn't finish quickly, fall back to force-killing
    // the browser process directly so we're never stuck waiting on it.
    await withTimeout(client.destroy(), 15000);
  } catch (err) {
    console.error('Clean destroy did not finish in time, forcing cleanup:', err.message);
    recoverFromBrowserLock();
  }

  authTimeoutRecovering = false;
  scheduleReconnect('auth-timeout');
}

function scheduleReconnect(reason) {
  console.log('❌ WhatsApp disconnected:', reason);

  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      console.log('🔄 Reinitializing client in 5 seconds...');
      whatsappStarting = true;
      await client.initialize();
    } catch (err) {
      console.error('Reconnect failed:', err);
      whatsappStarting = false;
      if (isBrowserLockError(err)) {
        console.log('🔒 Detected a stuck browser lock — cleaning up before retrying...');
        recoverFromBrowserLock();
      }
      scheduleReconnect('reconnect-failed');
    }
  }, 5000);
}

async function startWhatsApp() {
  if (whatsappStarting) return;
  whatsappStarting = true;

  try {
    await client.initialize();
  } catch (err) {
    console.error('❌ WhatsApp initialize failed:', err.message);
    whatsappStarting = false;
    if (isBrowserLockError(err)) {
      console.log('🔒 Detected a stuck browser lock — cleaning up before retrying...');
      recoverFromBrowserLock();
    }
    setTimeout(startWhatsApp, 10000);
  }
}

client.on('code', (code) => {
  console.log('');
  console.log('╔════════════════════════════════╗');
  console.log(`  🔗 Pairing code: ${code}`);
  console.log('  Enter in WhatsApp: Settings →');
  console.log('  Linked Devices → Link with phone');
  console.log('  number instead');
  console.log('╚════════════════════════════════╝');
  console.log('');
});

client.on('qr', qr => {
  console.log('📱 Or scan this QR code:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('loading_screen', (percent, message) => {
  console.log(`Loading ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
  console.log('📡 State:', state);
  currentState = state;
});

client.on('disconnected', (reason) => {
  whatsappStarting = false;
  scheduleReconnect(reason);
});

client.on('error', (err) => {
  console.error('Client error:', err);
});

client.on('ready', () => {
  whatsappStarting = false;

  console.log(`
╭━━★彡 ${BOT_NAME} is ONLINE 彡★━━╮
┃  Prefix : ${PREFIX}
┃  Commands: ${Object.keys(commands).length}
╰━━━━━━━━━━━━━━━━━━━━━━╯
  `);

  if (!cardDropsStarted) {
    cardDropsStarted = true;
    const { _initCardDrops } = require('./commands/cards');
    if (_initCardDrops) {
      _initCardDrops(client).catch(err => console.error('Card drop resume error:', err.message));
    }
  }

  if (!participantsSeeded) {
    participantsSeeded = true;
    const { _seedParticipants } = require('./commands/admin');
    if (_seedParticipants) {
      _seedParticipants(client).catch(err => console.error('Participant snapshot error:', err.message));
    }
  }
});

// ─── Task ID + activity tracking (for detailed console logging) ───────────────
// Every prefixed message gets its own sequential Task ID here — whether or
// not it turns out to match a real command, and even if the same person
// fires off several commands back-to-back. Counter is in-memory only, so it
// restarts from 1 each time the bot restarts (which happens fairly often via
// PM2), rather than trying to persist it in Mongo.
let taskIdCounter = 0;
function nextTaskId() {
  return ++taskIdCounter;
}

// How many commands are currently "in flight" (received but not yet finished
// executing) across the whole bot, regardless of chat. This is a general
// system-load number used only for the "Position at queue" console log line
// — it is NOT the same thing as the heavy-command queue position below.
let inFlightCount = 0;

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Set to false if the getContact()/getChat() lookups below ever feel like
// they're adding too much lag on a bad-network day — the log lines will
// still print, just with raw WhatsApp IDs instead of resolved names.
const LOG_FETCH_CONTEXT = true;

async function getSenderName(msg) {
  if (!LOG_FETCH_CONTEXT) return (msg.author || msg.from || '').split('@')[0] || 'Unknown';
  return resolveSenderName(msg, client);
}

async function getChatLabel(msg) {
  if (!msg.from.endsWith('@g.us')) return 'DM';
  if (!LOG_FETCH_CONTEXT) return msg.from;
  try {
    const chat = await safeGetChat(msg, 1); // 1 retry — a bare 0 was falling back to the raw ID on any single flaky-connection hiccup
    return chat?.name || msg.from;
  } catch {
    return msg.from;
  }
}

// ─── Heavy command classification ──────────────────────────────────────────────
// Commands that hit an external API, download/convert media, or otherwise do
// real work beyond a quick DB read/write. These get queued globally and
// processed one at a time instead of running immediately, so a burst of
// people using them at once (e.g. in a busy group) can't pile up and choke
// the phone's CPU/bandwidth all at once.
//
// This list is based on what's currently in commands/downloaders.js,
// commands/converter.js, commands/ai.js and commands/search.js. Add or
// remove command names here freely if a command should move between
// "normal" and "heavy" — nothing else in the file needs to change.
const HEAVY_COMMANDS = new Set([
  // downloaders.js — network fetch + media download
  'ig', 'ttk', 'yt', 'x', 'fb', 'play',
  // converter.js — ffmpeg / media processing
  'sticker', 'take', 'toimg', 'tovid', 'rotate', 'tomp3', 'tovn', 'flip', 'resize', 'tourl',
  // fun.js — ffmpeg + headless-browser caption rendering
  'meme',
  // ai.js — external AI/API calls
  'copilot', 'gpt', 'imagine', 'upscale', 'translate', 'transcribe', 'tts',
  // search.js — external API/scraping calls
  'pinterest', 'sauce', 'wallpaper', 'lyrics',
]);

// ─── Global serial queue for heavy commands ────────────────────────────────────
// Separate from the per-chat queue below. The per-chat queue keeps messages
// within ONE chat in order; this queue makes sure heavy commands from ANY
// chat run one-at-a-time across the whole bot, so the phone never has to
// run several ffmpeg/API jobs at once.
const heavyQueue = [];
let heavyBusy = false;

// Pushes a task and returns the 1-based position it just took (includes
// itself) — used for the "Your position at queue" reply to the user.
//
// The position is computed and the task pushed in the same synchronous step
// (no `await` in between), which matters: without that, two heavy commands
// arriving from two different chats at nearly the same moment could both
// read the same queue length before either had actually reserved a slot,
// and both would be told they're "1st".
function enqueueHeavyTask(task) {
  const position = heavyQueue.length + (heavyBusy ? 1 : 0) + 1;
  heavyQueue.push(task);
  // setImmediate (not a direct call) so an empty queue doesn't start running
  // the task synchronously right here — that would let its "Executing
  // command" log line race ahead of the caller's own queue-acknowledgment
  // reply, which hasn't been sent yet at this point.
  setImmediate(runHeavyQueue);
  return position;
}

async function runHeavyQueue() {
  if (heavyBusy) return;
  heavyBusy = true;
  while (heavyQueue.length > 0) {
    const task = heavyQueue.shift();
    try {
      await task();
    } catch (err) {
      console.error('💥 Heavy queue task crashed:', err);
    }
  }
  heavyBusy = false;
}

// Per-chat command queue
const commandQueues = new Map();

function enqueueCommand(chatId, task) {
  const previous = commandQueues.get(chatId) || Promise.resolve();

  const next = previous
    .then(task)
    .catch(err => console.error('Queue error:', err))
    .finally(() => {
      if (commandQueues.get(chatId) === next) {
        commandQueues.delete(chatId);
      }
    });

  commandQueues.set(chatId, next);
  return next;
}

client.on('message', (msg) => {
  enqueueCommand(msg.from, async () => {
  try {
    // Never process messages the bot's own account sent — whether typed
    // manually in "Message Yourself" or sent by the bot itself. In current
    // whatsapp-web.js this event generally doesn't fire for self-sent
    // messages anyway (they go through message_create instead), but this
    // costs nothing and protects against any future/edge-case behavior.
    if (msg.fromMe) return;

    patchQuotedReply(msg);

    const body = msg.body || '';

    const stable = await waitForStableConnection();
    if (!stable) {
      if (body.startsWith(PREFIX)) {
        await msg.reply('⚠️ WhatsApp connection is unstable right now — please try again in a moment.');
      }
      return;
    }

    if (!body.startsWith(PREFIX)) {
      const mentionsBot = msg.mentionedIds &&
        msg.mentionedIds.includes(client.info.wid._serialized);

      let repliedToBot = false;
      if (!mentionsBot && msg.hasQuotedMsg) {
        const quoted = await safeGetQuotedMessage(msg).catch(() => null);
        repliedToBot = quoted ? quoted.fromMe : false;
      }

      if (mentionsBot || repliedToBot) {
        return await sendQuickMenu(msg);
      }
      return;
    }

    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    let command = args.shift().toLowerCase();

    if (aliases[command]) command = aliases[command];

    // ── Task ID + logging context ──────────────────────────────────────────
    // Assigned as soon as we know a command was *attempted*, whether or not
    // it turns out to resolve to a real handler below.
    const taskId = nextTaskId();
    const receivedAt = new Date().toLocaleString();
    const [senderName, chatLabel] = await Promise.all([getSenderName(msg), getChatLabel(msg)]);

    const queuePosition = inFlightCount + 1;
    inFlightCount++;

    console.log(`📨 Command received: ${command} by ${senderName}, ${chatLabel} at ${receivedAt}`);
    console.log(`🆔 Task ID: ${taskId}`);
    console.log(`👥 Position at queue: ${ordinal(queuePosition)}`);

    // ── Resolve the handler — same routing as before, just captured into a
    // closure instead of returning immediately, so it can be logged/queued
    // uniformly below. Order and shift() timing match the original exactly.
    let handlerFn = null;

    if (command === 'menu' || command === 'help') {
      handlerFn = () => sendQuickMenu(msg);
    }

    if (!handlerFn && command === 'antilink' && args[0]?.toLowerCase() === 'action') {
      args.shift();
      if (commands['antilinkaction']) {
        handlerFn = () => commands['antilinkaction'](client, msg, args);
      }
    }

    if (!handlerFn && command === 'guild' && args.length > 0) {
      const sub = `guild_${args.shift().toLowerCase()}`;
      if (commands[sub]) {
        handlerFn = () => commands[sub](client, msg, args);
      }
    }

    if (!handlerFn && command === 'pet' && args.length > 0) {
      const sub = `pet_${args[0].toLowerCase()}`;
      if (commands[sub]) {
        args.shift();
        handlerFn = () => commands[sub](client, msg, args);
      }
    }

    if (!handlerFn && commands[command]) {
      handlerFn = () => commands[command](client, msg, args);
    }

    if (!handlerFn) {
      console.log(`❌ Failed to execute command: Unknown command "${command}"`);
      inFlightCount = Math.max(0, inFlightCount - 1);
      return await msg.reply(`❓ Unknown command: *${PREFIX}${command}*\nType *${PREFIX}menu* to see what's available.`);
    }

    // ── AFK welcome-back ────────────────────────────────────────────────────
    // Runs for every recognized command, before it executes, so someone
    // coming back from AFK always sees the welcome-back message first and
    // their command's own response right after — not the other way around.
    try {
      const contact = await safeGetContact(msg);
      const { _checkAfkReturn } = require('./commands/afk');
      await _checkAfkReturn(msg, contact.id._serialized);
    } catch (err) {
      console.error('AFK check failed:', err.message);
    }

    const isHeavy = HEAVY_COMMANDS.has(command);

    if (isHeavy) {
      // Heavy commands: reserve a spot in the global queue *first* (that's
      // the atomic, race-free part — see enqueueHeavyTask), then return
      // right away so this chat's own message queue isn't blocked waiting
      // on it. The actual execution/logging inside the queued task below is
      // unchanged — only what happens in-chat right here changed.
      const heavyPosition = enqueueHeavyTask(async () => {
        console.log(`Executing command (Task ID: ${taskId})`);
        try {
          await handlerFn();
          console.log(`Command executed and replied to ${senderName} successfully at ${new Date().toLocaleString()}`);
        } catch (err) {
          console.error(`Failed to execute command: ${err.message}`);
          try {
            await msg.reply('❌ An error occurred while processing your request. Please try again.');
          } catch {}
        } finally {
          inFlightCount = Math.max(0, inFlightCount - 1);
        }
      });

      // No more "Command received / Task ID / position" text sent to the
      // chat — the queue system itself is unchanged, this position is just
      // logged now instead of messaged, same as Task ID already is above.
      console.log(`🕒 Heavy queue position: ${ordinal(heavyPosition)} (Task ID: ${taskId})`);

      // In-chat acknowledgment is now a reaction instead of text: ▶️
      // specifically for .play (matches the "now queued to play" moment),
      // ⏳ for every other heavy/queued command.
      try {
        await msg.react(command === 'play' ? '▶️' : '⏳');
      } catch (err) {
        console.error('Failed to react to queued command:', err.message);
      }

      return;
    }

    // Normal commands: run immediately, same as before.
    console.log('Executing command');
    try {
      await handlerFn();
      console.log(`Command executed and replied to ${senderName} successfully at ${new Date().toLocaleString()}`);
    } catch (err) {
      console.error(`Failed to execute command: ${err.message}`);
      await msg.reply('❌ An error occurred. Please try again.');
    } finally {
      inFlightCount = Math.max(0, inFlightCount - 1);
    }
} catch (err) {
  console.error('Command error:', err);
  await msg.reply('❌ An error occurred. Please try again.').catch(() => {});
}
  });
});

client.on('group_join', async (notification) => {
  try {
    const { commands: cmds } = require('./commands/admin');
    if (cmds && cmds.onJoin) await cmds.onJoin(client, notification);
  } catch (err) {
    console.error('group_join error:', err.message);
  }
});

client.on('group_leave', async (notification) => {
  try {
    const { commands: cmds } = require('./commands/admin');
    if (cmds && cmds.onLeave) await cmds.onLeave(client, notification);
  } catch (err) {
    console.error('group_leave error:', err.message);
  }
});

client.on('message', async (msg) => {
  try {
    if (!msg.from.endsWith('@g.us')) return;

    // Every other place in this codebase that reads or writes a Group
    // document (admin.js, anime.js, cards.js, the antilink listener just
    // below this one) looks it up by chat.id._serialized from
    // msg.getChat() — this was the one exception, using the raw msg.from
    // field directly instead. If msg.from ever canonicalizes differently
    // than chat.id._serialized for this account (the same class of id
    // inconsistency already found and fixed for senders — see the comment
    // below), this was silently writing every message's activity into a
    // completely different, orphaned Group document that nothing else in
    // the bot ever reads — no errors anywhere, since the write itself
    // always succeeded, just against the wrong document.
    const chat = await safeGetChat(msg);

    // Raw msg.author/msg.from can also be in a different id format (@lid vs
    // phone-number) than chat.participants[].id._serialized uses — WhatsApp's
    // internal store can canonicalize ids differently depending on the path
    // taken to get there. .inactive (and anything else that cross-references
    // this log against the participant list) needs an exact string match, so
    // we resolve through getContact() here — the same approach isAdmin()
    // already relies on for its own participant matching elsewhere in this
    // codebase — instead of trusting the raw field directly.
    const contact = await safeGetContact(msg);
    const senderId = contact.id._serialized;

    const Group = require('./models/Group');

    // messageCount is a plain top-level Number, so it's always safe to bump
    // atomically with $inc.
    //
    // activityLog is NOT safe to touch the same way. WhatsApp ids like
    // "234801234567@c.us" contain a literal ".", and Mongo's update-operator
    // dot-path syntax splits on every "." to address nested fields. Building
    // the update path as a string — `activityLog.${senderId}` — silently
    // turned "activityLog.234801234567@c.us" into the nested path
    // activityLog -> "234801234567@c" -> "us", writing an object like
    // { us: 19 } instead of a plain number. That corrupts the Map (schema is
    // `Map of Number`) and made every later .save() on that Group document —
    // .setrules, antilink toggles, welcome/leave messages, anything — fail
    // with a "Cast to Number failed ... at path activityLog.$*" validation
    // error, since Mongoose validates the whole Map on every save.
    //
    // Fix: bump messageCount atomically, then update activityLog through
    // Mongoose's own Map API (group.activityLog.set(...)) and save() the
    // document instead of a dot-delimited update-path string.
    //
    // One more wrinkle: Mongoose's Map type hard-rejects ANY key containing
    // "." the moment it's fully cast (.set() on a document, or a $set
    // update) — it throws 'Mongoose maps do not support keys that contain
    // "."'. That's stricter than what let the original bug's raw $inc path
    // slip a corrupted entry in, so a real WhatsApp id can never be stored
    // as a literal Map key at all. encodeIdKey() swaps "." for "~" (which
    // never appears in a WhatsApp id) before it touches the Map; decode it
    // back with decodeIdKey() anywhere a key needs to be treated as a real
    // id again (see .activity/.inactive in commands/admin.js).
    const group = await withRetry(() => Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { $inc: { messageCount: 1 } },
      { upsert: true, new: true }
    ));

    const key = encodeIdKey(senderId);
    const currentCount = group.activityLog.get(key) || 0;
    group.activityLog.set(key, currentCount + 1);
    group.markModified('activityLog');
    await withRetry(() => group.save());
  } catch (err) {
    console.error('Activity tracking error:', err.message);
  }
});

client.on('message', async (msg) => {
  try {
    // Cheap checks first — most messages never reach getChat()/DB at all.
    if (!msg.from.endsWith('@g.us')) return;
    if (!msg.body) return;

    const hasLink = /(https?:\/\/|wa\.me|chat\.whatsapp\.com)/i.test(msg.body);
    if (!hasLink) return;

    let chat;
    try {
      chat = await msg.getChat();
    } catch (err) {
      console.error('Antilink: could not get chat, skipping:', err.message);
      return;
    }
    if (!chat.isGroup) return;

    const Group = require('./models/Group');
    const group = await Group.findOne({ id: chat.id._serialized });
    if (!group?.antilink) return;

    const contact = await msg.getContact();
    const isAdmin = chat.participants.some(
      p => p.id._serialized === contact.id._serialized && p.isAdmin
    );
    if (isAdmin) return;

    const action = group.antilinkAction || 'warn';

    if (action === 'kick') {
      try {
        await chat.removeParticipants([contact.id._serialized]);
        await msg.reply(
          `🚫 @${contact.id.user} was kicked for sending a link.`,
          undefined,
          { mentions: [contact.id._serialized] }
        );
      } catch (err) {
        console.error('Antilink: kick failed:', err.message);
        await msg.reply(
          `⚠️ @${contact.id.user} sent a link but couldn't be kicked (am I an admin?).`,
          undefined,
          { mentions: [contact.id._serialized] }
        );
      }
    } else {
      await msg.reply(
        `⚠️ @${contact.id.user} don't send links here!`,
        undefined,
        { mentions: [contact.id._serialized] }
      );
    }

    try {
      await msg.delete(true);
    } catch (err) {
      console.error('Antilink: delete failed:', err.message);
    }
  } catch (err) {
    console.error('Antilink error:', err.stack || err.message || err);
  }
});

setInterval(() => {
  try {
    console.log(`💚 Heartbeat: ${new Date().toLocaleString()}`);
  } catch (err) {
    console.error('Heartbeat error:', err.message);
  }
}, 60000);

startWhatsApp();
