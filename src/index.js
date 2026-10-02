/**
 * Ani-Chan Bot - Main Entry Point (Baileys Version)
 * This is the new entry point that uses @whiskeysockets/baileys
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import fs from 'fs';
import { execSync } from 'child_process';

// Import utilities
import { safeGetQuotedMessage, safeGetChat, safeGetContact, resolveSenderName, withRetry, decodeIdKey, isOwner, isMod, buildRegistrationIntroText, buildRegistrationProgressText } from '../utils/helpers.js';
import { BOT_NAME, MONGODB_URI, BOT_PREFIX, AI_CALL_NAMES_OVERRIDE } from '../utils/config.js';
import { getActivePersonaSafe } from '../utils/persona.js';
import aiStickers from '../utils/aiStickers.js';
import { instrumentHttpClients, wrapWithUsageTracking } from '../utils/usageTracking.js';
import logger from '../utils/logger.js';
import geminiGate from '../utils/geminiGate.js';
import { tryHandleQuizAnswer } from '../commands/games/quiz.js';

// Import Baileys components
import socketManager from './client/socket.js';
import authManager from './client/auth.js';
import { normalizeMessage, safeGetQuotedMessage as safeGetQuoted, safeGetChat as safeGetChatWrapper, safeGetContact as safeGetContactWrapper } from './middleware/normalizeMessage.js';
import mediaService from './services/media.js';

// Set up global MessageMedia for compatibility
import { MessageMedia } from './services/media.js';
global.MessageMedia = MessageMedia;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Instrument HTTP clients for usage tracking
instrumentHttpClients();

// MongoDB connection
const mongoOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
};

// Connect to MongoDB
async function connectMongo() {
  const operation = logger.start('background.mongo_connect', { retryDelayMs: 15000 });
  try {
    await mongoose.connect(process.env.MONGO_URI || MONGODB_URI, mongoOptions);
    operation.finish('success', { readyState: mongoose.connection.readyState });
    console.log('✅ MongoDB connected');

    // Initialize AI stickers
    aiStickers.initialize().catch(err => {
      logger.error('background.ai_sticker_metadata_startup.failed', err);
    });

    // Sync AiConversation indexes
    const AiConversation = require('../models/AiConversation.js');
    AiConversation.syncIndexes().catch(err => {
      logger.error('background.ai_conversation_indexes.failed', err);
    });

    // Migrate group activity log
    const GroupActivity = require('../models/GroupActivity.js');
    const Group = require('../models/Group.js');
    
    async function migrateGroupActivityLog() {
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
    
    migrateGroupActivityLog().catch(err => {
      logger.error('background.group_activity_migration.failed', err);
    });

  } catch (err) {
    operation.finish('failed', { error: err });
    logger.error('background.mongo_connect.retry_scheduled', err, { retryDelayMs: 15000 });
    setTimeout(() => connectMongo(), 15000);
  }
}

// Connect to MongoDB
connectMongo();

// Initialize socket manager
const sock = socketManager.getSocket();

// Background task counter
let backgroundTaskCounter = 0;

async function runLoggedBackgroundTask(name, details, fn) {
  const taskId = `bg-${++backgroundTaskCounter}`;
  return logger.run(`background.${name}`, { taskId, ...details }, fn);
}

// Task ID counter
let taskIdCounter = 0;
function nextTaskId() {
  return ++taskIdCounter;
}

// In-flight command counter
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

// Command queue
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

// Load commands
const commands = {};
const commandDir = path.join(__dirname, '../commands');

try {
  const fs = await import('fs');
  const files = fs.readdirSync(commandDir);
  
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    
    try {
      const module = await import(path.join(commandDir, file));
      Object.entries(module.default || module).forEach(([name, fn]) => {
        if (typeof fn === 'function' && !name.startsWith('_')) {
          commands[name.toLowerCase()] = fn;
        }
      });
    } catch (err) {
      console.error(`Failed to load command file ${file}:`, err.message);
    }
  }
} catch (err) {
  console.error('Failed to read commands directory:', err.message);
}

console.log(`✅ Loaded ${Object.keys(commands).length} commands`);

// Aliases
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

// Command reference
const { COMMAND_REFERENCE } = await import('../utils/commandReference.js');

// Extract menu commands
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

// Send quick menu
async function sendQuickMenu(msg) {
  const header = `
╔═══════════════════════════════════════════════════════════════╗
║                    *${BOT_NAME}*                        ║
║  📱 Prefix: ${BOT_PREFIX}                                   ║
║  📝 Commands: ${Object.keys(commands).length}                            ║
╚═══════════════════════════════════════════════════════════════╝`;

  const body = COMMAND_REFERENCE.map(section => {
    const seen = new Set();
    const cmds = [];
    for (const item of section.items) {
      const variants = extractMenuCommands(item.cmd);
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
    const lines = cmds.map(cmd => `✦ ${cmd}`).join('\n');
    return `*${section.emoji} ${section.title} ${section.emoji}*\n${lines}\n════════════════════`;
  }).join('\n\n');

  const menu = `${header}\n\n${body}\n\nType *${BOT_PREFIX}<command>* to use one.`;

  try {
    let imageUrl;
    try {
      // For now, use the fallback image
      imageUrl = process.env.MENU_IMAGE_URL || '';
    } catch (err) {
      console.error('Menu: failed to fetch bot profile picture, using fallback image:', err.message);
    }
    if (!imageUrl) imageUrl = process.env.MENU_IMAGE_URL || '';

    if (imageUrl) {
      const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
      await msg.reply(media, undefined, { caption: menu });
    } else {
      await msg.reply(menu);
    }
  } catch (err) {
    console.error('Menu: failed to send menu image, falling back to text only:', err.message);
    await msg.reply(menu);
  }
}

// Attach sendQuickMenu to client
const client = socketManager;
client.sendQuickMenu = sendQuickMenu;

// Heavy commands
const HEAVY_COMMANDS = new Set([
  'ig', 'ttk', 'yt', 'x', 'fb', 'play',
  'sticker', 'take', 'toimg', 'tovid', 'rotate', 'tomp3', 'tovn', 'flip', 'resize', 'tourl',
  'meme',
  'copilot', 'gpt', 'voice', 'imagine', 'upscale', 'translate', 'transcribe', 'tts',
  'pinterest', 'sauce', 'wallpaper', 'lyrics',
  'backfillimages', 'bulkadd', 'autoexpand', 'repairlinks', 'purgeorphans',
  'stats',
  'news',
]);

// Registration bypass commands
const REGISTRATION_BYPASS_COMMANDS = new Set(['reg', 'setname', 'setdob', 'bio', 'setpic']);

// Registration gate
async function checkRegistrationGate(msg, command) {
  let senderId = null;
  try {
    const contact = await safeGetContactWrapper(msg);
    senderId = contact?.id?._serialized || null;
  } catch (err) {
    console.error('Registration gate: contact lookup failed:', err.message);
  }
  if (!senderId) senderId = msg.author || msg.from;

  if (isOwner(senderId) || isMod(senderId)) {
    return { blocked: false, senderId, wasActive: true };
  }

  let existingUser = null;
  try {
    const User = await import('../models/User.js');
    existingUser = await User.default.findOne({ id: senderId }, 'registration').lean();
  } catch (err) {
    console.error('Registration gate: user lookup failed, allowing command through:', err.message);
    return { blocked: false, senderId, wasActive: true };
  }

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

// Global serial queue for heavy commands
const heavyQueue = [];
let heavyBusy = false;

function enqueueHeavyTask(task) {
  const position = heavyQueue.length + (heavyBusy ? 1 : 0) + 1;
  heavyQueue.push(task);
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

// Classify reply kind
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

// Is calling bot by name
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
  const persona = getActivePersonaSafe();
  const callNames = persona ? persona.callNames : (AI_CALL_NAMES_OVERRIDE || []);
  
  for (const name of callNames) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (!escaped) continue;

    if (new RegExp(`^${escaped}[?!.~\\s]*$`, 'i').test(stripped)) return true;

    const startMatch = stripped.match(new RegExp(`^${escaped}\\b`, 'i'));
    if (startMatch) {
      const rest = stripped.slice(startMatch[0].length).trim();
      const nextWord = rest.replace(/^,\s*/, '').split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '');
      if (!nextWord || rest.startsWith(',') || !THIRD_PERSON_PREDICATES.has(nextWord)) return true;
    }

    if (new RegExp(`,\\s*${escaped}[?!.~\\s]*$`, 'i').test(stripped)) return true;
  }

  return false;
}

