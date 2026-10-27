const Guild = require('../models/Guild');
const User = require('../models/User');
const GuildChallenge = require('../models/GuildChallenge');
const Season = require('../models/Season');
const { transaction, BusinessError } = require('./transaction');

async function treasury(userId, guildId, amount, withdraw = false) {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new BusinessError('❌ Enter a positive safe amount.');
  return transaction(async (session) => {
    const user = await User.findOne({ id: userId, guildId }).session(session);
    const guild = await Guild.findById(guildId).session(session);
    const member = guild?.members.find((m) => m.userId === userId);
    if (!user || !guild || !member) throw new BusinessError('❌ Guild membership changed.');
    if (withdraw && guild.leaderId !== userId)
      throw new BusinessError('❌ Only the guild leader can withdraw.');
    const from = withdraw ? guild : user;
    const to = withdraw ? user : guild;
    const fromKey = withdraw ? 'bank' : 'coins';
    const toKey = withdraw ? 'coins' : 'bank';
    if (from[fromKey] < amount || to[toKey] > Number.MAX_SAFE_INTEGER - amount)
      throw new BusinessError('❌ Insufficient funds or balance limit exceeded.');
    from[fromKey] -= amount;
    to[toKey] += amount;
    let questResult = null;
    if (!withdraw) {
      member.contribution += amount;
      questResult = Guild.applyQuestProgress(guild, userId, 'donate', amount);
    }
    Guild.logActivity(guild, { eventType: withdraw ? 'withdraw' : 'donate', userId, amount });
    await user.save({ session });
    await guild.save({ session });
    return { user, guild, member, questResult, interestNote: '' };
  });
}
async function resolveChallenge(id, reward) {
  return transaction(async (session) => {
    const challenge = await GuildChallenge.findById(id).session(session);
    if (challenge?.status === 'resolving')
      throw new BusinessError(
        '⚠️ This old interrupted challenge needs owner review before another payout.'
      );
    if (!challenge || challenge.status !== 'active' || challenge.endsAt > Date.now()) return null;
    const guildA = await Guild.findById(challenge.challengerGuildId).session(session);
    const guildB = await Guild.findById(challenge.challengedGuildId).session(session);
    const gainA = guildA ? guildA.reputation - challenge.startRepChallenger : null;
    const gainB = guildB ? guildB.reputation - challenge.startRepChallenged : null;
    const noContest = !guildA || !guildB;
    const winner = noContest || gainA === gainB ? null : gainA > gainB ? guildA : guildB;
    if (winner) {
      Guild.awardReputation(winner, reward);
      await winner.save({ session });
    }
    challenge.status = 'completed';
    challenge.winnerGuildId = winner ? String(winner._id) : noContest ? null : 'tie';
    await challenge.save({ session });
    return { guildA, guildB, gainA, gainB, winner, noContest };
  });
}
async function resolveSeason({ rewardReputation, rewardCoins, duration }) {
  await Season.init();
  return transaction(async (session) => {
    if (await Season.exists({ status: 'resolving' }).session(session))
      throw new BusinessError(
        '⚠️ An old interrupted season needs owner review before another payout.'
      );
    const endedSeason = await Season.findOne({
      $or: [{ status: 'active' }, { status: { $exists: false }, resolved: false }],
      endsAt: { $lte: Date.now() },
    })
      .sort({ seasonNumber: -1 })
      .session(session);
    if (!endedSeason) return null;
    const [winner] = await Guild.find({ seasonReputation: { $gt: 0 } })
      .sort({ seasonReputation: -1, _id: 1 })
      .limit(1)
      .session(session);
    if (winner) {
      Guild.awardReputation(winner, rewardReputation);
      winner.bank += rewardCoins;
      winner.seasonWins++;
      Guild.logActivity(winner, {
        eventType: 'season_won',
        text: `Season ${endedSeason.seasonNumber}`,
        amount: rewardCoins,
      });
      await winner.save({ session });
    }
    await Guild.updateMany({}, { $set: { seasonReputation: 0 } }, { session });
    const now = Date.now();
    const nextSeason = await Season.findOneAndUpdate(
      { seasonNumber: endedSeason.seasonNumber + 1 },
      {
        $setOnInsert: {
          startedAt: now,
          endsAt: now + duration,
          status: 'active',
        },
      },
      { upsert: true, new: true, session }
    );
    endedSeason.winnerGuildId = winner ? String(winner._id) : 'none';
    endedSeason.payoutComplete = true;
    endedSeason.guildsResetComplete = true;
    endedSeason.status = 'completed';
    await endedSeason.save({ session });
    return { endedSeason, winner: winner || null, nextSeason };
  });
}
async function transferLeadership(userId, targetId) {
  if (userId === targetId) throw new BusinessError('❌ You already lead this guild.');
  return transaction(async (session) => {
    const user = await User.findOne({ id: userId }).session(session);
    const guild = user?.guildId && (await Guild.findById(user.guildId).session(session));
    if (!guild || guild.leaderId !== userId)
      throw new BusinessError('❌ Only the current guild leader can transfer leadership.');
    const target = guild.members.find((m) => m.userId === targetId);
    const previous = guild.members.find((m) => m.userId === userId);
    const targetUser = await User.findOne({ id: targetId, guildId: String(guild._id) }).session(
      session
    );
    if (!target || !previous || !targetUser)
      throw new BusinessError('❌ Choose an existing member of your guild.');
    target.role = 'leader';
    previous.role = 'officer';
    guild.leaderId = targetId;
    Guild.logActivity(guild, {
      eventType: 'leadership_transfer',
      userId,
      text: `New leader: ${targetId}`,
    });
    await guild.save({ session });
    return guild;
  });
}
module.exports = { treasury, resolveChallenge, resolveSeason, transferLeadership };
