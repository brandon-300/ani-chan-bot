const { MessageMedia } = require('whatsapp-web.js');
const { rand, safeGetChat, resolveNameById } = require('../../utils/helpers');
const { chooseAction } = require('./battleEngine');
const { renderBoardImage } = require('./battleBoardImage');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { p1: { id, name, hp }, p2: { id, name, hp }, turn, mode, difficulty }
// Same conventions as chessGames/tttGames/c4Games: in bot mode the human is
// always p1 and p2.id is the literal string 'BOT' — never a real WhatsApp
// id, so it can never accidentally match one.
const battleGames = new Map();

const DIFFICULTY_KEYS = ['easy', 'medium', 'hard'];

// Sends the current HP totals as an image HUD with `caption`. Falls back to
// the plain-text HP summary (with the same caption appended) if image
// rendering fails for any reason, so the battle is never blocked by it —
// same pattern as sendBoard() in chess.js/tictactoe.js/connect4.js. Uses
// msg.reply() (a real quoted reply bubble under the triggering command),
// not chat.sendMessage() — that was a bug found and fixed in all three of
// those files after the fact, so this one is built with it from the start.
async function sendBoard(msg, game, { turnSide = null, lastAction = null, caption }) {
  try {
    const png = renderBoardImage({ p1Hp: game.p1.hp, p2Hp: game.p2.hp, turnSide, lastAction });
    const media = new MessageMedia('image/png', png.toString('base64'), 'battle-hud.png');
    await msg.reply(media, undefined, { caption });
  } catch (err) {
    console.error('Battle HUD image render failed, falling back to text summary:', err.message);
    await msg.reply(`🔵 ${game.p1.name}: ❤️ ${game.p1.hp}\n🔴 ${game.p2.name}: ❤️ ${game.p2.hp}\n\n${caption}`);
  }
}

