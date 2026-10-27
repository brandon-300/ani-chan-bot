const User = require('../models/User');
const Group = require('../models/Group');
const ScheduledTask = require('../models/ScheduledTask');
const scheduler = require('./scheduler');
const GameSession = require('../models/GameSession');
const runtime = require('./gameRuntime');
const { transaction, BusinessError } = require('./transaction');

async function useSpecialItem(userId, itemName, chatId) {
  await transaction(async (session) => {
    const user = await User.findOne({ id: userId }).session(session);
    const index = user?.inventory.indexOf(itemName) ?? -1;
    if (index < 0) throw new BusinessError('❌ Item not in inventory.');
    if (itemName === 'VIP Badge') {
      if (user.profile.badge === '👑 VIP')
        throw new BusinessError('👑 Your VIP badge is already active. The item was kept.');
      user.profile.badge = '👑 VIP';
    } else {
      if (!chatId?.endsWith('@g.us'))
        throw new BusinessError('❌ Use Lucky Charm in a group with card drops enabled.');
      const group = await Group.findOne({ id: chatId, cardsEnabled: true }).session(session);
      if (!group) throw new BusinessError('❌ Card drops are disabled here. The charm was kept.');
      const now = Date.now();
      if (group.charmExpiresAt && group.charmExpiresAt.getTime() > now)
        throw new BusinessError('🍀 This group already has an active charm. The item was kept.');
      const task = await ScheduledTask.findOne({ key: `card_drop:${chatId}` }).session(session);
      const runAt = new Date(Math.min(task?.runAt?.getTime() ?? Infinity, now + 150000));
      await Group.updateOne(
        { _id: group._id },
        { $set: { charmExpiresAt: new Date(now + 3600000), nextDropAt: runAt } },
        { session }
      );
      await ScheduledTask.updateOne(
        { key: `card_drop:${chatId}` },
        {
          $set: {
            type: 'card_drop',
            payload: { chatId },
            runAt,
            status: 'pending',
            attempts: 0,
            lockedUntil: null,
            runToken: null,
          },
        },
        { upsert: true, session }
      );
    }
    user.inventory.splice(index, 1);
    await user.save({ session });
  });
  await scheduler._armNext();
}
async function healBattle(userId, chatId) {
  return runtime.lock(chatId, async () => {
    const saved = await transaction(async (session) => {
      const user = await User.findOne({ id: userId }).session(session);
      const match = await GameSession.findOne({ chatId, type: 'battle', players: userId }).session(
        session
      );
      const index = user?.inventory.indexOf('Health Potion') ?? -1;
      if (!match || index < 0)
        throw new BusinessError('❌ An active battle and a Health Potion are required.');
      const player = match.state.p1.id === userId ? match.state.p1 : match.state.p2;
      const healed = Math.min(30, 100 - player.hp);
      if (healed <= 0) throw new BusinessError('Your HP is already full. The potion was kept.');
      player.hp += healed;
      user.inventory.splice(index, 1);
      match.markModified('state');
      await user.save({ session });
      await match.save({ session });
      return { state: match.state, healed, hp: player.hp };
    });
    require('../commands/games/battle').battleGames.set(chatId, saved.state);
    return saved;
  });
}
module.exports = { useSpecialItem, healBattle };
