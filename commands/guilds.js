const Guild = require('../models/Guild');
const GuildChallenge = require('../models/GuildChallenge');
const Season = require('../models/Season');
const GuildEvent = require('../models/GuildEvent');
const User = require('../models/User');
const { formatNum, formatCooldown, mentionName, mentionTag, resolveNameById, boldSans, doubleStruck, parseAmount, decodeIdKey, isOwner, safeGetChat } = require('../utils/helpers');
const { GUILD_ACHIEVEMENTS, checkGuildAchievements, formatGuildUnlockNotice } = require('../utils/guildAchievements');

const ROLE_RANK = Guild.ROLE_RANK;
const QUEST_DEFS = Guild.QUEST_DEFS;
const MIN_QUEST_DURATION_MS = Guild.MIN_QUEST_DURATION_MS;
const MISSION_DEFS = Guild.MISSION_DEFS;
const MIN_MISSION_DURATION_MS = Guild.MIN_MISSION_DURATION_MS;
const QUEST_ICON = { donate: '💰', cards: '🎴', games: '⚔️' };
const ROLE_ICON = { leader: '👑', officer: '🛡️', veteran: '⚔️', member: '👤' };
const ROLE_LABEL = { leader: 'Leader', officer: 'Officer', veteran: 'Veteran', member: 'Member' };

function roleIcon(role) { return ROLE_ICON[role] || '👤'; }
function roleLabel(role) { return ROLE_LABEL[role] || 'Member'; }
function getMember(guild, userId) { return guild.members.find(m => m.userId === userId); }
function getRole(guild, userId) { return getMember(guild, userId)?.role || null; }

// ─── Shared: activity feed line formatting ─────────────────────────────────
// One line per stored models/Guild.js activityLog entry, for .guild
// activity. Only used within this file (unlike _formatQuestCompletionNote),
// so it isn't underscore-prefixed or exported — same convention as the
// plain roleIcon/getMember helpers above.
async function formatActivityLine(client, entry) {
  const name = entry.userId ? await resolveNameById(client, entry.userId) : null;
  switch (entry.eventType) {
    case 'donate':
      return `💰 ${name} donated ${formatNum(entry.amount)} coins`;
    case 'withdraw':
      return `🏦 ${name} withdrew ${formatNum(entry.amount)} coins from the treasury`;
    case 'quest_completed':
      return `${QUEST_ICON[entry.questType] || '🎯'} Guild completed a quest! (+💰${formatNum(entry.rewardCoins)}, +${formatNum(entry.rewardXp)} XP)`;
    case 'mission_completed':
      return `🏆 Guild completed a WEEKLY MISSION! (+💰${formatNum(entry.rewardCoins)}, +${formatNum(entry.rewardXp)} XP)`;
    case 'member_joined':
      return `👤 ${name} joined`;
    case 'member_left':
      return `🚪 ${name} left`;
    case 'announcement':
      return `📢 ${name} posted an announcement: "${entry.text.length > 60 ? entry.text.slice(0, 57) + '...' : entry.text}"`;
    case 'upgrade':
      return `🏰 ${name} purchased an upgrade: ${entry.text} (💰${formatNum(entry.amount)})`;
    case 'shop_purchase':
      return `🛍️ ${name} bought the ${entry.text} (💰${formatNum(entry.amount)})`;
    case 'season_won':
      return `🎉 Guild won ${entry.text}! (+💰${formatNum(entry.amount)})`;
    default:
      return `• ${entry.eventType}`;
  }
}

// ─── Shared: quest-completion note ─────────────────────────────────────────
// Appended after .guild donate / .claim (cards) / a game win, whichever one
// happens to finish off the guild's active quest. `questResult` is whatever
// Guild.applyQuestProgress / Guild.addQuestProgress returned — null (not in
// a guild, or this activity doesn't match the active quest) means no note.
// Kept as a leading "\n\n..." block so callers can just string-concat it
// onto the end of their existing reply text unconditionally.
//
// Prefixed with `_` so index.js's command loader does not register it as a
// chat command, and cross-required from commands/cards.js and every
// commands/games/*.js file — same pattern already used for
// _removeMemberFromGuild (see commands/admin.js's require('./guilds')).
function _formatQuestCompletionNote(questResult) {
  if (!questResult) return '';
  const notes = [];

  if (questResult.questCompleted) {
    const levelLine = questResult.guildLevelUp ? ` — 🏰 Guild leveled up to *${questResult.guildLevel}*!` : '';
    notes.push(`🎉 *Guild quest complete!* +💰${formatNum(questResult.rewardCoins)} treasury, +${formatNum(questResult.rewardXp)} guild XP${levelLine}`);
  }
  if (questResult.missionCompleted) {
    const levelLine = questResult.missionGuildLevelUp ? ` — 🏰 Guild leveled up to *${questResult.missionGuildLevel}*!` : '';
    notes.push(`🏆 *Weekly guild mission complete!* +💰${formatNum(questResult.missionRewardCoins)} treasury, +${formatNum(questResult.missionRewardXp)} guild XP${levelLine}`);
  }

  return notes.length ? `\n\n${notes.join('\n\n')}` : '';
}

// ─── Shared: find a guild member by typed name ────────────────────────────────
// Same exact-then-unambiguous-partial matching .guild remove always used,
// now shared with .guild promote/.guild demote too instead of being
// duplicated three times. Returns:
//   { member, name }   — a single match (the actual member subdocument
//                         reference, so callers can mutate it in place
//                         and .save() the parent guild)
//   { ambiguous: [names] } — more than one partial match
//   null                — no match at all
// Prefixed with `_` so index.js's command loader does not register it as
// a chat command — same convention as `_removeMemberFromGuild` below.
async function _resolveMemberByName(client, guild, query) {
  const names = await Promise.all(guild.members.map(m => resolveNameById(client, m.userId)));
  const q = query.toLowerCase();

  const exact = guild.members
    .map((member, i) => ({ member, name: names[i] }))
    .filter(x => x.name.toLowerCase() === q);
  if (exact.length >= 1) return { member: exact[0].member, name: exact[0].name };

  const partial = guild.members
    .map((member, i) => ({ member, name: names[i] }))
    .filter(x => x.name.toLowerCase().includes(q));
  if (partial.length === 1) return { member: partial[0].member, name: partial[0].name };
  if (partial.length > 1) return { ambiguous: partial.map(x => x.name) };

  return null;
}

// Escapes a string for safe use inside a `new RegExp(...)` pattern — used
// below so a guild name containing regex-special characters (parentheses,
// asterisks, etc.) can't throw or match more broadly than intended.
function _escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolves a .guild join [name or ID] argument to a guild document, or
// null if nothing matches. Guild names are unique (schema-enforced), so —
// unlike _resolveMemberByName above — there's no partial/ambiguous case to
// handle here, just a numeric-id lookup and a case-insensitive exact-name
// lookup.
async function _resolveGuildForJoin(query) {
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) {
    const byId = await Guild.findOne({ guildId: Number(trimmed) });
    if (byId) return byId;
  }
  return await Guild.findOne({ name: new RegExp(`^${_escapeRegExp(trimmed)}$`, 'i') });
}

