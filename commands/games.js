const { pick, rand, mentionName, safeGetChat } = require('../utils/helpers');
const { Chess } = require('chess.js');
const tictactoe = require('./games/tictactoe');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
const c4Games = new Map();      // chatId -> { board, turn, players }
const chessGames = new Map();   // chatId -> Chess instance + players
const battleGames = new Map();  // chatId -> { players, hp }

// ─── Connect 4 Helpers ────────────────────────────────────────────────────────
function renderC4(board) {
  return board.map(r => r.join(' ')).join('\n') + '\n1 2 3 4 5 6 7';
}

function dropC4(board, col, piece) {
  for (let r = 5; r >= 0; r--) {
    if (board[r][col] === '⬛') { board[r][col] = piece; return r; }
  }
  return -1;
}

function checkC4Win(board, piece) {
  // Horizontal, vertical, diagonal checks
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (c + 3 < 7 && [0,1,2,3].every(i => board[r][c+i] === piece)) return true;
      if (r + 3 < 6 && [0,1,2,3].every(i => board[r+i][c] === piece)) return true;
      if (r + 3 < 6 && c + 3 < 7 && [0,1,2,3].every(i => board[r+i][c+i] === piece)) return true;
      if (r + 3 < 6 && c - 3 >= 0 && [0,1,2,3].every(i => board[r+i][c-i] === piece)) return true;
    }
  }
  return false;
}

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
  async c4(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();

    if (!mentioned.length) return msg.reply('❌ Usage: .c4 @user');
    if (c4Games.has(chat.id._serialized)) return msg.reply('❌ A game is already active!');

    const board = Array.from({ length: 6 }, () => Array(7).fill('⬛'));
    const players = [
      { id: contact.id._serialized, name: contact.pushname, piece: '🔴' },
      { id: mentioned[0].id._serialized, name: mentioned[0].pushname, piece: '🟡' },
    ];

    c4Games.set(chat.id._serialized, { board, turn: 0, players });
    msg.reply(`🎮 *Connect 4*\n🔴 ${players[0].name} vs 🟡 ${players[1].name}\n\n${renderC4(board)}\n\n🔴 ${players[0].name}'s turn! Type *.drop [1-7]* to play.`);
  },

  // .drop [col]
  async drop(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const game = c4Games.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active Connect 4 game.');

    const current = game.players[game.turn];
    if (current.id !== contact.id._serialized) return msg.reply('❌ Not your turn!');

    const col = parseInt(args[0]) - 1;
    if (isNaN(col) || col < 0 || col > 6) return msg.reply('❌ Choose a column 1-7.');

    const row = dropC4(game.board, col, current.piece);
    if (row === -1) return msg.reply('❌ Column full! Choose another.');

    if (checkC4Win(game.board, current.piece)) {
      c4Games.delete(chat.id._serialized);
      return msg.reply(`${renderC4(game.board)}\n\n🏆 *${current.name} wins Connect 4!*`);
    }

    game.turn = game.turn === 0 ? 1 : 0;
    c4Games.set(chat.id._serialized, game);
    const next = game.players[game.turn];
    msg.reply(`${renderC4(game.board)}\n\n${next.piece} *${next.name}'s* turn!`);
  },

  // .wcg — would you rather (group game)
  async wcg(client, msg, args) {
    const q = pick(WCG_QUESTIONS);
    msg.reply(`🎮 *Would You Rather?*\n\n${q.q}\n\nA) ${q.opts[0]}\nB) ${q.opts[1]}\n\nReply A or B!`);
  },

  // .chess
  async chess(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();

    if (!mentioned.length) return msg.reply('❌ Usage: .chess @user');
    if (chessGames.has(chat.id._serialized)) return msg.reply('❌ A game is already active!');

    const chess = new Chess();
    chessGames.set(chat.id._serialized, {
      chess,
      white: contact.id._serialized,
      black: mentioned[0].id._serialized,
      whiteName: contact.pushname,
      blackName: mentioned[0].pushname,
    });

    msg.reply(
      `♟️ *Chess*\n\n♔ White: ${contact.pushname}\n♚ Black: ${mentioned[0].pushname}\n\n${chess.ascii()}\n\nWhite goes first! Use *.move [e2e4]* (from-to format).`
    );
  },

  // .move [e2e4]
  async move(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    const contact = await msg.getContact();
    const game = chessGames.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No chess game active.');

    const isWhite = game.white === contact.id._serialized;
    const isBlack = game.black === contact.id._serialized;
    if (!isWhite && !isBlack) return msg.reply('❌ You are not in this game.');

    const turn = game.chess.turn() === 'w' ? game.white : game.black;
    if (contact.id._serialized !== turn) return msg.reply('❌ Not your turn!');

    const moveStr = args[0];
    if (!moveStr) return msg.reply('❌ Usage: .move [e2e4]');

    const from = moveStr.slice(0, 2);
    const to = moveStr.slice(2, 4);
    const result = game.chess.move({ from, to, promotion: 'q' });

    if (!result) return msg.reply('❌ Invalid move!');

    if (game.chess.isGameOver()) {
      const winner = game.chess.isCheckmate()
        ? (game.chess.turn() === 'w' ? game.blackName : game.whiteName)
        : 'Nobody (Draw)';
      chessGames.delete(chat.id._serialized);
      return msg.reply(`${game.chess.ascii()}\n\n♟️ *Game Over!*\n🏆 Winner: ${winner}`);
    }

    const nextName = game.chess.turn() === 'w' ? game.whiteName : game.blackName;
    msg.reply(`${game.chess.ascii()}\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}*${nextName}'s* turn!`);
  },
};
