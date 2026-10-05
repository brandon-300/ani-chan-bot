require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeGetQuotedMessage, safeGetChat, safeGetContact, resolveSenderName, withRetry, decodeIdKey, isOwner, isMod, buildRegistrationIntroText, buildRegistrationProgressText } = require('./utils/helpers');
const { BOT_NAME, MENU_IMAGE_URL, BOT_PREFIX, AI_CALL_NAMES_OVERRIDE } = require('./utils/config');
const { getActivePersonaSafe } = require('./utils/persona');
const aiStickers = require('./utils/aiStickers');
const { instrumentHttpClients, wrapWithUsageTracking } = require('./utils/usageTracking');
const logger = require('./utils/logger');
const geminiGate = require('./utils/geminiGate');
const aiReactions = require('./utils/aiReactions');
const { tryHandleQuizAnswer } = require('./commands/games/quiz');
const AiConversation = require('./models/AiConversation');
const aiConversations = require('./utils/aiConversations');
const GroupActivity = require('./models/GroupActivity');

// Installed as early as possible, before any command file's axios/fetch
// calls could ever fire — see utils/usageTracking.js for what this
// actually does (auto-counts outbound API calls per command, for .stats).
instrumentHttpClients();

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

// One-time, idempotent migration: seeds GroupActivity (models/GroupActivity.js)
// from whatever's already in each Group's old activityLog Map, so switching
// the per-user message counter over to the new collection doesn't silently
// reset everyone's existing activity stats back to zero.
//
// Uses $setOnInsert — never $inc or a plain $set on count — specifically so
// this is safe to run on every single restart, not just the first one: a
// GroupActivity row that already exists (because real activity has landed
// there since this first ran) is left completely alone. Only a row that's
// never been created at all gets seeded from the old Map's frozen snapshot.
// Nothing writes to activityLog anymore as of this change (see index.js's
// message handler), so that snapshot only ever needs seeding once per
// (group, user) pair, no matter how many times this function itself runs.
async function migrateGroupActivityLog() {
  const Group = require('./models/Group');
  const groups = await Group.find({ activityLog: { $exists: true, $ne: {} } })
    .select('id activityLog updatedAt');

  for (const group of groups) {
    for (const [encodedKey, count] of group.activityLog) {
      if (!count) continue;
      await GroupActivity.findOneAndUpdate(
        { groupId: group.id, userId: decodeIdKey(encodedKey) },
        { $setOnInsert: { count, lastAt: group.updatedAt || new Date() } },
        { upsert: true }
      ).catch(err => {
        console.error(`⚠️  GroupActivity migration failed for ${group.id}:`, err.message);
      });
    }
  }
}

async function connectMongo() {
  const operation = logger.start('background.mongo_connect', { retryDelayMs: 15000 });
  try {
    await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    operation.finish('success', { readyState: mongoose.connection.readyState });
    console.log('✅ MongoDB connected');

    // Sticker metadata is rebuilt from Mongo only after the connection is
    // live. This is best-effort and must never block WhatsApp/non-AI startup.
    aiStickers.initialize().catch(err => {
      logger.error('background.ai_sticker_metadata_startup.failed', err);
    });

    // AI conversations are now one per (chat, sender, PERSONA). Two one-time,
    // self-healing steps, safe to repeat on every start, in this order:
    //   1. Conversations saved before personas were part of the key have no
    //      personaId; they become the active persona's conversation and get the
    //      new 7-day expiry (or none, for the owner).
    //   2. syncIndexes() drops the old unique (chatId, senderId) index, which
    //      would otherwise block a second persona's conversation with the same
    //      person, and builds the new unique (chatId, senderId, personaId) one.
    // No manual mongosh/Atlas step. A failure is logged and is not fatal to startup.
    (async () => {
      try {
        await aiConversations.migrateLegacyConversations(getActivePersonaSafe()?.id);
      } catch (err) {
        logger.error('background.ai_conversation_migration.failed', err);
      }
      try {
        await AiConversation.syncIndexes();
        logger.write('INFO', 'ai.history.indexes.synced', {});
      } catch (err) {
        logger.error('background.ai_conversation_indexes.failed', err);
      }
    })();

    // See migrateGroupActivityLog()'s own comment — safe to run on every
    // restart, not fatal to startup if it fails.
    migrateGroupActivityLog().catch(err => {
      logger.error('background.group_activity_migration.failed', err);
    });
  } catch (err) {
    operation.finish('failed', { error: err });
    logger.error('background.mongo_connect.retry_scheduled', err, { retryDelayMs: 15000 });
    setTimeout(() => connectMongo(), 15000);
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

// ─── Shared "already handled" gate ────────────────────────────────────────────
// This bot also exists as a Baileys version on the SAME WhatsApp account, and
// whichever version was switched off is re-sent every message it missed when it
// starts again. Each incoming message id is claimed in MongoDB (utils/messageClaims.js)
// by the first version that sees it, so a message the other version already
// answered is dropped here, before ANY of the 'message' listeners below run.
// Messages are passed on strictly in arrival order; a claim failure lets the
// message through (see messageClaims.js).
require('./utils/messageClaims').gateClientMessages(client);

const PREFIX = BOT_PREFIX;

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
  ulc: 'unlendcard',
  gs: 'groupstats',
  aki: 'akinator',
  gg: 'greekgod',
  wyr: 'wouldyourather',
  pint: 'pinterest',
  reverseimg: 'sauce',
  tt: 'translate',
  tb: 'transcribe',
  quit: 'quitgame',
  fusion: 'fuse',
  bid: 'submit',
  setbio: 'bio',
};

// ─── Menu content ───────────────────────────────────────────────────────────
// Sourced from utils/commandReference.js — the single source of truth
// shared with README.md's command tables. See that file's header comment
// for why: editing a copy here that could drift from the README (or vice
// versa) is exactly the kind of staleness this project has hit before
// (e.g. the pinned ani-chan-bot-commands.txt reference file going stale).
const { COMMAND_REFERENCE } = require('./utils/commandReference');

// Reduces one COMMAND_REFERENCE `cmd` field down to just its bare, invocable
// ".command" form(s) for the in-chat menu — no descriptions, no argument
// placeholders. " / " (with spaces) separates genuinely distinct commands or
// aliases (".mute / .unmute", ".balance / .bal") and each becomes its own
// line; a bare "/" with no surrounding spaces is an argument placeholder
// (".loan request/repay/status", "[warn/kick]") and is dropped instead. A
// second word is kept only when it reads as part of the command itself
// (".guild info", ".pet adopt") — stripped as soon as a token looks like an
// argument: bracketed, an "@mention", contains a slash, or is ALL-CAPS.
function extractMenuCommands(cmdField) {
  return cmdField.split(' / ').map(variant => {
    const tokens = variant.trim().split(/\s+/);
    const kept = [tokens[0]];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('[') || t.startsWith('@') || t.startsWith('(') || t.startsWith('<') || t.includes('/') || /^[A-Z0-9_-]+$/.test(t)) break;
      kept.push(t);
    }
    return kept.join(' ');
  });
}

