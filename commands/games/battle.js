const { rand, safeGetChat, resolveNameById } = require('../../utils/helpers');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { p1: { id, name, hp }, p2: { id, name, hp }, turn }
const battleGames = new Map();

module.exports = {
  battleGames,

  // .startbattle @user
  async startbattle(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();

    if (!mentioned.length) return msg.reply('❌ Usage: .startbattle @user');
    if (battleGames.has(chat.id._serialized)) return msg.reply('❌ A battle is already happening!');

    const playerId = contact.id._serialized;
    const opponentId = mentioned[0].id._serialized;

    // Same fix as the other games: the sender's name is always accurate,
    // but a freshly-mentioned opponent's often isn't synced yet.
    const [playerName, opponentName] = await Promise.all([
      resolveNameById(client, playerId),
      resolveNameById(client, opponentId),
    ]);

    const p1 = { id: playerId, name: playerName, hp: 100 };
    const p2 = { id: opponentId, name: opponentName, hp: 100 };

    battleGames.set(chat.id._serialized, { p1, p2, turn: p1.id });

    msg.reply(
      `⚔️ *Battle Start!*\n\n🔵 ${p1.name} — ❤️ ${p1.hp} HP\n🔴 ${p2.name} — ❤️ ${p2.hp} HP\n\n${p1.name}'s turn! Use *.attack*, *.defend*, or *.flee*.`
    );
  },

  // .attack
  async attack(client, msg, args) {
    const chat = await safeGetChat(msg);
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
    const contact = await msg.getContact();
    const game = battleGames.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active battle.');

    // Previously missing: anyone in the group could end someone else's
    // battle by typing .flee, since there was no check that the caller was
    // actually one of the two combatants (.attack/.defend get this for free
    // via their turn check; .flee had no equivalent).
    const playerId = contact.id._serialized;
    const fleeingPlayer = game.p1.id === playerId ? game.p1 : (game.p2.id === playerId ? game.p2 : null);
    if (!fleeingPlayer) return msg.reply("❌ You're not part of this battle!");

    battleGames.delete(chat.id._serialized);
    msg.reply(`🏃 *${fleeingPlayer.name}* fled from the battle! Coward! 😂`);
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
    return { quitterName: quitter.name, winnerName: winner.name };
  },
};