// Initialize socket and setup event handlers
async function initialize() {
  try {
    // Initialize socket
    await socketManager.init();
    
    // Set up socket event handlers for messages
    socketManager.on('message', async (baileysMsg) => {
      try {
        // Normalize the message
        const msg = normalizeMessage(baileysMsg);
        
        // Skip if from bot itself
        if (msg.fromMe) {
          logger.debug('message.ignored', { reason: 'from_me', messageType: msg.type });
          return;
        }

        // Handle sticker import
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

        // Handle quiz answers
        try {
          if (await tryHandleQuizAnswer(client, msg)) {
            logger.write('INFO', 'route.quiz_answer', { chatId: msg.from, messageType: msg.type });
            return;
          }
        } catch (err) {
          logger.error('route.quiz_answer.failed', err, { chatId: msg.from });
        }

        // Queue command processing
        enqueueCommand(msg.from, async () => {
          try {
            const body = msg.body || '';
            let command;
            let args;

            if (!body.startsWith(BOT_PREFIX)) {
              const mentionsBot = msg.mentionedIds &&
                msg.mentionedIds.includes(client.info?.wid?._serialized || '');
              
              if (mentionsBot) {
                return await sendQuickMenu(msg);
              }

              const quoted = msg.hasQuotedMsg ? await safeGetQuoted(msg).catch(() => null) : null;

              if (quoted && quoted.fromMe) {
                const replyKind = classifyReplyKind(msg);
                if (replyKind === 'other') {
                  logger.debug('message.ignored', { reason: 'unsupported_reply_to_bot', chatId: msg.from, messageType: msg.type });
                  return;
                }
                msg._aiStickerReply = replyKind === 'sticker';
                const typed = (msg.body || '').trim();
                args = typed
                  ? typed.split(/\s+/)
                  : (replyKind === 'image' ? ['Take', 'a', 'look', 'and', 'respond', 'naturally.'] : []);
                command = isVoiceNoteMessage(quoted) ? 'voice' : 'copilot';
              } else {
                const chat = await safeGetChatWrapper(msg);
                if (chat && !chat.isGroup && !String(chat.id?._serialized || '').endsWith('@g.us')) {
                  if (isVoiceNoteMessage(msg)) {
                    command = 'voice';
                    args = [];
                  } else if (msg.type === 'chat' && !msg.hasMedia && body.trim()) {
                    command = isCommandMenuRequest(body) ? 'menu' : 'copilot';
                    args = [body.trim()];
                  } else {
                    logger.debug('message.ignored', { reason: 'unsupported_dm_message', chatId: msg.from, messageType: msg.type });
                    return;
                  }
                } else {
                  if (!isCallingBotByName(body)) {
                    logger.debug('message.ignored', { reason: 'group_not_addressed_to_bot', chatId: msg.from, messageType: msg.type });
                    return;
                  }
                  const quoted = msg.hasQuotedMsg ? await safeGetQuoted(msg).catch(() => null) : null;
                  const quotedText = quoted ? (quoted.body || '').trim() : '';
                  const prompt = quotedText
                    ? `${body}\n\n(They're replying to this message: "${quotedText}")`
                    : body;
                  args = [prompt];
                  command = 'copilot';
                }
              }
            } else {
              args = body.slice(BOT_PREFIX.length).trim().split(/\s+/);
              command = args.shift().toLowerCase();

              if (aliases[command]) command = aliases[command];
            }

            // Registration gate
            const registrationCheck = await checkRegistrationGate(msg, command).catch(err => {
              logger.error('registration.gate.failed_open', err, { command });
              return { blocked: false, senderId: null, wasActive: true };
            });
            if (registrationCheck.blocked) {
              logger.write('INFO', 'registration.blocked', { command, senderId: registrationCheck.senderId, reason: 'incomplete_registration' });
              return;
            }

            // Gemini gate
            if (geminiGate.shouldBlockCommand(command)) {
              logger.write('INFO', 'gemini.gate.blocked', { command, from: msg.from });
              try {
                await msg.reply(geminiGate.BUSY_MESSAGE);
              } catch (replyErr) {
                logger.error('gemini.gate.reply_failed', replyErr, { command });
              }
              return;
            }

            // Task ID and logging
            const taskId = nextTaskId();
            const receivedAt = new Date().toLocaleString();
            const senderName = msg.pushName || msg.author || msg.from;
            const chatLabel = chat?.name || msg.from;
            const queuePosition = inFlightCount + 1;
            const isHeavy = HEAVY_COMMANDS.has(command);
            inFlightCount++;

            logger.write('INFO', 'command.accepted', {
              taskId, command, argsPreview: args.map(arg => String(arg).slice(0, 160)), senderName, chatLabel, receivedAt,
              queuePosition, queue: isHeavy ? 'heavy' : 'normal', from: msg.from,
            });

            // Resolve handler
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
              return await msg.reply(`❌ Unknown command: *${BOT_PREFIX}${command}*\nType *${BOT_PREFIX}menu* to see what's available.`);
            }

            // Usage tracking
            let trackedHandlerFn = handlerFn;
            try {
              const trackChat = await safeGetChatWrapper(msg);
              const trackContact = await safeGetContactWrapper(msg);
              const usageGroupId = trackChat?.isGroup ? trackChat.id._serialized : 'DM';
              const usageUserId = trackContact?.id._serialized || (msg.author || msg.from);
              trackedHandlerFn = wrapWithUsageTracking(handlerFn, { groupId: usageGroupId, userId: usageUserId, command });
            } catch (err) {
              logger.error('usage.context.failed', err, { command });
            }

            if (isHeavy) {
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

              logger.write('INFO', 'queue.heavy.enqueued', { taskId, command, queuePosition: heavyPosition, queued: heavyQueue.length });

              try {
                if (command === 'play') {
                  await msg.react('▶️');
                } else if (command !== 'news') {
                  await msg.react('⏳');
                }
              } catch (err) {
                console.error('Failed to react to queued command:', err.message);
              }

              return;
            }

            // Normal commands
            try {
              await logger.run(`command.${command}`, { taskId, command, argsPreview: args.map(arg => String(arg).slice(0, 160)), senderName, chatLabel, queue: 'normal' }, () => trackedHandlerFn());

              // Post-registration menu send
              if (REGISTRATION_BYPASS_COMMANDS.has(command) && registrationCheck.senderId && !registrationCheck.wasActive) {
                try {
                  const User = await import('../models/User.js');
                  const freshUser = await User.default.findOne({ id: registrationCheck.senderId }, 'registration').lean();
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
      } catch (err) {
        logger.error('message.handler.failed', err, { chatId: msg.from });
      }
    });

    // Setup other event handlers
    socketManager.on('qr', (qr) => {
      console.log('QR Code:', qr);
    });

    socketManager.on('authenticated', () => {
      console.log('✅ WhatsApp authenticated');
    });

    socketManager.on('ready', () => {
      console.log('✅ WhatsApp ready');
      
      // Initialize background tasks
      const scheduler = await import('../utils/scheduler.js');
      const { _initCardLending } = await import('../commands/cards.js');
      const { _initCardDrops } = await import('../commands/cards.js');
      const { _seedParticipants } = await import('../commands/admin.js');
      const { _resumePendingMutes } = await import('../commands/admin.js');
      const { _initAfk } = await import('../commands/afk.js');
      const { _initTTT } = await import('../commands/games/tictactoe.js');
      const { _initC4 } = await import('../commands/games/connect4.js');
      const { _initBattle } = await import('../commands/games/battle.js');
      const { _initChess } = await import('../commands/games/chess.js');
      const { _initQuiz } = await import('../commands/games/quiz.js');

      runLoggedBackgroundTask('scheduler_init', {}, () => scheduler.default.init(client)).catch(err => logger.error('background.scheduler_init.failed', err));
      
      if (_initCardLending) {
        runLoggedBackgroundTask('card_lending_init', {}, () => _initCardLending()).catch(err => logger.error('background.card_lending_init.failed', err));
      }
      
      if (_initCardDrops) {
        runLoggedBackgroundTask('card_drops_init', {}, () => _initCardDrops(client)).catch(err => logger.error('background.card_drops_init.failed', err));
      }
      
      if (_seedParticipants) {
        runLoggedBackgroundTask('participants_seed', {}, () => _seedParticipants(client)).catch(err => logger.error('background.participant_seed.failed', err));
      }
      
      if (_resumePendingMutes) {
        runLoggedBackgroundTask('mute_restore', {}, () => _resumePendingMutes(client)).catch(err => logger.error('background.mute_restore.failed', err));
      }
      
      if (_initAfk) {
        runLoggedBackgroundTask('afk_restore', {}, () => _initAfk()).catch(err => logger.error('background.afk_restore.failed', err));
      }
      
      if (_initTTT) {
        runLoggedBackgroundTask('ttt_restore', {}, () => _initTTT(client)).catch(err => logger.error('background.ttt_restore.failed', err));
      }
      
      if (_initC4) {
        runLoggedBackgroundTask('connect4_restore', {}, () => _initC4(client)).catch(err => logger.error('background.connect4_restore.failed', err));
      }
      
      if (_initBattle) {
        runLoggedBackgroundTask('battle_restore', {}, () => _initBattle()).catch(err => logger.error('background.battle_restore.failed', err));
      }
      
      if (_initChess) {
        runLoggedBackgroundTask('chess_restore', {}, () => _initChess(client)).catch(err => logger.error('background.chess_restore.failed', err));
      }
      
      if (_initQuiz) {
        runLoggedBackgroundTask('quiz_restore', {}, () => _initQuiz(client)).catch(err => logger.error('background.quiz_restore.failed', err));
      }
    });

    socketManager.on('disconnected', (reason) => {
      console.log('❌ WhatsApp disconnected:', reason);
    });

    socketManager.on('error', (err) => {
      console.error('Client error:', err);
    });

    // Group events
    socketManager.on('group_join', async (notification) => {
      try {
        const { commands: cmds } = await import('../commands/admin.js');
        if (cmds && cmds.onJoin) await cmds.onJoin(client, notification);
      } catch (err) {
        console.error('group_join error:', err.message);
      }
    });

    socketManager.on('group_leave', async (notification) => {
      try {
        const { commands: cmds } = await import('../commands/admin.js');
        if (cmds && cmds.onLeave) await cmds.onLeave(client, notification);
      } catch (err) {
        console.error('group_leave error:', err.message);
      }
    });

    // AFK mention check
    socketManager.on('message', async (msg) => {
      try {
        if (msg.fromMe) return;
        const contact = await safeGetContactWrapper(msg);
        const { _checkAfkMentions } = await import('../commands/afk.js');
        if (_checkAfkMentions) await _checkAfkMentions(client, msg);
      } catch (err) {
        console.error('AFK mention check error:', err.message);
      }
    });

    // AFK welcome-back check
    socketManager.on('message', async (msg) => {
      try {
        if (msg.fromMe) return;
        const contact = await safeGetContactWrapper(msg);
        const { _checkAfkReturn } = await import('../commands/afk.js');
        if (_checkAfkReturn) await _checkAfkReturn(msg, contact.id._serialized);
      } catch (err) {
        console.error('AFK welcome-back check failed:', err.message);
      }
    });

    // Activity tracking
    socketManager.on('message', async (msg) => {
      try {
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

        const Group = await import('../models/Group.js');
        const group = await Group.default.findOne({ id: chat.id._serialized });
        if (!group?.antilink) return;

        const contact = await msg.getContact();
        const isAdmin = chat.participants?.some(
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

    // Activity tracking for groups
    socketManager.on('message', async (msg) => {
      try {
        if (!msg.from.endsWith('@g.us')) return;

        const chat = await safeGetChatWrapper(msg);
        const contact = await safeGetContactWrapper(msg);
        const senderId = contact.id._serialized;

        const Group = await import('../models/Group.js');
        
        await withRetry(() => Group.default.findOneAndUpdate(
          { id: chat.id._serialized },
          { $inc: { messageCount: 1 } },
          { upsert: true }
        ));

        await withRetry(() => Group.default.findOneAndUpdate(
          { id: chat.id._serialized },
          { $inc: { messageCount: 1 } },
          { upsert: true }
        ));

        await withRetry(() => GroupActivity.findOneAndUpdate(
          { groupId: chat.id._serialized, userId: senderId },
          { $inc: { count: 1 }, $set: { lastAt: new Date() } },
          { upsert: true }
        ));
      } catch (err) {
        console.error('Activity tracking error:', err.message);
      }
    });

    // Heartbeat
    setInterval(() => {
      runLoggedBackgroundTask('heartbeat', {}, async () => {
        logger.write('INFO', 'heartbeat', { inFlightCommands: inFlightCount, heavyQueueLength: heavyQueue.length, activeChatQueues: commandQueues.size });
      }).catch(err => logger.error('background.heartbeat.unhandled', err));
    }, 60000);

    // Daily stats digest
    setInterval(() => {
      const { _maybeSendDailyStats } = await import('../commands/general.js');
      if (_maybeSendDailyStats) {
        runLoggedBackgroundTask('daily_stats_digest_check', {}, () => _maybeSendDailyStats(client)).catch(err => logger.error('background.daily_stats_digest_check.unhandled', err));
      }
    }, 60000);

    // Inactive user cleanup
    setInterval(() => {
      const { _sweepInactiveUsers } = await import('../commands/admin.js');
      if (_sweepInactiveUsers) {
        runLoggedBackgroundTask('inactive_user_sweep_check', {}, () => _sweepInactiveUsers(client)).catch(err => logger.error('background.inactive_user_sweep_check.unhandled', err));
      }
    }, 60000);

    // Guild events
    setInterval(() => {
      const { _maybeSendGuildEvents } = await import('../commands/guilds.js');
      if (_maybeSendGuildEvents) {
        runLoggedBackgroundTask('guild_events_check', {}, () => _maybeSendGuildEvents(client)).catch(err => logger.error('background.guild_events_check.unhandled', err));
      }
    }, 60000);

    // Daily news broadcast
    setInterval(() => {
      const { _maybeSendDailyNews } = await import('../commands/news.js');
      if (_maybeSendDailyNews) {
        runLoggedBackgroundTask('daily_news_broadcast_check', {}, () => _maybeSendDailyNews(client)).catch(err => logger.error('background.daily_news_broadcast_check.unhandled', err));
      }
    }, 60000);

    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log(`║                    ${BOT_NAME} is ONLINE                      ║`);
    console.log(`║  Prefix : ${BOT_PREFIX}                                                  ║`);
    console.log(`║  Commands: ${Object.keys(commands).length}                                               ║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('Initialization error:', error);
    process.exit(1);
  }
}

// Start the bot
console.log('Starting Ani-Chan Bot with Baileys...');
initialize().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export default client;