async function sendQuickMenu(msg) {
  const header =
`╭━━★彡 *${BOT_NAME}* 彡★━━╮
┃  𖤓 Prefix: ${PREFIX}
┃  𖤓 Commands: ${Object.keys(commands).length}
╰━━━━━━━━━━━━━╯`;

  const body = COMMAND_REFERENCE.map(section => {
    // Several items document more than one usage of the same command
    // (".chess @user" / ".chess [easy|medium|hard]" / ...) — once reduced
    // to bare commands those collapse to the same line, so dedupe per
    // section rather than showing ".chess" three times in a row.
    const seen = new Set();
    const cmds = [];
    for (const item of section.items) {
      const variants = extractMenuCommands(item.cmd);

      // Group variants that are TRUE aliases of each other (registered in
      // the `aliases` map above — e.g. inv -> inventory) onto one line, so
      // ".inventory" and ".inv" show as a single "┣ ✦ .inventory / .inv"
      // instead of two separate bullets that look like different things to
      // try when they're the exact same command under the hood. Variants
      // that AREN'T aliases of one another (".mute"/".unmute",
      // ".hug"/".kiss"/...) are genuinely different commands and still get
      // their own line each — unchanged from before.
      const bareNameOf = v => v.split(/\s+/)[0].slice(1).toLowerCase();
      const areAliasPair = (a, b) => aliases[bareNameOf(a)] === bareNameOf(b) || aliases[bareNameOf(b)] === bareNameOf(a);

      const groups = [];
      for (const variant of variants) {
        const existingGroup = groups.find(g => g.some(v => areAliasPair(v, variant)));
        if (existingGroup) existingGroup.push(variant);
        else groups.push([variant]);
      }

      for (const group of groups) {
        const cmd = group.join(' / ');
        if (!seen.has(cmd)) {
          seen.add(cmd);
          cmds.push(cmd);
        }
      }
    }
    const lines = cmds.map(cmd => `┣ ✦ ${cmd}`).join('\n');
    return `*${section.emoji} ${section.title} ${section.emoji}*\n${lines}\n┗━━━━━━━━━━━`;
  }).join('\n\n');

  const menu = `${header}\n\n${body}\n\nType *${PREFIX}<command>* to use one.`;

  // One message: image with the full menu as its caption, matching the
  // reference bot. WhatsApp's ~1,024-char image-caption cap that's widely
  // documented is specifically for the Business/Cloud API (templates,
  // programmatic sends) — not confirmed to apply to the regular consumer
  // protocol whatsapp-web.js automates here, and the reference bot sending
  // a caption this long in one piece is real evidence it doesn't. If a
  // future .menu run ever comes back visibly cut off mid-category, that's
  // the signal this assumption was wrong and it needs splitting into a
  // short-caption image + separate full-text message instead.
  //
  // Image source: the bot's own WhatsApp profile picture when it has one,
  // falling back to MENU_IMAGE_URL (utils/config.js) otherwise. That
  // fallback is a plain URL read from .env, not touched by any logic
  // here, so swapping the image later is just editing MENU_IMAGE_URL —
  // this function never needs to change for that.
  let imageUrl;
  try {
    imageUrl = await client.getProfilePicUrl(client.info.wid._serialized);
  } catch (err) {
    console.error('Menu: failed to fetch bot profile picture, using fallback image:', err.message);
  }
  if (!imageUrl) imageUrl = MENU_IMAGE_URL;

  try {
    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
    await msg.reply(media, undefined, { caption: menu });
  } catch (err) {
    console.error('Menu: failed to send menu image, falling back to text only:', err.message);
    await msg.reply(menu);
  }
}

// The AI may request the real source-of-truth menu through this callback; it
// never invents or maintains a second command list.
client.sendQuickMenu = (msg) => sendQuickMenu(msg);

let backgroundTaskCounter = 0;

async function runLoggedBackgroundTask(name, details, fn) {
  const taskId = `bg-${++backgroundTaskCounter}`;
  return logger.run(`background.${name}`, { taskId, ...details }, fn);
}

let reconnectTimer = null;
let cardDropsStarted = false;
let participantsSeeded = false;
let catalogueGrowthStarted = false;
let mutesResumeStarted = false;
let schedulerStarted = false;
let afkInitStarted = false;
let tttInitStarted = false;
let c4InitStarted = false;
let battleInitStarted = false;
let chessInitStarted = false;
let quizInitStarted = false;
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
  logger.write('WARN', 'background.whatsapp_auth_timeout.recovery_started');

  console.log('🔁 Recovering from auth timeout (page got stuck reloading)...');
  try {
    // destroy() talks to a page that may itself be unresponsive, so it's
    // bounded here — if it doesn't finish quickly, fall back to force-killing
    // the browser process directly so we're never stuck waiting on it.
    await withTimeout(client.destroy(), 15000);
  } catch (err) {
    logger.error('background.whatsapp_auth_timeout.destroy_failed', err);
    console.error('Clean destroy did not finish in time, forcing cleanup:', err.message);
    recoverFromBrowserLock();
  }

  authTimeoutRecovering = false;
  scheduleReconnect('auth-timeout');
}

function scheduleReconnect(reason) {
  console.log('❌ WhatsApp disconnected:', reason);

  if (reconnectTimer) return;

  logger.write('INFO', 'background.whatsapp_reconnect.armed', { reason, delayMs: 5000 });
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const operation = logger.start('background.whatsapp_reconnect', { reason });
    try {
      whatsappStarting = true;
      await client.initialize();
      operation.finish('success');
    } catch (err) {
      operation.finish('failed', { error: err });
      logger.error('background.whatsapp_reconnect.failed', err, { reason });
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
    logger.error('background.whatsapp_initialization.failed', err);
    whatsappStarting = false;
    if (isBrowserLockError(err)) {
      console.log('🔒 Detected a stuck browser lock — cleaning up before retrying...');
      recoverFromBrowserLock();
    }
    setTimeout(startWhatsApp, 10000);
  }
}

