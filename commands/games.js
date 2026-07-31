const { pick, rand, mentionName, safeGetChat, resolveNameById } = require('../utils/helpers');
const tictactoe = require('./games/tictactoe');
const connect4 = require('./games/connect4');
const chessGame = require('./games/chess');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
const battleGames = new Map();  // chatId -> { players, hp }

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
  battleGames,
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
    const battleGame = battleGames.get(chatId);
    if (battleGame && (battleGame.p1.id === playerId || battleGame.p2.id === playerId)) {
      battleGames.delete(chatId);
      const opponent = battleGame.p1.id === playerId ? battleGame.p2 : battleGame.p1;
      return msg.reply(`🚩 *${contact.pushname}* fled the battle.\n🏆 *${opponent.name} wins by forfeit!*`);
    }

    return msg.reply("❌ You're not currently in any game.");
  },

  // .startbattle
  async startbattle(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();

    if (!mentioned.length) return msg.reply('❌ Usage: .startbattle @user');
    if (battleGames.has(chat.id._serialized)) return msg.reply('❌ A battle is already happening!');

    const p1 = { id: contact.id._serialized, name: contact.pushname, hp: 100 };
    const p2 = { id: mentioned[0].id._serialized, name: mentioned[0].pushname, hp: 100 };

    battleGames.set(chat.id._serialized, { p1, p2, turn: p1.id });

    msg.reply(
      `⚔️ *Battle Start!*\n\n🔵 ${p1.name} — ❤️ ${p1.hp} HP\n🔴 ${p2.name} — ❤️ ${p2.hp} HP\n\n${p1.name}'s turn! Use *.attack*, *.defend*, or *.flee*.`
    );
  },

  // .attack
  async attack(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const game = battleGames.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active battle. Use .startbattle @user');
    if (game.turn !== contact.id._serialized) return msg.reply('❌ Not your turn!');

    const dmg = rand(10, 35);
    const isP1 = game.p1.id === contact.id._serialized;
    const target = isP1 ? game.p2 : game.p1;
    const attacker = isP1 ? game.p1 : game.p2;

    target.hp = Math.max(0, target.hp - dmg);
    game.turn = target.id;

    if (target.hp <= 0) {
      battleGames.delete(chat.id._serialized);
      return msg.reply(`⚔️ *${attacker.name}* dealt ${dmg} damage!\n💀 *${target.name}* has been defeated!\n🏆 *Winner: ${attacker.name}*!`);
    }

    battleGames.set(chat.id._serialized, game);
    msg.reply(`⚔️ *${attacker.name}* hit ${target.name} for *${dmg} damage*!\n\n🔵 ${game.p1.name}: ❤️ ${game.p1.hp}\n🔴 ${game.p2.name}: ❤️ ${game.p2.hp}\n\n${target.name}'s turn!`);
  },

  // .defend
  async defend(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const game = battleGames.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active battle.');
    if (game.turn !== contact.id._serialized) return msg.reply('❌ Not your turn!');

    const heal = rand(5, 15);
    const isP1 = game.p1.id === contact.id._serialized;
    const defender = isP1 ? game.p1 : game.p2;
    const other = isP1 ? game.p2 : game.p1;

    defender.hp = Math.min(100, defender.hp + heal);
    game.turn = other.id;

    battleGames.set(chat.id._serialized, game);
    msg.reply(`🛡️ *${defender.name}* defended and recovered *${heal} HP*!\n\n🔵 ${game.p1.name}: ❤️ ${game.p1.hp}\n🔴 ${game.p2.name}: ❤️ ${game.p2.hp}\n\n${other.name}'s turn!`);
  },

  // .flee
  async flee(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const game = battleGames.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active battle.');

    battleGames.delete(chat.id._serialized);
    msg.reply(`🏃 *${contact.pushname}* fled from the battle! Coward! 😂`);
  },

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