// Same shape as _resolveMemberByName's return value ({userId, name} /
// {ambiguous} / null), but for a plain array of raw userId strings rather
// than guild.members subdocuments — used for resolving an applicant in
// guild.pendingApplications by display name (.guild acceptapp/declineapp).
async function _resolveUserIdByName(client, userIds, query) {
  const names = await Promise.all(userIds.map(id => resolveNameById(client, id)));
  const q = query.toLowerCase();

  const exact = userIds
    .map((userId, i) => ({ userId, name: names[i] }))
    .filter(x => x.name.toLowerCase() === q);
  if (exact.length >= 1) return exact[0];

  const partial = userIds
    .map((userId, i) => ({ userId, name: names[i] }))
    .filter(x => x.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { ambiguous: partial.map(x => x.name) };

  return null;
}

// ─── Shared: guild-vs-guild challenge resolution ───────────────────────────
const CHALLENGE_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
const CHALLENGE_REWARD_REPUTATION = 100;

// Resolves an active challenge if its window has passed — mutates and
// saves both guilds and the challenge itself. Returns a result object
// describing the outcome, or null if there's nothing to resolve yet (not
// active, or active but not expired). Called lazily wherever a challenge
// might be checked (.guild challenge, .guild info) — same "check on next
// relevant read" philosophy as interest/quests in models/Guild.js, just
// living here instead since a challenge spans two guilds rather than
// belonging to one.
async function _resolveChallengeIfDue(challenge) {
  if (challenge.status !== 'active' || Date.now() < challenge.endsAt) return null;

  const [guildA, guildB] = await Promise.all([
    Guild.findById(challenge.challengerGuildId),
    Guild.findById(challenge.challengedGuildId),
  ]);

  // One side disbanded mid-challenge — call it a no-contest rather than
  // crashing or awarding a hollow win.
  if (!guildA || !guildB) {
    challenge.status = 'completed';
    challenge.winnerGuildId = null;
    await challenge.save();
    return { guildA, guildB, gainA: null, gainB: null, winner: null, noContest: true };
  }

  const gainA = (guildA.reputation || 0) - challenge.startRepChallenger;
  const gainB = (guildB.reputation || 0) - challenge.startRepChallenged;

  let winner = null;
  if (gainA > gainB) {
    winner = guildA;
    Guild.awardReputation(guildA, CHALLENGE_REWARD_REPUTATION);
    await guildA.save();
  } else if (gainB > gainA) {
    winner = guildB;
    Guild.awardReputation(guildB, CHALLENGE_REWARD_REPUTATION);
    await guildB.save();
  }
  // gainA === gainB -> tie, no reward, no winner.

  challenge.status = 'completed';
  challenge.winnerGuildId = winner ? winner._id.toString() : 'tie';
  await challenge.save();

  return { guildA, guildB, gainA, gainB, winner, noContest: false };
}

// Formats the outcome from _resolveChallengeIfDue into a message — shared
// by whichever command happened to trigger the resolution.
function _formatChallengeResult(result) {
  if (result.noContest) return '\n\n⚔️ A guild challenge ended in a no-contest — one side no longer exists.';
  if (!result.winner) {
    return `\n\n⚔️ *Guild challenge ended in a tie!* ${result.guildA.name} and ${result.guildB.name} both gained ${result.gainA} reputation.`;
  }
  const loser = result.winner._id.toString() === result.guildA._id.toString() ? result.guildB : result.guildA;
  return `\n\n⚔️ *Guild challenge complete!* 🏆 *${result.winner.emblem} ${result.winner.name}* beat *${loser.name}* ` +
    `(${result.winner === result.guildA ? result.gainA : result.gainB} vs ${result.winner === result.guildA ? result.gainB : result.gainA} reputation gained) ` +
    `and earned +${CHALLENGE_REWARD_REPUTATION} bonus reputation!`;
}

// ─── Shared: guild seasons ──────────────────────────────────────────────────
// Unlike everything else above (which is scoped to one or two guilds), a
// season is a competition across EVERY guild at once — see the comment at
// the top of models/Season.js for why that needs its own single shared
// document instead of living on a Guild. Deliberately only checked from
// .guild season (not folded into .guild info like the challenge check
// above) — resolving a season means scanning and rewriting every guild in
// the collection, real work worth keeping off the hot path that runs on
// every single guild info check.
const SEASON_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SEASON_WIN_REPUTATION_BONUS = 500;
const SEASON_WIN_COINS = 100000;

// Returns the current season, creating season #1 the very first time this
// is ever called on a fresh install.
async function _getCurrentSeason() {
  let season = await Season.findOne().sort({ seasonNumber: -1 });
  if (!season) {
    const now = Date.now();
    season = await Season.create({ seasonNumber: 1, startedAt: now, endsAt: now + SEASON_DURATION_MS });
  }
  return season;
}

// Atomically resolves the current season if its window has passed, pays
// out the winner, resets every guild's seasonReputation, and starts the
// next season. Returns { endedSeason, winner, nextSeason }, or null if
// nothing was due (including "someone else's check just resolved it a
// moment ago" — the findOneAndUpdate below can only succeed for ONE
// caller for a given season, by design).
async function _resolveSeasonIfDue() {
  const now = Date.now();
  // The atomic claim: findOneAndUpdate's filter+update happens as one
  // indivisible operation in MongoDB, so if two people run .guild season
  // in the same second right as a season ends, only one of these calls
  // can match a still-unresolved, past-due season — the other gets null
  // back and does nothing, rather than both paying out the same season.
  const claimed = await Season.findOneAndUpdate(
    { resolved: false, endsAt: { $lte: now } },
    { $set: { resolved: true } },
    { sort: { seasonNumber: -1 } }
  );
  if (!claimed) return null;

  const topGuilds = await Guild.find().sort({ seasonReputation: -1 }).limit(1);
  const winner = topGuilds[0] && topGuilds[0].seasonReputation > 0 ? topGuilds[0] : null;

  if (winner) {
    Guild.awardReputation(winner, SEASON_WIN_REPUTATION_BONUS);
    winner.bank += SEASON_WIN_COINS;
    winner.seasonWins = (winner.seasonWins || 0) + 1;
    Guild.logActivity(winner, {
      eventType: 'season_won',
      text: `Season ${claimed.seasonNumber}`,
      amount: SEASON_WIN_COINS,
    });
    await winner.save();
  }

  // Bulk reset — deliberately bypasses Mongoose document middleware (no
  // per-guild side effects belong here, this is just a field wipe), and
  // touches every guild regardless of whether they participated at all.
  await Guild.updateMany({}, { $set: { seasonReputation: 0 } });

  const nextSeason = await Season.create({
    seasonNumber: claimed.seasonNumber + 1,
    startedAt: now,
    endsAt: now + SEASON_DURATION_MS,
  });

  return { endedSeason: claimed, winner, nextSeason };
}

// ─── Shared: leave/kick cleanup ────────────────────────────────────────────────
// Removes a user from whatever guild they're in and keeps the guild's own
// records (members[] / leaderId) consistent. Used by:
//   - .guild remove [name]      (leader/officer kicking someone)
//   - group_leave event handler (someone leaving a WhatsApp group the bot is in)
//
// If the departing user is the leader, leadership is handed to the
// highest-ranking remaining member (officer over veteran over member,
// earliest joiner as a tiebreaker) rather than disbanding the guild
// outright — disbanding wipes the guild's bank/xp/level, which felt too
// destructive for something that can be triggered passively (e.g. a
// leader leaving a WhatsApp group). If that's not the behavior you want
// (e.g. you'd rather auto-disband when the leader leaves), let me know
// and I'll switch it.
//
// Prefixed with `_` so index.js's command loader (`!name.startsWith('_')`)
// does not register it as a chat command — same convention as
// `_initCardDrops` in cards.js.
async function _removeMemberFromGuild(userId) {
  const user = await User.findOne({ id: userId });
  if (!user || !user.guildId) return null;

  const guild = await Guild.findById(user.guildId);
  user.guildId = null;
  await user.save();

  if (!guild) return null;

  const remaining = guild.members.filter(m => m.userId !== userId);

  if (guild.leaderId === userId) {
    if (remaining.length === 0) {
      await Guild.findByIdAndDelete(guild._id);
      return { disbanded: true, guildName: guild.name };
    }
    const next = [...remaining].sort((a, b) => {
      const rankDiff = ROLE_RANK[b.role] - ROLE_RANK[a.role];
      if (rankDiff !== 0) return rankDiff;
      return new Date(a.joinedAt) - new Date(b.joinedAt);
    })[0];

    next.role = 'leader';
    guild.leaderId = next.userId;
    guild.members = remaining;
    await guild.save();
    return { disbanded: false, guildName: guild.name, newLeaderId: next.userId };
  }

  guild.members = remaining;
  await guild.save();
  return { disbanded: false, guildName: guild.name };
}

module.exports = {
  _removeMemberFromGuild,
  _formatQuestCompletionNote,

  // .guild — bare, no subcommand. Browses guilds currently recruiting
  // (recruitment === 'open' and not full). This is what replaces the idea
  // of a separate ".guild browse" — plain ".guild" IS the browse command.
  // Note: index.js's dispatcher only tries the `guild_<subcommand>` lookup
  // when `.guild` has at least one argument; zero arguments falls through
  // to this plain `guild` export directly.
  async guild(client, msg, args) {
    const openGuilds = await Guild.find({ recruitment: 'open' }).sort({ level: -1 }).limit(15);
    const recruiting = openGuilds.filter(g => g.members.length < Guild.effectiveMaxMembers(g));

    if (!recruiting.length) {
      return msg.reply(
        '🏰 No guilds are currently recruiting.\n\n' +
        'Use *.guild create [name]* to start your own, or *.guild join [name or ID]* once you find one.'
      );
    }

    const lines = recruiting.map(g =>
      `#${g.guildId ?? '?'} ${g.emblem} *${g.name}*\nLevel ${g.level} | ${g.members.length}/${Guild.effectiveMaxMembers(g)} members | Recruiting`
    );

    msg.reply(`🏰 *GUILDS LOOKING FOR MEMBERS*\n\n${lines.join('\n\n')}\n\nUse *.guild join [name or ID]* to apply.`);
  },

  // .guildevent [amount] [message] — owner-only, DM-only. Instantly
  // credits EVERY existing guild's treasury with `amount` coins as a
  // celebratory one-off (e.g. an anniversary). See models/GuildEvent.js
  // for why this is a flat instant payout rather than a "double rewards
  // for N hours" style rate boost — the latter would require touching the
  // synchronous quest/mission engine in models/Guild.js in ways that
  // ripple out to several other files for comparatively little payoff.
  async guildevent(client, msg, args) {
    const senderId = msg.author || msg.from;
    if (!isOwner(senderId)) return msg.reply('❌ This command is for the bot owner only.');

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (chat.isGroup) return msg.reply('❌ .guildevent only works in a DM with the bot — not in a group.');

    const amount = parseAmount(args[0]);
    const message = args.slice(1).join(' ').trim();
    if (!amount || amount < 1 || !message) {
      return msg.reply('❌ Usage: .guildevent [amount] [message]\n\nExample: .guildevent 50000 Anniversary Event! 🎉');
    }

    const guildsAffected = await Guild.countDocuments();
    if (guildsAffected === 0) return msg.reply('❌ No guilds exist yet.');

    // Bulk update rather than fetching every guild individually — this is
    // meant to scale to however many guilds exist without needing one
    // round-trip per guild. It does mean this bypasses per-guild
    // activity-log entries (Guild.logActivity needs an in-memory doc to
    // push onto) — the GuildEvent history this creates is the audit trail
    // for this particular action instead.
    await Guild.updateMany({}, { $inc: { bank: amount } });
    await GuildEvent.create({ message, coinsPerGuild: amount, guildsAffected, triggeredBy: senderId });

    msg.reply(`🎉 Event triggered! Every guild (${guildsAffected}) just received 💰${formatNum(amount)} in their treasury.\n\nMessage: "${message}"`);
  },

  // .guild events — anyone can view recent owner-triggered celebrations.
  async guild_events(client, msg, args) {
    const recent = await GuildEvent.find().sort({ triggeredAt: -1 }).limit(5);
    if (!recent.length) return msg.reply('📭 No guild events have been run yet.');

    const lines = recent.map(e => {
      const daysAgo = Math.floor((Date.now() - e.triggeredAt) / 86_400_000);
      const when = daysAgo === 0 ? 'today' : `${daysAgo}d ago`;
      return `🎉 "${e.message}" — +💰${formatNum(e.coinsPerGuild)} to ${e.guildsAffected} guild${e.guildsAffected === 1 ? '' : 's'} (${when})`;
    });
    msg.reply(`🎊 *RECENT GUILD EVENTS*\n\n${lines.join('\n\n')}`);
  },

  // .guild info
  async guild_info(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.guildId) return msg.reply('❌ You are not in a guild. Use .guild create [name] to start one!');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    // Lazy re-check on view — same convention as .profile re-checking the
    // title on every view (see commands/economy.js). Catches anything that
    // unlocked from an action elsewhere (a card claim, a game win) without
    // needing every one of those call sites to also check achievements.
    const unlockedNow = await checkGuildAchievements(guild._id);

    // Same lazy-resolve-on-view idea, for a guild-vs-guild challenge whose
    // 48h window has passed since anyone last checked.
    let challengeResultNote = '';
    const activeChallenge = await GuildChallenge.findOne({
      $or: [{ challengerGuildId: guild._id.toString() }, { challengedGuildId: guild._id.toString() }],
      status: 'active',
    });
    if (activeChallenge) {
      const resolved = await _resolveChallengeIfDue(activeChallenge);
      if (resolved) challengeResultNote = _formatChallengeResult(resolved);
    }

    const leaderName = await resolveNameById(client, guild.leaderId);
    const officerCount = guild.members.filter(m => m.role === 'officer').length;
    // guild._interestCredited is set automatically by the post-find hook in
    // models/Guild.js every time this guild doc is loaded — same convention
    // as user._interestCredited in commands/economy.js's .balance.
    const interestNote = guild._interestCredited > 0
      ? ` (📈 +${formatNum(guild._interestCredited)} interest since last check)`
      : '';

    const line = (label, value) => `ꕥ ${boldSans(label)}: ${value}`;
    const q = guild.activeQuest;
    const m = guild.activeMission;
    const maxMembers = Guild.effectiveMaxMembers(guild);
    const rewardBonusPct = Math.round((Guild.getRewardMultiplier(guild) - 1) * 100);
    const equippedBanner = guild.activeBanner && Guild.SHOP_BANNERS[guild.activeBanner];
    const topBorder = equippedBanner ? equippedBanner.top : `╭━━━★彡 ${doubleStruck('GUILD')} 彡★━━━╮`;
    const bottomBorder = equippedBanner ? equippedBanner.bottom : null;
    const announcementTeaser = guild.announcement.text
      ? `\n\n📢 _${guild.announcement.text.length > 80 ? guild.announcement.text.slice(0, 77) + '...' : guild.announcement.text}_`
      : '';
    const questTeaser = q.questType
      ? `\n\n${QUEST_ICON[q.questType]} Quest: ${formatNum(q.progress)}/${formatNum(q.goal)} — use *.guild quest* for details`
      : '';
    const missionTeaser = m.questType
      ? `\n🏆 Weekly mission: ${formatNum(m.progress)}/${formatNum(m.goal)} — use *.guild mission* for details`
      : '';
    const card = [
      topBorder,
      '',
      `${guild.emblem} *${guild.name}*` + (guild.guildId != null ? ` (#${guild.guildId})` : ''),
      guild.description ? `_${guild.description}_` : '_No description set._',
      '',
      line('Leader', leaderName),
      line('Members', `${guild.members.length}/${maxMembers}${officerCount ? ` (${officerCount} officer${officerCount === 1 ? '' : 's'})` : ''}`),
      line('Level', guild.level),
      line('XP', guild.xp),
      line('Reputation', `🌟 ${formatNum(guild.reputation || 0)}${guild.seasonWins > 0 ? ` (🏆 ${guild.seasonWins} season win${guild.seasonWins === 1 ? '' : 's'})` : ''}`),
      line('Bank', `${formatNum(guild.bank)}${interestNote}`),
      line('Created', guild.createdAt.toDateString()),
    ].join('\n')
      + (bottomBorder ? `\n${bottomBorder}` : '')
      + (rewardBonusPct > 0 ? `\n\n⭐ Perks: +${rewardBonusPct}% quest/mission rewards, ${maxMembers} member cap` : '')
      + announcementTeaser + questTeaser + missionTeaser;

    msg.reply(card + formatGuildUnlockNotice(unlockedNow) + challengeResultNote);
  },

  // .guild members — open to any guild member (previously leader-only;
  // relaxed because a roster of roles/contribution is the whole point of
  // this feature, and that's only useful if everyone in the guild can
  // actually see it — see conversation notes if you'd rather lock this
  // back down).
  async guild_members(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    const sorted = [...guild.members].sort((a, b) => {
      const rankDiff = ROLE_RANK[b.role] - ROLE_RANK[a.role];
      if (rankDiff !== 0) return rankDiff;
      return new Date(a.joinedAt) - new Date(b.joinedAt);
    });

    const names = await Promise.all(sorted.map(m => resolveNameById(client, m.userId)));

    const lines = sorted.map((m, i) =>
      `${roleIcon(m.role)} ${names[i]} — ${roleLabel(m.role)} — ${formatNum(m.contribution)} contribution, ${formatNum(m.xp || 0)} XP${m.streak > 1 ? ` — 🔥 ${m.streak}d streak` : ''}`
    );

    msg.reply(
      `🏰 *${guild.emblem} ${guild.name}* — Members (${guild.members.length})\n\n${lines.join('\n')}`
    );
  },

  // .guild remove [member's name] — leader or officer. An officer can only
  // remove someone who outranks lower than them (veterans/members), never
  // another officer or the leader — only the leader can do that.
  async guild_remove(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild remove [member\'s name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can remove members.');
    }

    if (guild.members.length <= 1) {
      return msg.reply('❌ There are no other members to remove.');
    }

    const result = await _resolveMemberByName(client, guild, query);
    if (!result) return msg.reply(`❌ No member named "${query}" found in *${guild.name}*.`);
    if (result.ambiguous) {
      return msg.reply(`❌ That matches multiple members: ${result.ambiguous.join(', ')}. Be more specific.`);
    }

    const { member: target, name: targetName } = result;

    if (target.userId === contact.id._serialized) {
      return msg.reply('❌ You can\'t remove yourself — use .guild leave instead.');
    }

    if (ROLE_RANK[actorRole] <= ROLE_RANK[target.role]) {
      return msg.reply(`❌ You don't outrank ${roleLabel(target.role)} ${targetName} enough to remove them.`);
    }

    guild.members = guild.members.filter(m => m.userId !== target.userId);
    Guild.logActivity(guild, { eventType: 'member_left', userId: target.userId });
    await guild.save();

    await User.findOneAndUpdate({ id: target.userId }, { guildId: null });

    msg.reply(`✅ Removed *${targetName}* from *${guild.emblem} ${guild.name}*.`);
  },

  // .guild promote [member's name] — leader only. Steps a member up one
  // rank: member -> veteran -> officer. Officer is the highest rank this
  // command reaches — leadership itself isn't transferable this way.
  async guild_promote(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild promote [member\'s name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can promote members.');
    }

    const result = await _resolveMemberByName(client, guild, query);
    if (!result) return msg.reply(`❌ No member named "${query}" found in *${guild.name}*.`);
    if (result.ambiguous) {
      return msg.reply(`❌ That matches multiple members: ${result.ambiguous.join(', ')}. Be more specific.`);
    }

    const { member: target, name: targetName } = result;

    if (target.role === 'leader') return msg.reply('❌ That\'s you — the leader can\'t promote themselves.');
    if (target.role === 'officer') {
      return msg.reply(`❌ ${targetName} is already an Officer — the highest rank .guild promote can reach.`);
    }

    const next = target.role === 'member' ? 'veteran' : 'officer';
    target.role = next;
    await guild.save();

    msg.reply(`✅ ${roleIcon(next)} *${targetName}* promoted to ${roleLabel(next)} in *${guild.name}*.`);
  },

  // .guild demote [member's name] — leader only. Steps a member down one
  // rank: officer -> veteran -> member.
  async guild_demote(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild demote [member\'s name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can demote members.');
    }

    const result = await _resolveMemberByName(client, guild, query);
    if (!result) return msg.reply(`❌ No member named "${query}" found in *${guild.name}*.`);
    if (result.ambiguous) {
      return msg.reply(`❌ That matches multiple members: ${result.ambiguous.join(', ')}. Be more specific.`);
    }

    const { member: target, name: targetName } = result;

    if (target.role === 'leader') {
      return msg.reply('❌ The leader can\'t be demoted — leadership transfer isn\'t supported yet.');
    }
    if (target.role === 'member') {
      return msg.reply(`❌ ${targetName} is already at the lowest rank (Member).`);
    }

    const next = target.role === 'officer' ? 'veteran' : 'member';
    target.role = next;
    await guild.save();

    msg.reply(`✅ ${roleIcon(next)} *${targetName}* demoted to ${roleLabel(next)} in *${guild.name}*.`);
  },

  // .guild description            — view (anyone in the guild)
  // .guild description [text]     — set (leader only), capped at 300 chars
  // so a runaway paste can't blow up every .guild info card.
  async guild_description(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const text = args.join(' ').trim();
    if (!text) {
      return msg.reply(
        guild.description
          ? `📜 *${guild.name}*: ${guild.description}`
          : '❌ No description set. Usage: .guild description [text]'
      );
    }

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can set the description.');
    }
    if (text.length > 300) {
      return msg.reply(`❌ Keep it under 300 characters (currently ${text.length}).`);
    }

    guild.description = text;
    await guild.save();
    msg.reply('✅ Guild description updated.');
  },

  // .guild announce                — view the current announcement (anyone
  //                                   in the guild)
  // .guild announce [message]      — post a new one (leader or officer),
  //                                   capped at 300 chars like the
  //                                   description above, and replaces
  //                                   whatever was posted before — this is
  //                                   a single current notice, not a
  //                                   history (.guild activity keeps a
  //                                   trail of when each one went up).
  async guild_announce(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const text = args.join(' ').trim();

    // Reserved keywords to remove the current announcement, checked before
    // the empty-args "view" branch below so ".guild announce clear"
    // doesn't fall through to "no args -> show current" instead.
    if (['clear', 'remove'].includes(text.toLowerCase())) {
      const actorRole = getRole(guild, contact.id._serialized);
      if (actorRole !== 'leader' && actorRole !== 'officer') {
        return msg.reply('❌ Only the guild leader or an officer can remove the announcement.');
      }
      if (!guild.announcement.text) return msg.reply('❌ There is no announcement to remove.');

      guild.announcement = { text: '', postedBy: null, postedAt: null };
      await guild.save();
      return msg.reply('✅ Announcement removed.');
    }

    if (!text) {
      if (!guild.announcement.text) return msg.reply('❌ No announcement posted. Usage: .guild announce [message]');
      const posterName = await resolveNameById(client, guild.announcement.postedBy);
      return msg.reply(
        `📢 *GUILD ANNOUNCEMENT*\n\n${guild.announcement.text}\n\n` +
        `— ${posterName}, ${guild.announcement.postedAt.toDateString()}`
      );
    }

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can post announcements.');
    }
    if (text.length > 300) {
      return msg.reply(`❌ Keep it under 300 characters (currently ${text.length}).`);
    }

    guild.announcement = { text, postedBy: contact.id._serialized, postedAt: new Date() };
    Guild.logActivity(guild, { eventType: 'announcement', userId: contact.id._serialized, text });
    await guild.save();

    msg.reply(`📢 *GUILD ANNOUNCEMENT*\n\n${text}\n\nAll members are encouraged to check .guild info.`);
  },

  // .guildannounce — shorthand for .guild announce.
  async guildannounce(client, msg, args) {
    return module.exports.guild_announce(client, msg, args);
  },

  // .guild donate [amount] — any guild member can donate personal coins to
  // the guild bank. This is the first real source of contribution:
  // donating raises both the guild's bank AND the donor's own
  // contribution score, 1:1. It deliberately does NOT grant guild XP —
  // that's tied to activity (cards/games/quests) in the ChatGPT proposal,
  // not donations, and wiring that up broadly was the bigger option you
  // didn't pick yet, so this stays scoped to treasury only.
  //
  // No .guild withdraw yet on purpose — there's nothing to spend treasury
  // on (no guild shop/upgrades built), and per the proposal's own "guild
  // bank security" section, leader-controlled withdrawals need real
  // transaction rules/logging before they exist at all. Building a spend
  // path with no legitimate use for it yet is just an exploit surface.
  async guild_donate(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseAmount(args[0]);
    if (!amount) return msg.reply('❌ Usage: .guild donate [amount]\n\nAmount supports shorthand: 5k, 1.2m, etc.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    const member = getMember(guild, contact.id._serialized);
    if (!member) return msg.reply('❌ Guild membership record not found — try leaving and rejoining.');

    // Same convention as guild_info above — reflects interest already
    // credited by the post-find hook in models/Guild.js at fetch time,
    // before this donation's own += is applied below.
    const interestNote = guild._interestCredited > 0
      ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
      : '';

    user.coins -= amount;
    guild.bank += amount;
    member.contribution += amount;
    Guild.logActivity(guild, { eventType: 'donate', userId: contact.id._serialized, amount });

    // In-memory only — guild is already loaded and already being saved
    // below, so this reuses that same write instead of a second fetch/save.
    // No-ops (returns null) if the active quest isn't a "donate" quest.
    const questResult = Guild.applyQuestProgress(guild, contact.id._serialized, 'donate', amount);
    const questNote = _formatQuestCompletionNote(questResult);

    await Promise.all([user.save(), guild.save()]);

    // Bank just changed (and possibly level/questsCompleted too, if that
    // donation finished off the active quest) — check right after, rather
    // than waiting for the guild to next be viewed.
    const unlockedNow = await checkGuildAchievements(guild._id);

    msg.reply(
      `💰 Donated *${formatNum(amount)}* coins to *${guild.emblem} ${guild.name}*!${interestNote}\n` +
      `Guild bank: ${formatNum(guild.bank)} | Your contribution: ${formatNum(member.contribution)}` +
      questNote + formatGuildUnlockNotice(unlockedNow)
    );
  },

  // .guild withdraw [amount] — leader only. Moves coins from the guild
  // treasury to the leader's own personal wallet — this is the guild's
  // "spend the treasury" mechanism until a proper guild shop/upgrades
  // system exists to spend it on directly. Every withdrawal is logged to
  // .guild activity (visible to every member) — nobody can quietly drain a
  // shared treasury without the rest of the guild being able to see it.
  //
  // Restricted to leader only, not officers — a stricter bar than donating
  // (any member) or announcing (leader+officer), since this is the one
  // guild action that moves money OUT to a single person. A
  // request/approval flow (an officer requests, the leader approves) is a
  // reasonable next step if unilateral leader withdrawals ever become a
  // problem for a given guild, but isn't built here.
  async guild_withdraw(client, msg, args) {
    const contact = await msg.getContact();
    const amount = parseAmount(args[0]);
    if (!amount || amount < 1) return msg.reply('❌ Usage: .guild withdraw [amount]\n\nAmount supports shorthand: 5k, 1.2m, etc.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can withdraw from the treasury.');
    }

    const interestNote = guild._interestCredited > 0
      ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
      : '';
    if (guild.bank < amount) {
      return msg.reply(`❌ Not enough in the treasury. Bank: ${formatNum(guild.bank)}${interestNote}`);
    }

    guild.bank -= amount;
    user.coins += amount;
    Guild.logActivity(guild, { eventType: 'withdraw', userId: contact.id._serialized, amount });

    await Promise.all([guild.save(), user.save()]);

    msg.reply(
      `🏦 Withdrew 💰 *${formatNum(amount)}* coins from *${guild.emblem} ${guild.name}*'s treasury.${interestNote}\n` +
      `Your wallet: ${formatNum(user.coins)} | Guild bank: ${formatNum(guild.bank)}`
    );
  },

  // .guild upgrades — view current upgrade levels, what each does, and the
  // treasury cost to advance further. This is the treasury's real spending
  // sink alongside .guild withdraw — money that stays in the guild instead
  // of leaving to one person's wallet.
  async guild_upgrades(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    let text = `🏰 *GUILD UPGRADES* — ${guild.emblem} ${guild.name}\n\n`;
    for (const [key, info] of Object.entries(Guild.UPGRADE_NAMES)) {
      const currentLevel = guild.upgrades[key] || 0;
      const cost = Guild.getUpgradeCost(currentLevel);
      text += `${info.label} — Level ${currentLevel}/${Guild.UPGRADE_MAX_LEVEL}\n`;
      text += `${info.perLevel} ${info.effect} per level\n`;
      text += cost !== null
        ? `Next level: 💰 ${formatNum(cost)} — *.guild upgrade ${key === 'questBoard' ? 'board' : key}*\n\n`
        : `✅ Maxed out\n\n`;
    }
    msg.reply(text.trim());
  },

  // .guildupgrades — shorthand for .guild upgrades.
  async guildupgrades(client, msg, args) {
    return module.exports.guild_upgrades(client, msg, args);
  },

  // .guild upgrade [hall|vault|board] — leader only. Spends treasury coins
  // to advance one upgrade by one level. "board" is accepted as the
  // shorter, more natural-to-type name for the questBoard field.
  async guild_upgrade(client, msg, args) {
    const contact = await msg.getContact();
    const aliasMap = { hall: 'hall', vault: 'vault', board: 'questBoard', questboard: 'questBoard' };
    const upgradeKey = aliasMap[(args[0] || '').toLowerCase()];
    if (!upgradeKey) return msg.reply('❌ Usage: .guild upgrade [hall|vault|board]\n\nUse *.guild upgrades* to see levels and costs.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can purchase upgrades.');
    }

    const info = Guild.UPGRADE_NAMES[upgradeKey];
    const currentLevel = guild.upgrades[upgradeKey] || 0;
    const cost = Guild.getUpgradeCost(currentLevel);
    if (cost === null) return msg.reply(`❌ *${info.label}* is already at max level (${Guild.UPGRADE_MAX_LEVEL}).`);

    const interestNote = guild._interestCredited > 0
      ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
      : '';
    if (guild.bank < cost) {
      return msg.reply(`❌ Not enough in the treasury. Need 💰${formatNum(cost)}, have ${formatNum(guild.bank)}${interestNote}.`);
    }

    guild.bank -= cost;
    guild.upgrades[upgradeKey] = currentLevel + 1;
    Guild.logActivity(guild, {
      eventType: 'upgrade',
      userId: contact.id._serialized,
      amount: cost,
      text: `${info.label} -> level ${currentLevel + 1}`,
    });
    await guild.save();

    msg.reply(
      `✅ *${info.label}* upgraded to level ${currentLevel + 1}! (${info.perLevel} ${info.effect})${interestNote}\n` +
      `Guild bank: ${formatNum(guild.bank)}`
    );
  },

  // .guild shop — view purchasable cosmetics (banners for now) and their
  // cost, marking which ones the guild already owns.
  async guild_shop(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    let text = `🛍️ *GUILD SHOP* — ${guild.emblem} ${guild.name}\n\n`;
    for (const [key, banner] of Object.entries(Guild.SHOP_BANNERS)) {
      const owned = guild.ownedBanners.includes(key);
      text += `${banner.top}\n`;
      text += `*${banner.name} Banner* — ${owned ? '✅ Owned' : `💰 ${formatNum(banner.cost)}`}\n`;
      if (!owned) text += `*.guild buy ${key}*\n`;
      text += '\n';
    }
    text += `Owned banners can be equipped with *.guild banner [name]*.`;
    msg.reply(text);
  },

  // .guild buy [banner key] — leader only.
  async guild_buy(client, msg, args) {
    const contact = await msg.getContact();
    const key = (args[0] || '').toLowerCase();
    const banner = Guild.SHOP_BANNERS[key];
    if (!banner) return msg.reply('❌ Usage: .guild buy [banner name]\n\nUse *.guild shop* to see what\'s available.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can buy from the shop.');
    }
    if (guild.ownedBanners.includes(key)) {
      return msg.reply(`❌ *${guild.name}* already owns the ${banner.name} banner.`);
    }

    const interestNote = guild._interestCredited > 0
      ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
      : '';
    if (guild.bank < banner.cost) {
      return msg.reply(`❌ Not enough in the treasury. Need 💰${formatNum(banner.cost)}, have ${formatNum(guild.bank)}${interestNote}.`);
    }

    guild.bank -= banner.cost;
    guild.ownedBanners.push(key);
    Guild.logActivity(guild, {
      eventType: 'shop_purchase',
      userId: contact.id._serialized,
      amount: banner.cost,
      text: `${banner.name} Banner`,
    });
    await guild.save();

    msg.reply(`✅ Purchased the *${banner.name} Banner*!${interestNote}\nEquip it with *.guild banner ${key}*.\nGuild bank: ${formatNum(guild.bank)}`);
  },

  // .guild banner [name|none] — leader only. Equips an already-owned
  // banner (free to switch), or clears it back to the default border.
  async guild_banner(client, msg, args) {
    const contact = await msg.getContact();
    const key = (args[0] || '').toLowerCase();
    if (!key) return msg.reply('❌ Usage: .guild banner [name|none]\n\nUse *.guild shop* to see what your guild owns.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can change the guild banner.');
    }

    if (key === 'none') {
      guild.activeBanner = null;
      await guild.save();
      return msg.reply('✅ Banner cleared — back to the default look.');
    }

    if (!guild.ownedBanners.includes(key)) {
      return msg.reply(`❌ *${guild.name}* doesn't own that banner yet. Check *.guild shop*.`);
    }

    guild.activeBanner = key;
    await guild.save();
    msg.reply(`✅ Equipped the *${Guild.SHOP_BANNERS[key].name} Banner*!`);
  },

  // .guild quest — full status of the guild's current daily quest: progress
  // bar, top contributors, reward, and time left before it rolls over.
  async guild_quest(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    const q = guild.activeQuest;
    // Defensive only — the post-find hook in models/Guild.js seeds a fresh
    // quest on every read before this handler ever sees the doc, so
    // questType should never actually be null here in practice.
    if (!q.questType) return msg.reply('❌ No active quest right now — check back soon.');

    // Same lazy recheck-on-view convention as .guild info.
    const unlockedNow = await checkGuildAchievements(guild._id);

    const def = QUEST_DEFS[q.questType];
    const pct = Math.min(100, Math.floor((q.progress / q.goal) * 100));
    const barLen = 10;
    const filled = Math.min(barLen, Math.round((pct / 100) * barLen));
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    // contributors keys are encodeIdKey()'d WhatsApp ids (see models/Guild.js)
    // — decode before resolving display names.
    const ranked = [...q.contributors.entries()]
      .map(([key, amount]) => [decodeIdKey(key), amount])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const names = await Promise.all(ranked.map(([id]) => resolveNameById(client, id)));

    const remaining = Math.max(0, q.expiresAt - Date.now());

    let text = `🎯 *GUILD QUEST*\n\n${def.label(q.goal)}\n\n`;
    text += `Progress:\n${bar} ${formatNum(q.progress)}/${formatNum(q.goal)} (${pct}%)\n`;
    if (q.progress >= q.goal) {
      const cooldownLeft = MIN_QUEST_DURATION_MS - (Date.now() - q.startedAt);
      text += cooldownLeft > 0
        ? `✅ Goal reached! Payout unlocks in ${formatCooldown(cooldownLeft)}.\n\n`
        : `✅ Goal reached — payout ready! It'll be collected on the next contribution.\n\n`;
    } else {
      text += '\n';
    }
    text += ranked.length
      ? `Contributors:\n${ranked.map(([, amount], i) => `${names[i]} — ${formatNum(amount)}`).join('\n')}\n\n`
      : 'No contributions yet — be the first!\n\n';
    text += `Reward:\n+${formatNum(q.rewardCoins)} guild coins\n+${formatNum(q.rewardXp)} guild XP\n\n`;
    text += `⏳ Resets in ${formatCooldown(remaining)}`;

    msg.reply(text + formatGuildUnlockNotice(unlockedNow));
  },

  // .guild mission — same display as .guild quest, for the parallel
  // week-long track instead of the daily one. See models/Guild.js's
  // "Weekly mission engine" section for how the two tracks relate.
  async guild_mission(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    const m = guild.activeMission;
    // Defensive only — same reasoning as .guild quest's equivalent check.
    if (!m.questType) return msg.reply('❌ No active mission right now — check back soon.');

    const unlockedNow = await checkGuildAchievements(guild._id);

    const def = MISSION_DEFS[m.questType];
    const pct = Math.min(100, Math.floor((m.progress / m.goal) * 100));
    const barLen = 10;
    const filled = Math.min(barLen, Math.round((pct / 100) * barLen));
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    const ranked = [...m.contributors.entries()]
      .map(([key, amount]) => [decodeIdKey(key), amount])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const names = await Promise.all(ranked.map(([id]) => resolveNameById(client, id)));

    const remaining = Math.max(0, m.expiresAt - Date.now());

    let text = `🏆 *WEEKLY GUILD MISSION*\n\n${def.label(m.goal)}\n\n`;
    text += `Progress:\n${bar} ${formatNum(m.progress)}/${formatNum(m.goal)} (${pct}%)\n`;
    if (m.progress >= m.goal) {
      const cooldownLeft = MIN_MISSION_DURATION_MS - (Date.now() - m.startedAt);
      text += cooldownLeft > 0
        ? `✅ Goal reached! Payout unlocks in ${formatCooldown(cooldownLeft)}.\n\n`
        : `✅ Goal reached — payout ready! It'll be collected on the next contribution.\n\n`;
    } else {
      text += '\n';
    }
    text += ranked.length
      ? `Contributors:\n${ranked.map(([, amount], i) => `${names[i]} — ${formatNum(amount)}`).join('\n')}\n\n`
      : 'No contributions yet — be the first!\n\n';
    text += `Reward:\n+${formatNum(m.rewardCoins)} guild coins\n+${formatNum(m.rewardXp)} guild XP\n\n`;
    text += `⏳ Resets in ${formatCooldown(remaining)}`;

    msg.reply(text + formatGuildUnlockNotice(unlockedNow));
  },

  // .guildmission — shorthand for .guild mission.
  async guildmission(client, msg, args) {
    return module.exports.guild_mission(client, msg, args);
  },

  // .guildquest — shorthand for .guild quest. Same delegate pattern as
  // .guildlb below.
  async guildquest(client, msg, args) {
    return module.exports.guild_quest(client, msg, args);
  },

  // .guild achievements — list unlocked and locked guild achievements.
  // Mirrors .achievements/.ach in commands/economy.js exactly.
  async guild_achievements(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    // Recheck first, same as .achievements re-checking on view, in case
    // something changed since the last time a triggering action ran.
    // checkGuildAchievements does its own separate fetch+save internally
    // (see utils/guildAchievements.js), so `guild.achievements` on THIS
    // object is still the pre-check snapshot — merge in whatever it just
    // unlocked rather than re-reading `guild` (which would show a
    // just-unlocked achievement as still locked until the next view).
    const newlyUnlocked = await checkGuildAchievements(guild._id);
    const unlockedIds = new Set([...(guild.achievements || []), ...newlyUnlocked.map(a => a.id)]);

    let text = `🏅 *${guild.emblem} ${guild.name} — Guild Achievements* (${unlockedIds.size}/${GUILD_ACHIEVEMENTS.length})\n\n`;
    for (const a of GUILD_ACHIEVEMENTS) {
      const done = unlockedIds.has(a.id);
      text += `${done ? '✅' : '🔒'} ${a.emoji} *${a.name}* — ${a.desc}\n`;
    }
    msg.reply(text);
  },

  // .guildach — shorthand for .guild achievements.
  async guildach(client, msg, args) {
    return module.exports.guild_achievements(client, msg, args);
  },

  // .guild activity — recent guild activity feed (donations, quest
  // completions, member joins/leaves), most recent first. Scoped to
  // events that already flow through the Guild model — see the big
  // comment above logActivity() in models/Guild.js for why individual
  // card claims/game wins aren't included here.
  async guild_activity(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }

    if (!guild.activityLog.length) return msg.reply(`📜 No recent activity yet in *${guild.name}*.`);

    const recent = [...guild.activityLog].reverse().slice(0, 15);
    const lines = await Promise.all(recent.map(e => formatActivityLine(client, e)));

    msg.reply(`📜 *RECENT GUILD ACTIVITY* — ${guild.emblem} ${guild.name}\n\n${lines.join('\n')}`);
  },

  // .guildactivity — shorthand for .guild activity.
  async guildactivity(client, msg, args) {
    return module.exports.guild_activity(client, msg, args);
  },

  // .guild create [name]
  async guild_create(client, msg, args) {
    const contact = await msg.getContact();
    const name = args.join(' ');
    if (!name) return msg.reply('❌ Usage: .guild create [name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.guildId) return msg.reply('❌ You are already in a guild. Leave first!');

    const exists = await Guild.findOne({ name });
    if (exists) return msg.reply('❌ A guild with that name already exists.');

    if (user.coins < 1000) return msg.reply('❌ Creating a guild costs 💰 1000 coins.');

    user.coins -= 1000;
    user.guildId = null;

    const guild = await Guild.create({
      name,
      leaderId: contact.id._serialized,
      members: [{ userId: contact.id._serialized, role: 'leader', joinedAt: new Date(), contribution: 0 }],
    });

    user.guildId = guild._id.toString();
    await user.save();

    msg.reply(`🏰 Guild *${name}* (#${guild.guildId}) created! Invite members with .guild invite @user`);
  },

  // .guild invite @user — leader or officer
  async guild_invite(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .guild invite @user');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can invite.');
    }

    const target = mentioned[0];
    if (guild.pendingInvites.includes(target.id._serialized)) return msg.reply('❌ Already invited!');

    guild.pendingInvites.push(target.id._serialized);
    await guild.save();
    msg.reply(
      `📨 Invited @${mentionTag(target)} to *${guild.name}*! They can type *.guild accept* to join.`,
      undefined,
      { mentions: [target.id._serialized] }
    );
  },

  // .guild accept
  async guild_accept(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (user.guildId) return msg.reply('❌ Leave your current guild first.');

    const guild = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!guild) return msg.reply('❌ No pending guild invite found.');

    guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
    guild.members.push({ userId: contact.id._serialized, role: 'member', joinedAt: new Date(), contribution: 0 });
    Guild.logActivity(guild, { eventType: 'member_joined', userId: contact.id._serialized });
    user.guildId = guild._id.toString();

    await Promise.all([guild.save(), user.save()]);
    msg.reply(`🏰 You joined *${guild.emblem} ${guild.name}*!`);
  },

  // .guild decline
  async guild_decline(client, msg, args) {
    const contact = await msg.getContact();
    const guild = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!guild) return msg.reply('❌ No pending invite.');

    guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
    await guild.save();
    msg.reply('✅ Invite declined.');
  },

  // .guild join [name or ID] — request to join an 'open' guild. Doesn't
  // join instantly: it queues an application that a leader/officer has to
  // approve with .guild acceptapp. Invite-only/closed guilds reject this
  // outright — join those the existing way (leader/officer invites you).
  async guild_join(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild join [name or ID]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.guildId) return msg.reply('❌ You are already in a guild. Leave first!');

    const guild = await _resolveGuildForJoin(query);
    if (!guild) return msg.reply(`❌ No guild found matching "${query}". Use *.guild* to browse guilds looking for members.`);

    if (guild.recruitment === 'closed') {
      return msg.reply(`❌ *${guild.name}* isn't accepting new members right now.`);
    }
    if (guild.recruitment === 'invite') {
      return msg.reply(`❌ *${guild.name}* is invite-only — ask the leader or an officer to invite you.`);
    }
    if (guild.members.length >= Guild.effectiveMaxMembers(guild)) {
      return msg.reply(`❌ *${guild.name}* is full (${guild.members.length}/${Guild.effectiveMaxMembers(guild)}).`);
    }
    if (guild.pendingApplications.includes(contact.id._serialized)) {
      return msg.reply(`❌ You've already applied to *${guild.name}* — wait for a leader or officer to review it.`);
    }

    guild.pendingApplications.push(contact.id._serialized);
    await guild.save();
    msg.reply(`📨 Application sent to *${guild.emblem} ${guild.name}*! A leader or officer needs to approve it with *.guild acceptapp*.`);
  },

  // .guild inactive — leader/officer only. Lists members who haven't used
  // any bot command in 30+ days. Deliberately reuses User.lastActiveAt —
  // the same general "have they used the bot at all" tracking
  // commands/admin.js's .users already relies on — rather than adding a
  // new guild-specific activity tracker. This is genuinely the more useful
  // signal for a leader wondering who's actually still around: someone who
  // hasn't touched the bot in two months clearly isn't "just not
  // interested in guild stuff specifically".
  async guild_inactive(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can check inactivity.');
    }

    const INACTIVE_DAYS = 30;
    const memberIds = guild.members.map(m => m.userId);
    const memberUsers = await User.find({ id: { $in: memberIds } }).lean();
    const lastActiveById = new Map(memberUsers.map(u => [u.id, u.lastActiveAt ?? null]));

    const now = Date.now();
    const inactive = guild.members
      .map(m => {
        const lastActiveAt = lastActiveById.get(m.userId) ?? null;
        const days = lastActiveAt ? Math.floor((now - lastActiveAt) / 86_400_000) : null;
        return { member: m, days };
      })
      .filter(x => x.days === null || x.days >= INACTIVE_DAYS)
      .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));

    if (!inactive.length) {
      return msg.reply(`✅ Everyone in *${guild.name}* has been active in the last ${INACTIVE_DAYS} days.`);
    }

    const names = await Promise.all(inactive.map(x => resolveNameById(client, x.member.userId)));
    const lines = inactive.map((x, i) =>
      `${roleIcon(x.member.role)} ${names[i]} — ${x.days === null ? 'never active' : `inactive ${x.days}d`}`
    );

    msg.reply(`💤 *Inactive Members (${INACTIVE_DAYS}+ days) — ${guild.name}*\n\n${lines.join('\n')}`);
  },

  // .guildinactive — shorthand for .guild inactive.
  async guildinactive(client, msg, args) {
    return module.exports.guild_inactive(client, msg, args);
  },

  // .guild applications — leader/officer only. Lists everyone currently
  // waiting on an application decision.
  async guild_applications(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can view applications.');
    }
    if (!guild.pendingApplications.length) return msg.reply('📭 No pending applications.');

    const names = await Promise.all(guild.pendingApplications.map(id => resolveNameById(client, id)));
    const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
    msg.reply(`📨 *Pending Applications — ${guild.name}*\n\n${list}\n\nUse *.guild acceptapp [name]* or *.guild declineapp [name]*.`);
  },

  // .guild acceptapp [applicant's name] — leader/officer only.
  async guild_acceptapp(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply("❌ Usage: .guild acceptapp [applicant's name]");

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can approve applications.');
    }
    if (!guild.pendingApplications.length) return msg.reply('📭 No pending applications.');

    const result = await _resolveUserIdByName(client, guild.pendingApplications, query);
    if (!result) return msg.reply(`❌ No applicant named "${query}" found.`);
    if (result.ambiguous) return msg.reply(`❌ That matches multiple applicants: ${result.ambiguous.join(', ')}. Be more specific.`);

    const { userId: applicantId, name: applicantName } = result;

    if (guild.members.length >= Guild.effectiveMaxMembers(guild)) {
      return msg.reply(`❌ *${guild.name}* is full (${guild.members.length}/${Guild.effectiveMaxMembers(guild)}) — remove someone first.`);
    }

    // The applicant might have joined a different guild while waiting on
    // this one — double-check rather than silently creating an
    // inconsistent double-membership.
    const applicantUser = await User.findOne({ id: applicantId });
    if (!applicantUser || applicantUser.guildId) {
      guild.pendingApplications = guild.pendingApplications.filter(id => id !== applicantId);
      await guild.save();
      return msg.reply(`❌ ${applicantName} is no longer available to join — application removed.`);
    }

    guild.pendingApplications = guild.pendingApplications.filter(id => id !== applicantId);
    guild.members.push({ userId: applicantId, role: 'member', joinedAt: new Date(), contribution: 0 });
    Guild.logActivity(guild, { eventType: 'member_joined', userId: applicantId });
    applicantUser.guildId = guild._id.toString();

    await Promise.all([guild.save(), applicantUser.save()]);
    msg.reply(`✅ ${applicantName} has been accepted into *${guild.emblem} ${guild.name}*!`);
  },

  // .guild declineapp [applicant's name] — leader/officer only.
  async guild_declineapp(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply("❌ Usage: .guild declineapp [applicant's name]");

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const actorRole = getRole(guild, contact.id._serialized);
    if (actorRole !== 'leader' && actorRole !== 'officer') {
      return msg.reply('❌ Only the guild leader or an officer can decline applications.');
    }
    if (!guild.pendingApplications.length) return msg.reply('📭 No pending applications.');

    const result = await _resolveUserIdByName(client, guild.pendingApplications, query);
    if (!result) return msg.reply(`❌ No applicant named "${query}" found.`);
    if (result.ambiguous) return msg.reply(`❌ That matches multiple applicants: ${result.ambiguous.join(', ')}. Be more specific.`);

    guild.pendingApplications = guild.pendingApplications.filter(id => id !== result.userId);
    await guild.save();
    msg.reply(`✅ Declined ${result.name}'s application.`);
  },

  // .guild recruitment                       — view current setting
  // .guild recruitment [open|invite|closed]  — set (leader only)
  async guild_recruitment(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const setting = args[0]?.toLowerCase();
    if (!setting) {
      return msg.reply(`🔧 Recruitment is currently *${guild.recruitment}*.\nUsage: .guild recruitment [open|invite|closed]`);
    }
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can change the recruitment setting.');
    }
    if (!['open', 'invite', 'closed'].includes(setting)) {
      return msg.reply('❌ Usage: .guild recruitment [open|invite|closed]');
    }

    guild.recruitment = setting;
    await guild.save();
    msg.reply(`✅ Recruitment set to *${setting}*.`);
  },

  // .guild emblem [emoji] — leader only
  async guild_emblem(client, msg, args) {
    const contact = await msg.getContact();
    const emblem = args[0];
    if (!emblem) return msg.reply('❌ Usage: .guild emblem [emoji]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) return msg.reply('❌ Only the leader can change emblem.');

    guild.emblem = emblem;
    await guild.save();
    msg.reply(`✅ Guild emblem updated to ${emblem}!`);
  },

  // .guild leave
  async guild_leave(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }
    if (guild.leaderId === contact.id._serialized) return msg.reply('❌ Leaders cannot leave. Disband the guild instead.');

    guild.members = guild.members.filter(m => m.userId !== contact.id._serialized);
    Guild.logActivity(guild, { eventType: 'member_left', userId: contact.id._serialized });
    user.guildId = null;
    await Promise.all([guild.save(), user.save()]);
    msg.reply(`✅ You left *${guild.name}*.`);
  },

  // .guild disband — leader only
  async guild_disband(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }
    if (guild.leaderId !== contact.id._serialized) return msg.reply('❌ Only the leader can disband.');

    // Remove guild from all members
    await User.updateMany({ guildId: guild._id.toString() }, { guildId: null });
    await Guild.findByIdAndDelete(guild._id);
    msg.reply(`🏰 Guild *${guild.name}* has been disbanded.`);
  },

  // .guild challenge                — view this guild's current challenge
  //                                    (pending/active/completed), and
  //                                    lazily resolve it if the 48h window
  //                                    has passed
  // .guild challenge [name or ID]   — leader only. Proposes a 48-hour
  //                                    reputation race against another
  //                                    guild.
  async guild_challenge(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const guildIdStr = guild._id.toString();
    const existing = await GuildChallenge.findOne({
      $or: [{ challengerGuildId: guildIdStr }, { challengedGuildId: guildIdStr }],
      status: { $in: ['pending', 'active'] },
    });

    const query = args.join(' ').trim();

    if (!query) {
      // View mode.
      if (!existing) return msg.reply('⚔️ No active or pending guild challenge. Use *.guild challenge [name or ID]* to start one.');

      const resolved = existing.status === 'active' ? await _resolveChallengeIfDue(existing) : null;
      if (resolved) return msg.reply(_formatChallengeResult(resolved).trim());

      const isChallenger = existing.challengerGuildId === guildIdStr;
      const opponent = await Guild.findById(isChallenger ? existing.challengedGuildId : existing.challengerGuildId);
      const opponentName = opponent ? `${opponent.emblem} ${opponent.name}` : '(unknown guild)';

      if (existing.status === 'pending') {
        return msg.reply(isChallenger
          ? `⚔️ Waiting on *${opponentName}* to accept your challenge.`
          : `⚔️ *${opponentName}* has challenged you! Use *.guild acceptchallenge* or *.guild declinechallenge*.`);
      }
      const remaining = Math.max(0, existing.endsAt - Date.now());
      const myRepNow = guild.reputation || 0;
      const myStartRep = isChallenger ? existing.startRepChallenger : existing.startRepChallenged;
      return msg.reply(
        `⚔️ *Active challenge vs ${opponentName}*\n\n` +
        `Your reputation gained so far: ${myRepNow - myStartRep}\n` +
        `⏳ Ends in ${formatCooldown(remaining)}`
      );
    }

    // Propose mode.
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can start a challenge.');
    }
    if (existing) {
      return msg.reply('❌ Your guild already has a pending or active challenge. Resolve that one first.');
    }

    const target = await _resolveGuildForJoin(query);
    if (!target) return msg.reply(`❌ No guild found matching "${query}".`);
    if (target._id.toString() === guildIdStr) return msg.reply('❌ You can\'t challenge your own guild.');

    const targetIdStr = target._id.toString();
    const targetBusy = await GuildChallenge.findOne({
      $or: [{ challengerGuildId: targetIdStr }, { challengedGuildId: targetIdStr }],
      status: { $in: ['pending', 'active'] },
    });
    if (targetBusy) return msg.reply(`❌ *${target.name}* already has a pending or active challenge.`);

    await GuildChallenge.create({ challengerGuildId: guildIdStr, challengedGuildId: targetIdStr });
    msg.reply(`⚔️ Challenge sent to *${target.emblem} ${target.name}*! Their leader can accept with *.guild acceptchallenge*.`);
  },

  // .guild acceptchallenge — leader of the CHALLENGED guild only. Starts
  // the 48-hour reputation race, snapshotting both guilds' current
  // reputation as the baseline.
  async guild_acceptchallenge(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can accept a challenge.');
    }

    const challenge = await GuildChallenge.findOne({ challengedGuildId: guild._id.toString(), status: 'pending' });
    if (!challenge) return msg.reply('❌ No pending challenge to accept.');

    const challenger = await Guild.findById(challenge.challengerGuildId);
    if (!challenger) {
      challenge.status = 'cancelled';
      await challenge.save();
      return msg.reply('❌ The challenging guild no longer exists — challenge cancelled.');
    }

    challenge.status = 'active';
    challenge.startRepChallenger = challenger.reputation || 0;
    challenge.startRepChallenged = guild.reputation || 0;
    challenge.startedAt = Date.now();
    challenge.endsAt = Date.now() + CHALLENGE_DURATION_MS;
    await challenge.save();

    msg.reply(`⚔️ Challenge accepted! *${guild.emblem} ${guild.name}* vs *${challenger.emblem} ${challenger.name}* — 48 hours, most reputation gained wins.`);
  },

  // .guild declinechallenge — leader of the CHALLENGED guild only.
  async guild_declinechallenge(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can decline a challenge.');
    }

    const challenge = await GuildChallenge.findOne({ challengedGuildId: guild._id.toString(), status: 'pending' });
    if (!challenge) return msg.reply('❌ No pending challenge to decline.');

    challenge.status = 'declined';
    await challenge.save();
    msg.reply('✅ Challenge declined.');
  },

  // .guild cancelchallenge — leader of the CHALLENGING guild only, and
  // only before it's been accepted.
  async guild_cancelchallenge(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');
    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can cancel a challenge.');
    }

    const challenge = await GuildChallenge.findOne({ challengerGuildId: guild._id.toString(), status: 'pending' });
    if (!challenge) return msg.reply('❌ No pending challenge to cancel.');

    challenge.status = 'cancelled';
    await challenge.save();
    msg.reply('✅ Challenge cancelled.');
  },

  // .guild season — view current season status (number, time remaining,
  // top 5 by season reputation), or the outcome if the season just ended.
  // This is the only place a season is actually checked/resolved — see
  // the big comment above _resolveSeasonIfDue for why that's deliberate.
  async guild_season(client, msg, args) {
    const resolved = await _resolveSeasonIfDue();
    if (resolved) {
      const winnerText = resolved.winner
        ? `🏆 *${resolved.winner.emblem} ${resolved.winner.name}* won Season ${resolved.endedSeason.seasonNumber}! ` +
          `+${SEASON_WIN_REPUTATION_BONUS} reputation, +💰${formatNum(SEASON_WIN_COINS)} treasury.`
        : `No guild earned any season reputation — Season ${resolved.endedSeason.seasonNumber} ends with no winner.`;
      return msg.reply(
        `🎉 *SEASON ${resolved.endedSeason.seasonNumber} HAS ENDED!*\n\n${winnerText}\n\n` +
        `⚔️ Season ${resolved.nextSeason.seasonNumber} has begun! Use *.guild season* to see standings.`
      );
    }

    const season = await _getCurrentSeason();
    const top = await Guild.find().sort({ seasonReputation: -1 }).limit(5);
    const remaining = Math.max(0, season.endsAt - Date.now());

    let text = `⚔️ *SEASON ${season.seasonNumber}*\n⏳ Ends in ${formatCooldown(remaining)}\n\n`;
    text += !top.length || (top[0].seasonReputation || 0) <= 0
      ? 'No guild has earned any season reputation yet.'
      : `🏆 *Standings*\n${top.map((g, i) => `${i + 1}. #${g.guildId ?? '?'} ${g.emblem} ${g.name} — 🌟 ${formatNum(g.seasonReputation || 0)}`).join('\n')}`;

    msg.reply(text);
  },

  // .guildseason — shorthand for .guild season.
  async guildseason(client, msg, args) {
    return module.exports.guild_season(client, msg, args);
  },

  // .guild leaderboard [level|xp|wealth] — defaults to level. Top 10
  // guilds ranked by the chosen metric.
  async guild_leaderboard(client, msg, args) {
    const metric = (args[0] || 'level').toLowerCase();
    const sortMap = {
      level: { level: -1, xp: -1 },
      xp: { xp: -1, level: -1 },
      wealth: { bank: -1, level: -1 },
      reputation: { reputation: -1, level: -1 },
    };
    const sortSpec = sortMap[metric];
    if (!sortSpec) return msg.reply('❌ Usage: .guild leaderboard [level|xp|wealth|reputation]');

    const guilds = await Guild.find().sort(sortSpec).limit(10);
    if (!guilds.length) return msg.reply('❌ No guilds have been created yet.');

    const valueFor = g =>
      metric === 'wealth' ? `💰 ${formatNum(g.bank)}` :
      metric === 'xp' ? `⭐ ${formatNum(g.xp)} XP` :
      metric === 'reputation' ? `🌟 ${formatNum(g.reputation || 0)} rep` :
      `⚡ Lv.${g.level}`;

    let text = `🏆 *Guild Leaderboard — ${metric[0].toUpperCase()}${metric.slice(1)}*\n\n`;
    guilds.forEach((g, i) => {
      text += `${i + 1}. #${g.guildId ?? '?'} ${g.emblem} ${g.name} — ${valueFor(g)} | 👥 ${g.members.length}\n`;
    });
    msg.reply(text);
  },

  // .guildlb — shorthand for .guild leaderboard. Implemented as a
  // delegate wrapper rather than an entry in index.js's central `aliases`
  // map, because that map only remaps a single token (e.g. inv ->
  // inventory) and this needs to expand into two tokens ("guild
  // leaderboard") — same pattern already used elsewhere in the bot for
  // .test -> .ping, .ach -> .achievements, .cardinfo -> .ci, etc.
  async guildlb(client, msg, args) {
    return module.exports.guild_leaderboard(client, msg, args);
  },
};