client.on('code', (code) => {
  logger.write('INFO', 'whatsapp.pairing_code.presented', { codeLength: String(code || '').length });
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
  logger.write('INFO', 'whatsapp.qr.presented', { qrLength: String(qr || '').length });
  console.log('📱 Or scan this QR code:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  logger.write('INFO', 'whatsapp.authenticated');
  console.log('✅ WhatsApp authenticated');
});

client.on('auth_failure', (msg) => {
  logger.error('whatsapp.auth_failure', new Error(String(msg || 'unknown authentication failure')));
  console.error('❌ Authentication failed:', msg);
});

client.on('loading_screen', (percent, message) => {
  logger.debug('whatsapp.loading', { percent, message });
  console.log(`Loading ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
  logger.write('INFO', 'whatsapp.state_changed', { state });
  console.log('📡 State:', state);
  currentState = state;
});

client.on('disconnected', (reason) => {
  logger.write('WARN', 'whatsapp.disconnected', { reason });
  whatsappStarting = false;
  scheduleReconnect(reason);
});

client.on('error', (err) => {
  logger.error('whatsapp.client_error', err);
  console.error('Client error:', err);
});

client.on('ready', () => {
  whatsappStarting = false;
  logger.write('INFO', 'whatsapp.ready', { commandCount: Object.keys(commands).length });
  runLoggedBackgroundTask('ai_sticker_library_startup', {}, () => aiStickers.initialize())
    .catch(err => logger.error('background.ai_sticker_library_startup.failed', err));

  console.log(`
╭━━★彡 ${BOT_NAME} is ONLINE 彡★━━╮
┃  Prefix : ${PREFIX}
┃  Commands: ${Object.keys(commands).length}
╰━━━━━━━━━━━━━━━━━━━━━━╯
  `);

  if (!schedulerStarted) {
    schedulerStarted = true;
    const scheduler = require('./utils/scheduler');
    // Arms the nearest task that survived a PM2 restart (if any), then
    // backfills a scheduled task for any card that was already mid-lend
    // BEFORE this scheduler existed — see _initCardLending's own comment
    // in commands/cards.js for why that backfill matters.
    runLoggedBackgroundTask('scheduler_init', {}, () => scheduler.init(client))
      .then(() => {
        const { _initCardLending } = require('./commands/cards');
        if (_initCardLending) return _initCardLending();
      })
      .catch(err => logger.error('background.scheduler_init.failed', err));
  }

  if (!cardDropsStarted) {
    cardDropsStarted = true;
    const { _initCardDrops } = require('./commands/cards');
    if (_initCardDrops) {
      runLoggedBackgroundTask('card_drop_restore', {}, () => _initCardDrops(client)).catch(err => logger.error('background.card_drop_restore.failed', err));
    }
  }

  if (!participantsSeeded) {
    participantsSeeded = true;
    const { _seedParticipants } = require('./commands/admin');
    if (_seedParticipants) {
      runLoggedBackgroundTask('participant_seed', {}, () => _seedParticipants(client)).catch(err => logger.error('background.participant_seed.failed', err));
    }
  }

  if (!catalogueGrowthStarted) {
    catalogueGrowthStarted = true;
    const { _initCatalogueGrowth } = require('./commands/cardmanager');
    if (_initCatalogueGrowth) {
      runLoggedBackgroundTask('catalogue_growth_restore', {}, () => _initCatalogueGrowth(client)).catch(err => logger.error('background.catalogue_growth_restore.failed', err));
    }
  }

  if (!mutesResumeStarted) {
    mutesResumeStarted = true;
    const { _resumePendingMutes } = require('./commands/admin');
    if (_resumePendingMutes) {
      runLoggedBackgroundTask('mute_restore', {}, () => _resumePendingMutes(client)).catch(err => logger.error('background.mute_restore.failed', err));
    }
  }

  if (!afkInitStarted) {
    afkInitStarted = true;
    const { _initAfk } = require('./commands/afk');
    if (_initAfk) {
      runLoggedBackgroundTask('afk_restore', {}, () => _initAfk()).catch(err => logger.error('background.afk_restore.failed', err));
    }
  }

  if (!tttInitStarted) {
    tttInitStarted = true;
    const { _initTTT } = require('./commands/games/tictactoe');
    if (_initTTT) {
      runLoggedBackgroundTask('ttt_restore', {}, () => _initTTT(client)).catch(err => logger.error('background.ttt_restore.failed', err));
    }
  }

  if (!c4InitStarted) {
    c4InitStarted = true;
    const { _initC4 } = require('./commands/games/connect4');
    if (_initC4) {
      runLoggedBackgroundTask('connect4_restore', {}, () => _initC4(client)).catch(err => logger.error('background.connect4_restore.failed', err));
    }
  }

  if (!battleInitStarted) {
    battleInitStarted = true;
    const { _initBattle } = require('./commands/games/battle');
    if (_initBattle) {
      runLoggedBackgroundTask('battle_restore', {}, () => _initBattle()).catch(err => logger.error('background.battle_restore.failed', err));
    }
  }

  if (!chessInitStarted) {
    chessInitStarted = true;
    const { _initChess } = require('./commands/games/chess');
    if (_initChess) {
      runLoggedBackgroundTask('chess_restore', {}, () => _initChess(client)).catch(err => logger.error('background.chess_restore.failed', err));
    }
  }

  if (!quizInitStarted) {
    quizInitStarted = true;
    const { _initQuiz } = require('./commands/games/quiz');
    if (_initQuiz) {
      runLoggedBackgroundTask('quiz_restore', {}, () => _initQuiz(client)).catch(err => logger.error('background.quiz_restore.failed', err));
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
  'copilot', 'gpt', 'voice', 'imagine', 'upscale', 'translate', 'transcribe', 'tts',
  // search.js — external API/scraping calls
  'pinterest', 'sauce', 'wallpaper', 'lyrics',
  // cardmanager.js — multi-call AniList lookups / background-batch triggers / bulk DB repair
  'backfillimages', 'bulkadd', 'autoexpand', 'repairlinks', 'purgeorphans',
  // general.js — multi-collection aggregation + live per-group WhatsApp lookups
  'stats',
  // news.js — RSS fetch + multi-message send loop
  'news',
]);

// ─── Registration gate ─────────────────────────────────────────────────────
// See commands/economy.js's .setname/.setdob/.bio/.setpic and
// models/User.js's `registration` field. These four commands are the only
// ones allowed to run for an account that isn't fully registered yet —
// they're exactly the commands that BUILD a registration, so they can't be
// blocked by the same gate that guards everything else. `command` here has
// already gone through the aliases map by the time this runs (setbio ->
// bio), so only the canonical names need listing.
const REGISTRATION_BYPASS_COMMANDS = new Set(['reg', 'setname', 'setdob', 'bio', 'setpic']);

// Checks whether `command` should be allowed to run for whoever sent `msg`.
// Returns { blocked, senderId, wasActive }:
//   - blocked: true if a registration message was sent and the caller
//     should NOT run the resolved command handler.
//   - senderId / wasActive: used after a REGISTRATION_BYPASS_COMMANDS
//     command finishes running, to decide whether to auto-send the .menu
//     (see the "Normal commands" execution block further down) — wasActive
//     records whether the account was already fully registered BEFORE this
//     command ran, so a person who's long since registered updating their
//     name again doesn't get the menu blasted at them every time.
//
// Deliberately fails OPEN on any unexpected error (Mongo hiccup, contact
// lookup failure, etc.) rather than silently blocking every command bot-wide
// if this new gate itself has a bug — a bug here should degrade back to the
// bot's old (pre-registration) behavior, not take the whole bot down.
async function checkRegistrationGate(msg, command) {
  let senderId = null;
  try {
    const contact = await safeGetContact(msg);
    senderId = contact?.id?._serialized || null;
  } catch (err) {
    console.error('Registration gate: contact lookup failed:', err.message);
  }
  if (!senderId) senderId = msg.author || msg.from;

  // Owner/mods run the bot day-to-day (testing, moderating) and shouldn't
  // be forced through registration to do that.
  if (isOwner(senderId) || isMod(senderId)) {
    return { blocked: false, senderId, wasActive: true };
  }

  let existingUser = null;
  try {
    const User = require('./models/User');
    existingUser = await User.findOne({ id: senderId }, 'registration').lean();
  } catch (err) {
    console.error('Registration gate: user lookup failed, allowing command through:', err.message);
    return { blocked: false, senderId, wasActive: true };
  }

  // .lean() skips Mongoose document hydration, which is what would normally
  // apply the schema's `registration.status` default ('active') for a
  // pre-existing document that has no `registration` path stored at all —
  // so that fallback has to be done by hand here to get the same
  // grandfathering behavior (see models/User.js's comment on that default).
  const status = existingUser ? (existingUser.registration?.status || 'active') : null;
  const wasActive = status === 'active';

  if (REGISTRATION_BYPASS_COMMANDS.has(command)) {
    return { blocked: false, senderId, wasActive };
  }

  if (!existingUser) {
    await msg.reply(buildRegistrationIntroText(BOT_NAME)).catch(err => {
      console.error('Registration gate: failed to send intro message:', err.message);
    });
    return { blocked: true, senderId, wasActive: false };
  }

  if (status === 'active') {
    return { blocked: false, senderId, wasActive: true };
  }

  await msg.reply(buildRegistrationProgressText(existingUser)).catch(err => {
    console.error('Registration gate: failed to send progress message:', err.message);
  });
  return { blocked: true, senderId, wasActive: false };
}

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
  logger.write('INFO', 'queue.heavy.worker.start', { queued: heavyQueue.length });
  try {
    while (heavyQueue.length > 0) {
      const task = heavyQueue.shift();
      try {
        await task();
      } catch (err) {
        logger.error('queue.heavy.task.crashed', err);
      }
    }
  } finally {
    heavyBusy = false;
    logger.write('INFO', 'queue.heavy.worker.idle', { queued: heavyQueue.length });
  }
}

// ─── Auto AI-reply classification ──────────────────────────────────────────
// Used below to decide whether an un-prefixed reply to the bot should be
// treated as an implicit .copilot / .voice command. See the comment at the
// call site for the full rule.
//
// Sticker replies are also AI input: they are downloaded temporarily and
// passed to Gemini Vision, but are never added to the owner-controlled library.
// Other media remains ignored by the implicit reply-to-bot router. Recognized
// reply kinds are plain text, image, sticker, or voice/audio — either a
// recorded voice note (ptt) or a regular uploaded audio file (audio), both
// treated the same way. Anything else — video, document, location, contact card,
// etc. — comes back 'other', and index.js does nothing with it (no
// auto-command, no auto-menu). That last part matters: previously ANY
// reply to the bot, sticker included, popped the full command menu, which
// is the behavior this replaces.
function classifyReplyKind(msg) {
  if (msg.type === 'chat' && !msg.hasMedia && (msg.body || '').trim()) return 'text';
  if (msg.type === 'image' && msg.hasMedia) return 'image';
  if (msg.type === 'sticker' && msg.hasMedia) return 'sticker';
  if ((msg.type === 'ptt' || msg.type === 'audio') && msg.hasMedia) return 'voice';
  return 'other';
}

function isVoiceNoteMessage(msg) {
  return !!msg && msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
}

// ─── AI wake-word: "called by name" in plain text ──────────────────────────
// Lets someone address the AI persona directly by name (no command prefix,
// no @mention) — "Marin, what anime should I watch", "Hi Kitagawa" — while
// leaving ordinary conversation ABOUT the persona's name alone, e.g. "I just
// finished My Dress-Up Darling and I think Marin is cute" should NOT trigger
// a reply. This is inherently a judgment call heuristics can't get perfect
// (natural language is ambiguous even for humans without more context) —
// biased deliberately toward NOT triggering on anything but a fairly clear
// direct address, since the bot butting into an unrelated conversation is a
// worse experience than occasionally staying quiet when it could have
// answered.
//
// Recognized as a direct address:
//   - The message IS the name, alone (± a leading greeting / trailing
//     punctuation): "Marin", "Hi Marin", "kitagawa!"
//   - The message STARTS with the name, followed by end-of-message, a
//     comma, or a word that isn't a common third-person predicate:
//     "Marin what anime should I watch", "Marin, can you help"
//     (but NOT "Marin is cute", "Marin looks great today" — see
//     THIRD_PERSON_PREDICATES below)
//   - The message ENDS with a comma then the name: "what anime should I
//     watch, Marin?"
// Everything else — including the name appearing mid-sentence — is ordinary
// conversation, not a direct address.
const GREETING_PREFIX_RE = /^(hi|hey|hello|hiya|yo|sup|oi|ay|aye)[\s,]+/i;
const THIRD_PERSON_PREDICATES = new Set([
  'is', 'was', 'are', 'were', 'has', 'have', 'had', 'looks', 'looked',
  'seems', 'seemed', 'does', 'did', 'would', 'said', 'says', 'thinks',
  'thought', 'likes', 'liked', 'loves', 'loved', 'hates', 'hated',
  'wants', 'wanted', 'needs', 'needed', 'being',
]);

function isCommandMenuRequest(rawBody) {
  const text = String(rawBody || '').toLowerCase().replace(/[’]/g, "'").trim();
  if (!text) return false;
  return [
    /\b(?:what|which)\s+(?:are|r)\s+(?:your|the)\s+commands?\b/,
    /\b(?:show|list|send|give|display)\s+(?:me\s+)?(?:the\s+)?(?:bot'?s?\s+)?commands?\b/,
    /\bwhat\s+can\s+i\s+(?:use|do)(?:\s+(?:with\s+)?(?:this|the)\s+bot)?\b/,
    /\bwhat\s+(?:features|functions)\s+(?:does|can)\s+(?:this\s+)?bot\b/,
  ].some(pattern => pattern.test(text));
}

function isCallingBotByName(rawBody) {
  const body = (rawBody || '').trim();
  if (!body) return false;

  const stripped = body.replace(GREETING_PREFIX_RE, '');

  // Resolve names at message time rather than freezing an eagerly-loaded
  // persona at module import. A broken persona uses only an explicit env
  // override (if supplied); otherwise group wake names are empty.
  const persona = getActivePersonaSafe();
  const callNames = persona ? persona.callNames : (AI_CALL_NAMES_OVERRIDE || []);
  for (const name of callNames) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (!escaped) continue;

    // Bare name, alone (± trailing punctuation like "?"/"!"/"."/"~")
    if (new RegExp(`^${escaped}[?!.~\\s]*$`, 'i').test(stripped)) return true;

    // Starts with the name, followed by end-of-message, a comma, or a word
    // that isn't a common third-person predicate.
    const startMatch = stripped.match(new RegExp(`^${escaped}\\b`, 'i'));
    if (startMatch) {
      const rest = stripped.slice(startMatch[0].length).trim();
      const nextWord = rest.replace(/^,\s*/, '').split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '');
      if (!nextWord || rest.startsWith(',') || !THIRD_PERSON_PREDICATES.has(nextWord)) return true;
    }

    // Ends with ", name" (± trailing punctuation)
    if (new RegExp(`,\\s*${escaped}[?!.~\\s]*$`, 'i').test(stripped)) return true;
  }

  return false;
}

// Per-chat command queue
const commandQueues = new Map();

function enqueueCommand(chatId, task) {
  const previous = commandQueues.get(chatId) || Promise.resolve();
  const queuedAt = Date.now();
  logger.write('INFO', 'queue.command.enqueued', { chatId, waitingBehindExisting: commandQueues.has(chatId) });

  const next = previous
    .then(async () => {
      logger.write('INFO', 'queue.command.started', { chatId, waitMs: Date.now() - queuedAt });
      try {
        return await task();
      } finally {
        logger.write('INFO', 'queue.command.finished', { chatId, durationMs: Date.now() - queuedAt });
      }
    })
    .catch(err => logger.error('queue.command.failed', err, { chatId }))
    .finally(() => {
      if (commandQueues.get(chatId) === next) {
        commandQueues.delete(chatId);
      }
    });

  commandQueues.set(chatId, next);
  return next;
}

client.on('message', (msg) => {
  (async () => {
    // Never process messages the bot's own account sent — whether typed
    // manually in "Message Yourself" or sent by the bot itself. In current
    // whatsapp-web.js this event generally doesn't fire for self-sent
    // messages anyway (they go through message_create instead), but this
    // costs nothing and protects against any future/edge-case behavior.
    if (msg.fromMe) {
      logger.debug('message.ignored', { reason: 'from_me', messageType: msg.type });
      return;
    }

    patchQuotedReply(msg);

    if (msg.type === 'sticker') {
      const imported = await aiStickers.handleIncomingSticker(client, msg).catch(err => {
        logger.error('route.ai_sticker_import.failed', err, { chatId: msg.from });
        return false;
      });
      if (imported) {
        logger.write('INFO', 'route.ai_sticker_import', { messageType: msg.type, chatId: msg.from });
        return;
      }
    }

    // ── Anime Quiz answers ───────────────────────────────────────────────
    // A bare "1"-"4" typed during an active .quiz is NOT a command (no
    // prefix) and is very often also a quoted reply to the bot's own quiz
    // question image — which, further down, is exactly the shape that
    // triggers the auto-.copilot reply-to-bot handling. Checked here, first,
    // AND deliberately OUTSIDE enqueueCommand below. This used to be the
    // first thing *inside* the per-chat queue, which looked equivalent but
    // wasn't: the quiz question's own timer is a plain, un-queued
    // setTimeout that keeps running in real time no matter what else this
    // chat's queue is busy with. If anything ahead of a reply in that queue
    // took a while (a slow AI command, a hiccupping connection), the reply
    // sat waiting long enough for the real timer to fire first — so by the
    // time this check finally ran, `question.resolved` was already true
    // and a genuinely on-time answer got silently rejected here and fell
    // through to the AI-copilot reply-to-bot handler instead (the "could
    // not download the attached/replied-to media" symptom). Running this
    // directly off the raw message event, before anything is queued, means
    // an answer is only ever too late if the real clock says so.
    try {
      if (await tryHandleQuizAnswer(client, msg)) {
        logger.write('INFO', 'route.quiz_answer', { chatId: msg.from, messageType: msg.type });
        return;
      }
    } catch (err) {
      logger.error('route.quiz_answer.failed', err, { chatId: msg.from });
    }

    // Everything else still goes through the per-chat queue, so ordinary
    // commands from the same chat are processed one at a time, in order.
    enqueueCommand(msg.from, async () => {
    try {
      const body = msg.body || '';

    let command;
    let args;

    if (!body.startsWith(PREFIX)) {
      // Explicit @mention of the bot always shows the menu — unchanged,
      // and takes priority even if the person is also replying to something.
      const mentionsBot = msg.mentionedIds &&
        msg.mentionedIds.includes(client.info.wid._serialized);
      if (mentionsBot) {
        // This is its own early return (not routed through `command`
        // below), so it needs its own stability check — everything else
        // in this function gets one lower down, only once we know a
        // response is actually needed at all. See that comment for why.
        const stable = await waitForStableConnection();
        if (!stable) {
          logger.write('WARN', 'route.menu.ignored', { reason: 'unstable_connection', chatId: msg.from });
          return;
        }
        logger.write('INFO', 'route.menu.mention', { chatId: msg.from });
        return await sendQuickMenu(msg);
      }

      const quoted = msg.hasQuotedMsg ? await safeGetQuotedMessage(msg).catch(() => null) : null;

      if (quoted && quoted.fromMe) {
        // Existing reply-to-bot behavior stays ahead of the plain-DM router.
        const replyKind = classifyReplyKind(msg);
        if (replyKind === 'other') {
          logger.debug('message.ignored', { reason: 'unsupported_reply_to_bot', chatId: msg.from, messageType: msg.type });
          return;
        }
        msg._aiStickerReply = replyKind === 'sticker';
        const typed = (msg.body || '').trim();
        args = typed
          ? typed.split(/\s+/)
          : (replyKind === 'image' ? ['Take', 'a', 'look', 'and', 'respond', 'naturally.'] :
            // Leave sticker-only replies empty here. commands/ai.js owns the
            // media-aware default prompt and can distinguish a new user
            // sticker from a text reply to the bot's sticker without index.js
            // accidentally seeding the wrong instruction for either case.
            []);
        command = isVoiceNoteMessage(quoted) ? 'voice' : 'copilot';
        logger.write('INFO', command === 'voice' ? 'route.ai.voice' : 'route.ai.copilot', {
          reason: 'reply_to_bot',
          chatId: msg.from,
          replyKind,
          botStickerReply: Boolean(quoted.type === 'sticker' && quoted.fromMe),
        });
      } else {
        const chat = await safeGetChat(msg).catch(() => null);
        if (chat && chat.isGroup === false && !String(chat.id?._serialized || '').endsWith('@g.us')) {
          // Only registered private-chat users reach this command later: the
          // existing registration gate still runs before handler execution.
          if (isVoiceNoteMessage(msg)) {
            command = 'voice';
            args = [];
            logger.write('INFO', 'route.ai.voice', { reason: 'dm_voice_note', chatId: msg.from });
          } else if (msg.type === 'chat' && !msg.hasMedia && body.trim()) {
            command = isCommandMenuRequest(body) ? 'menu' : 'copilot';
            args = [body.trim()];
            logger.write('INFO', command === 'menu' ? 'route.menu.dm_request' : 'route.ai.copilot', { reason: 'dm_text', chatId: msg.from, bodyLength: body.length });
          } else {
            logger.debug('message.ignored', { reason: 'unsupported_dm_message', chatId: msg.from, messageType: msg.type });
            return;
          }
        } else {
          // Group behavior remains wake-word/reply-only; plain group text
          // still never routes into Copilot.
          if (!isCallingBotByName(body)) {
            logger.debug('message.ignored', { reason: 'group_not_addressed_to_bot', chatId: msg.from, messageType: msg.type });
            return;
          }
          const quotedText = quoted ? (quoted.body || '').trim() : '';
          const prompt = quotedText
            ? `${body}\n\n(They're replying to this message: "${quotedText}")`
            : body;
          args = [prompt];
          command = 'copilot';
          logger.write('INFO', 'route.ai.copilot', { reason: 'group_wake_word', chatId: msg.from, bodyLength: body.length });
        }
      }
    } else {
      args = body.slice(PREFIX.length).trim().split(/\s+/);
      command = args.shift().toLowerCase();

      if (aliases[command]) command = aliases[command];
    }

    logger.debug('command.received', {
      taskId: `attempt-${nextTaskId()}`,
      command,
      argsPreview: args.map(arg => String(arg).slice(0, 160)),
      messageType: msg.type,
      from: msg.from,
      author: msg.author || msg.from,
      bodyLength: (msg.body || '').length,
    });

    // Only reached once we know this message actually needs a response —
    // an explicit command, a wake-word call, or a reply to the bot all set
    // `command` above before falling through to here; anything else
    // returned already. An ordinary group message nobody's addressing the
    // bot with never reaches this, so it costs nothing during a shaky
    // connection — previously this ran for every single non-command
    // message before we'd even looked at what it was.
    const stable = await waitForStableConnection();
    if (!stable) {
      if (body.startsWith(PREFIX)) {
        await msg.reply('⚠️ WhatsApp connection is unstable right now — please try again in a moment.');
      }
      return;
    }

    // ── Registration gate ──────────────────────────────────────────────────
    // Must run before ANY handler resolution/execution below — this is what
    // stops commands like .balance/.cards/.daily from implicitly creating a
    // full account via User.findOrCreate() before someone has registered.
    // See checkRegistrationGate()'s own comment above for the bypass list
    // and fail-open behavior.
    const registrationCheck = await checkRegistrationGate(msg, command).catch(err => {
      logger.error('registration.gate.failed_open', err, { command });
      return { blocked: false, senderId: null, wasActive: true };
    });
    if (registrationCheck.blocked) {
      logger.write('INFO', 'registration.blocked', { command, senderId: registrationCheck.senderId, reason: 'incomplete_registration' });
      return;
    }

    // ── Gemini reservation gate ────────────────────────────────────────────
    // While the background sticker-analysis queue is working (or paused for
    // Gemini quota) it owns the shared Gemini quota, so Gemini-backed commands
    // answer immediately with "unavailable" instead of competing with it. This
    // sits after the registration gate and before any task/queue bookkeeping,
    // so nothing has to be unwound. Implicit routes (DM chat, reply-to-bot,
    // wake-word) set `command` to copilot/voice above, so they are covered too.
    // Which commands count, and the text, come from utils/config.js.
    if (geminiGate.shouldBlockCommand(command)) {
      logger.write('INFO', 'gemini.gate.blocked', { command, from: msg.from });
      try {
        await msg.reply(geminiGate.BUSY_MESSAGE);
      } catch (replyErr) {
        logger.error('gemini.gate.reply_failed', replyErr, { command });
      }
      return;
    }

    // ── Task ID + logging context ──────────────────────────────────────────
    // Assigned as soon as we know a command was *attempted*, whether or not
    // it turns out to resolve to a real handler below.
    const taskId = nextTaskId();
    const receivedAt = new Date().toLocaleString();
    const [senderName, chatLabel] = await Promise.all([getSenderName(msg), getChatLabel(msg)]);

    const queuePosition = inFlightCount + 1;
    const isHeavy = HEAVY_COMMANDS.has(command);
    inFlightCount++;

    logger.write('INFO', 'command.accepted', {
      taskId, command, argsPreview: args.map(arg => String(arg).slice(0, 160)), senderName, chatLabel, receivedAt,
      queuePosition, queue: isHeavy ? 'heavy' : 'normal', from: msg.from,
    });

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
      logger.write('WARN', 'command.unknown', { taskId, command, args, senderName, chatLabel });
      inFlightCount = Math.max(0, inFlightCount - 1);
      return await msg.reply(`❓ Unknown command: *${PREFIX}${command}*\nType *${PREFIX}menu* to see what's available.`);
    }

    // NOTE: AFK welcome-back used to be checked right here (command-only).
    // It's now a standalone client.on('message', ...) listener further down
    // — see the "AFK welcome-back" section near the AFK-mention listener —
    // so it fires for every message the person sends, not just commands.

    // ── Usage tracking context (for .stats) ──────────────────────────────
    // Resolved via safeGetChat/safeGetContact rather than raw msg.from/
    // msg.author — same id-canonicalization reasoning as the activity-
    // tracking listener further down in this file (a real group or person
    // could otherwise fragment into multiple different rows over time).
    // Wrapped in try/catch and defaults to the plain, untracked handler on
    // any failure — a tracking hiccup must never block a real command.
    let trackedHandlerFn = handlerFn;
    try {
      const trackChat = await safeGetChat(msg);
      const trackContact = await safeGetContact(msg);
      const usageGroupId = trackChat?.isGroup ? trackChat.id._serialized : 'DM';
      const usageUserId = trackContact?.id._serialized || (msg.author || msg.from);
      trackedHandlerFn = wrapWithUsageTracking(handlerFn, { groupId: usageGroupId, userId: usageUserId, command });
    } catch (err) {
      logger.error('usage.context.failed', err, { command });
    }

    if (isHeavy) {
      // Heavy commands: reserve a spot in the global queue *first* (that's
      // the atomic, race-free part — see enqueueHeavyTask), then return
      // right away so this chat's own message queue isn't blocked waiting
      // on it. The actual execution/logging inside the queued task below is
      // unchanged — only what happens in-chat right here changed.
      const heavyPosition = enqueueHeavyTask(async () => {
        const heavyStartedAt = Date.now();
        let heavyStatus = 'success';
        logger.write('INFO', 'queue.heavy.job.start', { taskId, command, queuePosition: heavyPosition });
        try {
          await logger.run(`command.${command}`, { taskId, command, argsPreview: args.map(arg => String(arg).slice(0, 160)), senderName, chatLabel, queue: 'heavy', queuePosition: heavyPosition }, () => trackedHandlerFn());
        } catch (err) {
          heavyStatus = 'failed';
          logger.error('command.heavy.failed', err, { taskId, command, queuePosition: heavyPosition });
          try {
            await msg.reply('❌ An error occurred while processing your request. Please try again.');
          } catch (replyErr) {
            logger.error('command.error_reply_failed', replyErr, { taskId, command });
          }
        } finally {
          logger.write(heavyStatus === 'success' ? 'INFO' : 'ERROR', 'queue.heavy.job.end', { taskId, command, queuePosition: heavyPosition, status: heavyStatus, durationMs: Date.now() - heavyStartedAt });
          inFlightCount = Math.max(0, inFlightCount - 1);
        }
      });

      // No more "Command received / Task ID / position" text sent to the
      // chat — the queue system itself is unchanged, this position is just
      // logged now instead of messaged, same as Task ID already is above.
      logger.write('INFO', 'queue.heavy.enqueued', { taskId, command, queuePosition: heavyPosition, queued: heavyQueue.length });

      // In-chat acknowledgment is now a reaction instead of text: ▶️
      // specifically for .play (matches the "now queued to play" moment),
      // nothing here for .news (it reacts with its own 📰 once it actually
      // runs — see commands/news.js — so it shouldn't also get the generic
      // ⏳ below, which would otherwise show/flicker first), ⏳ for every
      // other heavy/queued command.
      try {
        if (command === 'play') {
          await msg.react('▶️');
        } else if (command !== 'news' && command !== 'copilot' && command !== 'voice') {
          // copilot/voice put their own ⏳ on the message and remove it again when
          // the reply is done (commands/ai.js), so the dispatcher must not add a
          // second one that nothing would ever clear.
          await msg.react('⏳');
        }
      } catch (err) {
        console.error('Failed to react to queued command:', err.message);
      }

      return;
    }

    // Normal commands: run immediately, same as before.
    try {
      await logger.run(`command.${command}`, { taskId, command, argsPreview: args.map(arg => String(arg).slice(0, 160)), senderName, chatLabel, queue: 'normal' }, () => trackedHandlerFn());

      // ── Post-registration menu send ────────────────────────────────────
      // Only relevant right after one of the four registration commands
      // (none of which are HEAVY_COMMANDS, so this normal-command block is
      // the only place that needs it) finishes for someone who was NOT
      // already fully registered before it ran. Re-checking Mongo here
      // (rather than trusting some in-memory flag) is deliberate: the
      // command handler in commands/economy.js is what actually flips
      // registration.status to 'active' and saves it, so by the time this
      // await resolves that write has already committed — this is just
      // reading back the result of it.
      if (REGISTRATION_BYPASS_COMMANDS.has(command) && registrationCheck.senderId && !registrationCheck.wasActive) {
        try {
          const User = require('./models/User');
          const freshUser = await User.findOne({ id: registrationCheck.senderId }, 'registration').lean();
          if (freshUser?.registration?.status === 'active') {
            await sendQuickMenu(msg);
          }
        } catch (err) {
          console.error('Post-registration menu send failed:', err.message);
        }
      }
    } catch (err) {
      logger.error('command.normal.failed', err, { taskId, command });
      await msg.reply('❌ An error occurred. Please try again.');
    } finally {
      inFlightCount = Math.max(0, inFlightCount - 1);
    }
} catch (err) {
  logger.error('command.dispatch.failed', err, { chatId: msg.from });
  await msg.reply('❌ An error occurred. Please try again.').catch(() => {});
}
    });
  })().catch(err => logger.error('message.handler.failed', err, { chatId: msg.from }));
});

