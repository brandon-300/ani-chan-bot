const User = require('../models/User');
const Guild = require('../models/Guild');
const { OwnedCard, Auction, TradeRequest, SaleRequest } = require('../models/Card');
const ScheduledTask = require('../models/ScheduledTask');
const AssetCleanup = require('../models/AssetCleanup');
const GameSession = require('../models/GameSession');
const { transaction, BusinessError } = require('./transaction');
const { isOwner } = require('./helpers');
const scheduler = require('./scheduler');

async function deleteUser(id, { cutoff } = {}) {
  if (isOwner(id)) throw new BusinessError('The configured owner cannot be deleted.');
  await AssetCleanup.init();
  const deleted = await transaction(async (session) => {
    const user = await User.findOne({ id }).session(session);
    if (!user) return null;
    if (cutoff && (!user.lastActiveAt || user.lastActiveAt >= cutoff)) return null;
    if (user.loan?.active) throw new BusinessError('Active bank loan: repay or resolve it first.');
    if (await Guild.exists({ leaderId: id }).session(session))
      throw new BusinessError('Guild leader: transfer leadership or disband first.');
    if (
      await Auction.exists({
        isActive: true,
        $or: [{ sellerId: id }, { currentBidder: id }],
      }).session(session)
    )
      throw new BusinessError('Active auction obligation: wait for settlement first.');
    if (
      await OwnedCard.exists({
        $or: [
          { ownerId: id, $or: [{ isStaked: true }, { isLent: true }, { isAuctioned: true }] },
          { lentTo: id, isLent: true },
        ],
      }).session(session)
    )
      throw new BusinessError('Staked, lent or auctioned card: resolve it first.');
    const guilds = await Guild.find({
      $or: [{ 'members.userId': id }, { pendingInvites: id }, { pendingApplications: id }],
    }).session(session);
    for (const guild of guilds) {
      guild.members = guild.members.filter((m) => m.userId !== id);
      guild.pendingInvites = guild.pendingInvites.filter((value) => value !== id);
      guild.pendingApplications = guild.pendingApplications.filter((value) => value !== id);
      await guild.save({ session });
    }
    // Offers have not transferred any value; cancel them in the same transaction.
    await TradeRequest.deleteMany({ $or: [{ initiatorId: id }, { partnerId: id }] }, { session });
    await SaleRequest.deleteMany({ $or: [{ sellerId: id }, { buyerId: id }] }, { session });
    await OwnedCard.deleteMany({ ownerId: id }, { session }); // catalogue stays available for future drops
    await Auction.deleteMany(
      { isActive: false, $or: [{ sellerId: id }, { currentBidder: id }] },
      { session }
    );
    const games = await GameSession.find(
      { $or: [{ players: id }, { 'state.ownerId': id }] },
      'chatId'
    ).session(session);
    await GameSession.deleteMany({ _id: { $in: games.map((game) => game._id) } }, { session });
    await require('../models/GameResult').deleteMany({ players: id }, { session });
    for (const name of [
      'EmailVerification',
      'CommandUsage',
      'GroupActivity',
      'AntibotWarn',
      'AkinatorSession',
    ]) {
      await require(`../models/${name}`).deleteMany({ userId: id }, { session });
    }
    await require('../models/AgeVerification').deleteMany({ id }, { session });
    await require('../models/AiConversation').deleteMany(
      { $or: [{ senderId: id }, { chatId: id }] },
      { session }
    );
    await require('../models/EconomyReceipt').deleteMany(
      { $or: [{ senderId: id }, { receiverId: id }] },
      { session }
    );
    // Shared group AI conversations contain no per-message author key; retain the shared thread.
    if (user.profile?.picPublicId) {
      const [asset] = await AssetCleanup.create(
        [{ userId: id, publicId: user.profile.picPublicId }],
        { session }
      );
      await ScheduledTask.create(
        [
          {
            type: 'asset_cleanup',
            key: `asset_cleanup:${asset._id}`,
            runAt: new Date(),
            payload: { id: String(asset._id) },
          },
        ],
        { session }
      );
    }
    const result = await User.deleteOne({ _id: user._id, __v: user.__v }, { session });
    if (result.deletedCount !== 1)
      throw new BusinessError('Account changed during deletion; nothing was deleted.');
    return { id, name: user.name, chats: games.map((game) => game.chatId) };
  });
  if (deleted) {
    require('./gameRuntime').forgetUser(id);
    for (const chat of deleted.chats) require('./gameRuntime').forgetChat(chat);
    const afk = require('../commands/afk');
    afk.afkUsers.delete(id);
    afk.lastActive.delete(id);
    await scheduler._armNext();
  }
  return deleted;
}
async function reconcile() {
  for (const asset of await AssetCleanup.find({}))
    await scheduler.scheduleIfMissing({
      type: 'asset_cleanup',
      key: `asset_cleanup:${asset._id}`,
      runAt: asset.notBefore || new Date(),
      payload: { id: String(asset._id) },
    });
}
scheduler.registerHandler('asset_cleanup', async ({ id }) => {
  const asset = await AssetCleanup.findById(id);
  if (!asset) return;
  // Historical assets may reuse ids. Never delete an image currently linked to a profile.
  if (!(await User.exists({ 'profile.picPublicId': asset.publicId })))
    await require('./cloudinary').deleteFromCloud(asset.publicId, 'image', { strict: true });
  await AssetCleanup.deleteOne({ _id: asset._id });
});
module.exports = { deleteUser, reconcile };