module.exports = {
  battleGames,

  // .startbattle @user — fight another person
  // .startbattle [easy|medium|hard] — fight the bot (defaults to medium)
  async startbattle(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const chatId = chat.id._serialized;

    if (battleGames.has(chatId)) return msg.reply('❌ A battle is already happening!');

    const busy = isChatBusy(chatId);
    if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

    const playerId = contact.id._serialized;
    const playerName = await resolveNameById(client, playerId);

    if (mentioned.length) {
      // ── vs person ────────────────────────────────────────────────────────
      const opponentId = mentioned[0].id._serialized;
      const opponentName = await resolveNameById(client, opponentId);

      const p1 = { id: playerId, name: playerName, hp: 100 };
      const p2 = { id: opponentId, name: opponentName, hp: 100 };

      const game = { p1, p2, turn: p1.id, mode: 'pvp' };
      battleGames.set(chatId, game);
      claim(chatId, 'battle');

      return sendBoard(msg, game, {
        turnSide: 'p1',
        caption: `⚔️ *Battle Start!*\n🔵 ${p1.name} vs 🔴 ${p2.name}\n\n${p1.name}'s turn! Use *.attack*, *.defend*, or *.flee*.`,
      });
    }

    // ── vs bot ────────────────────────────────────────────────────────────
    const difficultyLabel = DIFFICULTY_KEYS.includes((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'medium';
    const p1 = { id: playerId, name: playerName, hp: 100 };
    const p2 = { id: 'BOT', name: `🤖 ${BOT_NAME}`, hp: 100 };

    const game = { p1, p2, turn: p1.id, mode: 'bot', difficulty: difficultyLabel };
    battleGames.set(chatId, game);
    claim(chatId, 'battle');

    return sendBoard(msg, game, {
      turnSide: 'p1',
      caption: `⚔️ *Battle vs ${BOT_NAME}* (${difficultyLabel})\n🔵 You: ${p1.name}\n🔴 🤖 ${BOT_NAME}\n\nYour turn! Use *.attack*, *.defend*, or *.flee*.`,
    });
  },

  // .attack — shared by both PvP and vs-bot games
  async attack(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const game = battleGames.get(chatId);
    if (!game) return msg.reply('❌ No active battle. Use .startbattle @user');

    // BUGFIX (Aug 2026): this used to skip straight to the turn check below,
    // so a non-participant typing .attack while two other people were
    // fighting got told "❌ Not your turn!" — which reads as if they WERE
    // in the battle, just waiting their turn. .flee already had the correct
    // participant-first check; .attack/.defend didn't.
    const playerId = contact.id._serialized;
    if (game.p1.id !== playerId && game.p2.id !== playerId) {
      return msg.reply("❌ You're not part of this battle!");
    }
    if (game.turn !== playerId) return msg.reply('❌ Not your turn!');

    const dmg = rand(10, 35);
    const isP1 = game.p1.id === contact.id._serialized;
    const target = isP1 ? game.p2 : game.p1;
    const attacker = isP1 ? game.p1 : game.p2;
    const targetSide = isP1 ? 'p2' : 'p1';

    target.hp = Math.max(0, target.hp - dmg);
    game.turn = target.id;

    if (target.hp <= 0) {
      battleGames.delete(chatId);
      release(chatId, 'battle');
      return sendBoard(msg, game, {
        turnSide: null,
        lastAction: { side: targetSide, delta: -dmg },
        caption: `⚔️ *${attacker.name}* dealt ${dmg} damage!\n💀 *${target.name}* has been defeated!\n🏆 *Winner: ${attacker.name}*!`,
      });
    }

    // ── vs bot: it replies with its own action in this same message ──────
    if (game.mode === 'bot' && game.turn === 'BOT') {
      const botAction = chooseAction(game.p2.hp, game.p1.hp, game.difficulty);
      let botCaption;
      let botLastAction;

      if (botAction === 'attack') {
        const botDmg = rand(10, 35);
        game.p1.hp = Math.max(0, game.p1.hp - botDmg);
        botLastAction = { side: 'p1', delta: -botDmg };

        if (game.p1.hp <= 0) {
          battleGames.delete(chatId);
          release(chatId, 'battle');
          return sendBoard(msg, game, {
            turnSide: null,
            lastAction: botLastAction,
            caption: `⚔️ *${attacker.name}* dealt ${dmg} damage!\n🤖 ${BOT_NAME} struck back for *${botDmg} damage*!\n💀 *${game.p1.name}* has been defeated!\n🏆 *Winner: ${BOT_NAME}*!`,
          });
        }
        botCaption = `⚔️ *${attacker.name}* dealt ${dmg} damage!\n🤖 ${BOT_NAME} attacked back for *${botDmg} damage*!`;
      } else {
        const botHeal = rand(5, 15);
        game.p2.hp = Math.min(100, game.p2.hp + botHeal);
        botLastAction = { side: 'p2', delta: botHeal };
        botCaption = `⚔️ *${attacker.name}* dealt ${dmg} damage!\n🛡️ 🤖 ${BOT_NAME} defended and recovered *${botHeal} HP*!`;
      }

      game.turn = game.p1.id; // back to the human
      battleGames.set(chatId, game);
      return sendBoard(msg, game, {
        turnSide: 'p1',
        lastAction: botLastAction,
        caption: `${botCaption}\n\nYour turn! Use *.attack*, *.defend*, or *.flee*.`,
      });
    }

    // ── vs person ─────────────────────────────────────────────────────────
    battleGames.set(chatId, game);
    return sendBoard(msg, game, {
      turnSide: targetSide,
      lastAction: { side: targetSide, delta: -dmg },
      caption: `⚔️ *${attacker.name}* hit ${target.name} for *${dmg} damage*!\n\n${target.name}'s turn!`,
    });
  },

  // .defend — shared by both PvP and vs-bot games
  async defend(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const game = battleGames.get(chatId);
    if (!game) return msg.reply('❌ No active battle.');

    // Same participant-first check as .attack — see the BUGFIX comment
    // there for why the plain turn check alone isn't enough.
    const playerId = contact.id._serialized;
    if (game.p1.id !== playerId && game.p2.id !== playerId) {
      return msg.reply("❌ You're not part of this battle!");
    }
    if (game.turn !== playerId) return msg.reply('❌ Not your turn!');

    const heal = rand(5, 15);
    const isP1 = game.p1.id === contact.id._serialized;
    const defender = isP1 ? game.p1 : game.p2;
    const other = isP1 ? game.p2 : game.p1;
    const defenderSide = isP1 ? 'p1' : 'p2';

    defender.hp = Math.min(100, defender.hp + heal);
    game.turn = other.id;

    // ── vs bot: it replies with its own action in this same message ──────
    if (game.mode === 'bot' && game.turn === 'BOT') {
      const botAction = chooseAction(game.p2.hp, game.p1.hp, game.difficulty);
      let botCaption;
      let botLastAction;

      if (botAction === 'attack') {
        const botDmg = rand(10, 35);
        game.p1.hp = Math.max(0, game.p1.hp - botDmg);
        botLastAction = { side: 'p1', delta: -botDmg };

        if (game.p1.hp <= 0) {
          battleGames.delete(chatId);
          release(chatId, 'battle');
          return sendBoard(msg, game, {
            turnSide: null,
            lastAction: botLastAction,
            caption: `🛡️ *${defender.name}* defended and recovered *${heal} HP*!\n🤖 ${BOT_NAME} attacked for *${botDmg} damage*!\n💀 *${game.p1.name}* has been defeated!\n🏆 *Winner: ${BOT_NAME}*!`,
          });
        }
        botCaption = `🛡️ *${defender.name}* defended and recovered *${heal} HP*!\n🤖 ${BOT_NAME} attacked for *${botDmg} damage*!`;
      } else {
        const botHeal = rand(5, 15);
        game.p2.hp = Math.min(100, game.p2.hp + botHeal);
        botLastAction = { side: 'p2', delta: botHeal };
        botCaption = `🛡️ *${defender.name}* defended and recovered *${heal} HP*!\n🛡️ 🤖 ${BOT_NAME} also defended and recovered *${botHeal} HP*!`;
      }

      game.turn = game.p1.id; // back to the human
      battleGames.set(chatId, game);
      return sendBoard(msg, game, {
        turnSide: 'p1',
        lastAction: botLastAction,
        caption: `${botCaption}\n\nYour turn! Use *.attack*, *.defend*, or *.flee*.`,
      });
    }

    // ── vs person ─────────────────────────────────────────────────────────
    battleGames.set(chatId, game);
    return sendBoard(msg, game, {
      turnSide: isP1 ? 'p2' : 'p1',
      lastAction: { side: defenderSide, delta: heal },
      caption: `🛡️ *${defender.name}* defended and recovered *${heal} HP*!\n\n${other.name}'s turn!`,
    });
  },

  // .flee
  async flee(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const game = battleGames.get(chatId);
    if (!game) return msg.reply('❌ No active battle.');

    // Anyone in the group could otherwise end someone else's battle by
    // typing .flee, since there was no check that the caller was actually
    // one of the two combatants (.attack/.defend get this for free via
    // their turn check; .flee had no equivalent).
    const playerId = contact.id._serialized;
    const fleeingPlayer = game.p1.id === playerId ? game.p1 : (game.p2.id === playerId ? game.p2 : null);
    if (!fleeingPlayer) return msg.reply("❌ You're not part of this battle!");

    battleGames.delete(chatId);
    release(chatId, 'battle');
    return sendBoard(msg, game, {
      turnSide: null,
      caption: `🏃 *${fleeingPlayer.name}* fled from the battle! Coward! 😂`,
    });
  },

  // Ends an in-progress battle as a forfeit by `playerId` in `chatId`, if
  // they're in one. Returns null when there's no battle for them here, so
  // the shared .quitgame command can fall through and try other game types.
  quitBattle(chatId, playerId) {
    const game = battleGames.get(chatId);
    if (!game) return null;
    if (game.p1.id !== playerId && game.p2.id !== playerId) return null;

    const quitter = game.p1.id === playerId ? game.p1 : game.p2;
    const winner = game.p1.id === playerId ? game.p2 : game.p1;
    battleGames.delete(chatId);
    release(chatId, 'battle');
    return { quitterName: quitter.name, winnerName: winner.name };
  },
};