// ── AI reacts to reactions on its own messages ─────────────────────────────
// Someone reacted to a message, voice note, image or sticker the AI sent: the
// AI may put its own emoji reaction on that same message. It never sends a
// message here — see utils/aiReactions.js for the rules (ignores its own
// reactions, only AI-sent messages, one reaction per message, cooldown).
const aiReactionHandler = aiReactions.createReactionHandler({ client });
client.on('message_reaction', (reaction) => {
  try {
    aiReactionHandler.handle(reaction);
  } catch (err) {
    logger.error('ai.reaction.handler_failed', err);
  }
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

    // messageCount is a plain top-level Number, so $inc alone is always
    // safe and atomic for it.
    await withRetry(() => Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { $inc: { messageCount: 1 } },
      { upsert: true }
    ));

    // Per-user breakdown — a separate atomic upsert into GroupActivity
    // rather than Group's old activityLog Map (load -> read count ->
    // increment -> save the whole Group document). See
    // models/GroupActivity.js for why that was a lost-update race AND had
    // a WhatsApp-id-contains-"." corruption bug neither of which apply
    // here.
    await withRetry(() => GroupActivity.findOneAndUpdate(
      { groupId: chat.id._serialized, userId: senderId },
      { $inc: { count: 1 }, $set: { lastAt: new Date() } },
      { upsert: true }
    ));
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

// ── AFK mention notice ────────────────────────────────────────────────────
// Separate from the main dispatch listener above on purpose: that one only
// runs for recognized commands / mentions of the bot itself / replies to the
// bot, so a plain "@someone how's it going" would never reach it. This
// listener fires for every message and just checks whether any @-mentioned
// person is currently AFK, independent of whether the message is a command
// at all — same standalone-listener pattern already used for activity
// tracking and antilink above.
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const { _checkAfkMentions } = require('./commands/afk');
    await _checkAfkMentions(client, msg);
  } catch (err) {
    console.error('AFK mention check error:', err.message);
  }
});

