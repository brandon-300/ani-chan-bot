const { pick, mentionName, safeGetChat, resolveNameById } = require('../utils/helpers');
const tictactoe = require('./games/tictactoe');
const connect4 = require('./games/connect4');
const chessGame = require('./games/chess');
const battle = require('./games/battle');

const GREEK_GODS = [
  { name: 'Zeus', domain: 'Sky & Thunder', symbol: '⚡' },
  { name: 'Poseidon', domain: 'Sea', symbol: '🌊' },
  { name: 'Athena', domain: 'Wisdom', symbol: '🦉' },
  { name: 'Apollo', domain: 'Sun & Arts', symbol: '☀️' },
  { name: 'Artemis', domain: 'Moon & Hunt', symbol: '🌙' },
  { name: 'Ares', domain: 'War', symbol: '⚔️' },
  { name: 'Aphrodite', domain: 'Love', symbol: '💕' },
  { name: 'Hermes', domain: 'Travel', symbol: '🪄' },
  { name: 'Hephaestus', domain: 'Fire & Forge', symbol: '🔥' },
  { name: 'Demeter', domain: 'Harvest', symbol: '🌾' },
  { name: 'Dionysus', domain: 'Wine', symbol: '🍇' },
  { name: 'Hades', domain: 'Underworld', symbol: '💀' },
];

const WCG_QUESTIONS = [
  { q: 'Would you rather fight 100 duck-sized horses or 1 horse-sized duck?', opts: ['100 duck-sized horses', '1 horse-sized duck'] },
  { q: 'Would you rather always be 10 minutes late or 20 minutes early?', opts: ['Always late', 'Always early'] },
  { q: 'Would you rather have no fingers or no toes?', opts: ['No fingers', 'No toes'] },
];

// ─── Akinator-style guessing (simplified) ─────────────────────────────────────
const akinatorSessions = new Map();

const AKI_QUESTIONS = [
  'Is your character male? (yes/no)',
  'Is your character from an anime? (yes/no)',
  'Is your character a hero? (yes/no)',
  'Is your character known for their power? (yes/no)',
  'Is your character popular worldwide? (yes/no)',
];

module.exports = {
  battleGames: battle.battleGames,
  ttt: tictactoe.ttt,
  tttGames: tictactoe.tttGames,

  // .quitgame / .quit — forfeit whichever game you're currently in. Your
  // opponent is declared the winner regardless of the current board state.
  async quitgame(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const playerId = contact.id._serialized;

    // Tic Tac Toe
    const tttResult = tictactoe.quitTTT(chatId, playerId);
    if (tttResult) {
      return msg.reply(`🚩 *${tttResult.quitterName}* quit Tic Tac Toe.\n🏆 *${tttResult.winnerName} wins by forfeit!*`);
    }

    // Connect 4
    const c4Result = connect4.quitC4(chatId, playerId);
    if (c4Result) {
      return msg.reply(`🚩 *${c4Result.quitterName}* quit Connect 4.\n🏆 *${c4Result.winnerName} wins by forfeit!*`);
    }

    // Chess
    const chessResult = chessGame.quitChess(chatId, playerId);
    if (chessResult) {
      return msg.reply(`🚩 *${chessResult.quitterName}* resigned from Chess.\n🏆 *${chessResult.winnerName} wins by forfeit!*`);
    }

    // Battle
    const battleResult = battle.quitBattle(chatId, playerId);
    if (battleResult) {
      return msg.reply(`🚩 *${battleResult.quitterName}* fled the battle.\n🏆 *${battleResult.winnerName} wins by forfeit!*`);
    }

    return msg.reply("❌ You're not currently in any game.");
  },

  // .startbattle
  startbattle: battle.startbattle,

  // .attack
  attack: battle.attack,

  // .defend
  defend: battle.defend,

  // .flee
  flee: battle.flee,

  // .akinator
  async akinator(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();

    akinatorSessions.set(chat.id._serialized, {
      userId: contact.id._serialized,
      step: 0,
      answers: [],
    });

    msg.reply(`🔮 *Akinator*\n\nThink of a character and I'll guess it!\n\nQ1: ${AKI_QUESTIONS[0]}`);
  },

  // .greekgod
  async greekgod(client, msg, args) {
    const god = pick(GREEK_GODS);
    const contact = await msg.getContact();
    msg.reply(
      `🏛️ *Your Greek God*\n\n${god.symbol} *${god.name}*\nDomain: ${god.domain}\n\nYou embody the spirit of ${god.name}, ${contact.pushname}!`
    );
  },

  // .c4 — connect 4
  c4: connect4.c4,

  // .drop [col]
  drop: connect4.drop,

  // .wcg — would you rather (group game)
  async wcg(client, msg, args) {
    const q = pick(WCG_QUESTIONS);
    msg.reply(`🎮 *Would You Rather?*\n\n${q.q}\n\nA) ${q.opts[0]}\nB) ${q.opts[1]}\n\nReply A or B!`);
  },

  // .chess @user (play a person) | .chess [easy|medium|hard] (play the bot)
  chess: chessGame.chess,

  // .move [e2e4]
  move: chessGame.move,
};