// ── AFK welcome-back ──────────────────────────────────────────────────────
// BUGFIX (Aug 2026): this used to be checked only from inside the main
// dispatch listener above, right before a recognized command executed — so
// coming back from AFK only welcomed the person back if their first message
// happened to be a command (or an implicit .copilot/.voice reply to
// something the BOT itself sent). A plain reply to whoever @-mentioned them
// while they were away — the most common way someone actually comes back —
// isn't a command and isn't a reply to the bot, so it fell straight through
// and welcome-back never fired at all.
//
// Now a standalone listener, same pattern as the AFK-mention listener right
// above and the activity-tracking/antilink listeners further up: it runs for
// EVERY message the person sends — any text, any reply target (or none),
// group or DM, command or not — so they're welcomed back the moment they
// show up again, no matter who or what they replied to.
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const contact = await safeGetContact(msg);
    const { _checkAfkReturn } = require('./commands/afk');
    await _checkAfkReturn(msg, contact.id._serialized);
  } catch (err) {
    console.error('AFK welcome-back check failed:', err.message);
  }
});

setInterval(() => {
  runLoggedBackgroundTask('heartbeat', {}, async () => {
    logger.write('INFO', 'heartbeat', { inFlightCommands: inFlightCount, heavyQueueLength: heavyQueue.length, activeChatQueues: commandQueues.size });
  }).catch(err => logger.error('background.heartbeat.unhandled', err));
}, 60000);

// ── Daily bot-stats digest (8:00 AM WAT, unprompted) ────────────────────
// Checked every minute alongside the heartbeat above — the actual
// once-a-day gating (and duplicate-send protection across PM2 restarts)
// lives in _maybeSendDailyStats itself (commands/general.js), via
// BotState. This just needs to call it often enough not to miss the
// 07:00 UTC / 08:00 WAT minute.
setInterval(() => {
  const { _maybeSendDailyStats } = require('./commands/general');
  if (_maybeSendDailyStats) {
    runLoggedBackgroundTask('daily_stats_digest_check', {}, () => _maybeSendDailyStats(client)).catch(err => logger.error('background.daily_stats_digest_check.unhandled', err));
  }
}, 60000);

// ── Inactive-user cleanup (4:00 AM WAT daily) ───────────────────────────
// Same shape as the stats digest above — checked every minute, actual
// once-a-day gating + duplicate-run protection lives inside
// _sweepInactiveUsers itself (commands/admin.js), via BotState.
setInterval(() => {
  const { _sweepInactiveUsers } = require('./commands/admin');
  if (_sweepInactiveUsers) {
    runLoggedBackgroundTask('inactive_user_sweep_check', {}, () => _sweepInactiveUsers(client)).catch(err => logger.error('background.inactive_user_sweep_check.unhandled', err));
  }
}, 60000);

// ── Guild anniversary/holiday events (9:00 AM WAT daily) ────────────────
// Same shape again — checked every minute, actual once-a-day gating +
// duplicate-run protection lives inside _maybeSendGuildEvents itself
// (commands/guilds.js), via BotState.
setInterval(() => {
  const { _maybeSendGuildEvents } = require('./commands/guilds');
  if (_maybeSendGuildEvents) {
    runLoggedBackgroundTask('guild_events_check', {}, () => _maybeSendGuildEvents(client)).catch(err => logger.error('background.guild_events_check.unhandled', err));
  }
}, 60000);

// ── Daily anime news broadcast (8:00 AM WAT daily) ──────────────────────
// Same shape again — checked every minute, actual once-a-day gating +
// duplicate-run protection lives inside _maybeSendDailyNews itself
// (commands/news.js), via BotState. Unlike the digests above (which go to
// one recipient), this one fans out to every group the bot is CURRENTLY
// in — see _maybeSendDailyNews's own comment for how that list is built.
setInterval(() => {
  const { _maybeSendDailyNews } = require('./commands/news');
  if (_maybeSendDailyNews) {
    runLoggedBackgroundTask('daily_news_broadcast_check', {}, () => _maybeSendDailyNews(client)).catch(err => logger.error('background.daily_news_broadcast_check.unhandled', err));
  }
}, 60000);

startWhatsApp();
