const Guild = require('../models/Guild');
const GuildChallenge = require('../models/GuildChallenge');
const Season = require('../models/Season');
const GuildEvent = require('../models/GuildEvent');
const BotState = require('../models/BotState');
const User = require('../models/User');
const { formatNum, formatCooldown, mentionName, mentionTag, resolveNameById, boldSans, doubleStruck, parseAmount, decodeIdKey, isOwner, safeGetChat } = require('../utils/helpers');
const { GUILD_ACHIEVEMENTS, checkGuildAchievements, formatGuildUnlockNotice } = require('../utils/guildAchievements');
const { withGuildLock } = require('../utils/guildLock');

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

  // Atomic claim: findOneAndUpdate's filter+update happens as one
  // indivisible operation in MongoDB, so if two people view this same
  // just-expired challenge at the same instant, only one of these calls
  // can move it from 'active' to 'resolving' — the other gets null back
  // and does nothing, rather than both computing gains and both awarding
  // the winner's reputation bonus. Same technique _resolveSeasonIfDue
  // already uses for seasons. The `challenge` param passed in may now be
  // stale (its in-memory status still says 'active') — that's fine, since
  // everything below either reads fields that don't change after accept
  // (startRepChallenger/startRepChallenged/endsAt/the guild ids) or
  // unconditionally overwrites status/winnerGuildId at the end rather
  // than depending on their current in-memory value.
  const claimed = await GuildChallenge.findOneAndUpdate(
    { _id: challenge._id, status: 'active', endsAt: { $lte: Date.now() } },
    { $set: { status: 'resolving' } },
    { new: true }
  );
  if (!claimed) return null;

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

  const winnerGuildId = gainA > gainB ? guildA._id : gainB > gainA ? guildB._id : null;
  let winner = null;

  // Only the WINNING guild is mutated (a flat +CHALLENGE_REWARD_REPUTATION
  // bonus) — reloaded fresh inside its own lock rather than reusing the
  // guildA/guildB pre-fetch above, so this can't silently clobber (or be
  // clobbered by) some unrelated concurrent change to that same guild
  // doc (a donate, an upgrade, another challenge resolving at the exact
  // same moment). Only ever locks ONE guild at a time here — guildA and
  // guildB are never both winners — so there's no lock-ordering/deadlock
  // concern to worry about between them.
  if (winnerGuildId) {
    winner = await withGuildLock(winnerGuildId, async () => {
      const fresh = await Guild.findById(winnerGuildId);
      if (!fresh) return null;
      Guild.awardReputation(fresh, CHALLENGE_REWARD_REPUTATION);
      await fresh.save();
      return fresh;
    });
  }
  // gainA === gainB -> tie, no reward, no winner.

  challenge.status = 'completed';
  challenge.winnerGuildId = winner ? winner._id.toString() : 'tie';
  await challenge.save();

  return { guildA, guildB, gainA, gainB, winner, noContest: false };
}

// ─── Shared: notifying every member of a guild ─────────────────────────────
// Guild membership is NOT tied to any single WhatsApp group — members can
// be scattered across many different groups the bot is in (or none at
// all beyond their own DM), since a guild is a cross-group social
// structure in this bot, not a per-group one. A DM to each member is
// therefore the only way to reliably reach everyone: there's no single
// "home group" to post an announcement in, a WhatsApp group's membership
// can span several different guilds at once (a group-wide @mention would
// look like unrelated spam to everyone else in that chat who isn't in
// this guild), and WhatsApp can only @mention someone who is actually a
// member of that specific chat in the first place. Best-effort per
// member — one member having blocked the bot, or a flaky send, shouldn't
// stop the rest of the guild from being notified.
async function _notifyGuildMembers(client, guild, message) {
  await Promise.all(guild.members.map(async (m) => {
    try {
      await client.sendMessage(m.userId, message);
    } catch (err) {
      console.error(`Failed to notify guild member ${m.userId} (guild ${guild.name}):`, err.message);
    }
  }));
}

// Formats the outcome from _resolveChallengeIfDue into a message — shared
// by whichever command happened to trigger the resolution.
function _formatChallengeResult(result) {
  if (result.noContest) return '\n\n⚔️ A guild challenge ended in a no-contest — one side no longer exists.';
  if (!result.winner) {
    return `\n\n⚔️ *Guild challenge ended in a tie!* ${result.guildA.name} and ${result.guildB.name} both gained ${result.gainA} reputation.`;
  }
  // Compared by id, not object reference — the winner returned by
  // _resolveChallengeIfDue is now a freshly-reloaded doc (see its
  // comment), never the same object as guildA/guildB even when it IS
  // guildA/guildB.
  const winnerIsA = result.winner._id.toString() === result.guildA._id.toString();
  const loser = winnerIsA ? result.guildB : result.guildA;
  return `\n\n⚔️ *Guild challenge complete!* 🏆 *${result.winner.emblem} ${result.winner.name}* beat *${loser.name}* ` +
    `(${winnerIsA ? result.gainA : result.gainB} vs ${winnerIsA ? result.gainB : result.gainA} reputation gained) ` +
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
    season = await Season.create({ seasonNumber: 1, startedAt: now, endsAt: now + SEASON_DURATION_MS, status: 'active' });
  }
  return season;
}

// Atomically resolves the current season if its window has passed, pays
// out the winner, resets every guild's seasonReputation, and starts the
// next season. Returns { endedSeason, winner, nextSeason }, or null if
// nothing was due and nothing needed resuming.
//
// Structured as a small resumable state machine rather than one
// straight-line sequence of awaits, specifically so a crash/restart
// partway through (bot dies after paying the winner but before resetting
// every guild, say) doesn't leave a season permanently stuck "ended, but
// the next one never started". Each step below persists a flag the
// moment it's confirmed done, and is skipped on a later call if that flag
// is already set — so resuming an interrupted resolution redoes only
// whatever didn't finish, never something that already happened.
async function _resolveSeasonIfDue() {
  const now = Date.now();

  // First: is there a season stuck mid-resolution from an earlier
  // interrupted attempt? Check this BEFORE looking for a newly-due one —
  // an interrupted season already has status 'resolving' (not 'active'),
  // so it wouldn't be found by the claim query below anyway, and finishing
  // it takes priority over starting a new resolution.
  let claimed = await Season.findOne({ status: 'resolving' }).sort({ seasonNumber: -1 });

  if (!claimed) {
    // Nothing stuck — normal path. Atomic claim: findOneAndUpdate's
    // filter+update happens as one indivisible operation in MongoDB, so
    // if two people run .guild season in the same second right as a
    // season ends, only one of these calls can match a still-active,
    // past-due season — the other gets null back and does nothing.
    //
    // The `$or` also matches a pre-migration document from before this
    // state machine existed (no `status` field yet, old `resolved: false`
    // field instead) — self-healing rather than needing a manual DB
    // migration: the first time this runs after deploy, an old-style
    // document gets claimed via the fallback branch and written back out
    // in the new shape from here on.
    claimed = await Season.findOneAndUpdate(
      {
        endsAt: { $lte: now },
        $or: [{ status: 'active' }, { status: { $exists: false }, resolved: false }],
      },
      { $set: { status: 'resolving' }, $unset: { resolved: '' } },
      { sort: { seasonNumber: -1 }, new: true }
    );
    if (!claimed) return null;
  }

  // Step 1: decide (and immediately persist) the winner, exactly once.
  // Must happen before anything below touches a guild — resuming after a
  // crash needs to reuse this SAME decision rather than re-ranking guilds
  // that may already be partially reset to 0 by a later step.
  if (claimed.winnerGuildId === null) {
    const topGuilds = await Guild.find().sort({ seasonReputation: -1 }).limit(1);
    const topGuild = topGuilds[0] && topGuilds[0].seasonReputation > 0 ? topGuilds[0] : null;
    claimed.winnerGuildId = topGuild ? topGuild._id.toString() : 'none';
    await claimed.save();
  }

  // Step 2: pay the winner, exactly once.
  let winner = null;
  if (claimed.winnerGuildId !== 'none') {
    if (!claimed.payoutComplete) {
      // Reloaded fresh inside its own lock rather than reusing any
      // pre-fetch — protects the payout from clobbering (or being
      // clobbered by) some unrelated concurrent mutation to this same
      // guild doc, same reasoning as _resolveChallengeIfDue.
      winner = await withGuildLock(claimed.winnerGuildId, async () => {
        const fresh = await Guild.findById(claimed.winnerGuildId);
        if (!fresh) return null;
        Guild.awardReputation(fresh, SEASON_WIN_REPUTATION_BONUS);
        fresh.bank += SEASON_WIN_COINS;
        fresh.seasonWins = (fresh.seasonWins || 0) + 1;
        Guild.logActivity(fresh, {
          eventType: 'season_won',
          text: `Season ${claimed.seasonNumber}`,
          amount: SEASON_WIN_COINS,
        });
        await fresh.save();
        return fresh;
      });
      claimed.payoutComplete = true;
      await claimed.save();
    } else {
      // Resuming after the payout already completed on a previous,
      // interrupted attempt — reload for the result/message, don't pay
      // again. (The guild having since been disbanded is the one gap
      // this can't paper over — winner just comes back null then.)
      winner = await Guild.findById(claimed.winnerGuildId);
    }
  }

  // Step 3: reset every guild's seasonReputation, exactly once. Bulk
  // update deliberately bypasses Mongoose document middleware (no
  // per-guild side effects belong here, this is just a field wipe), and
  // touches every guild regardless of whether they participated at all.
  // Running it twice would actually be harmless on its own ($set to 0 is
  // idempotent) — the flag is really just to avoid the redundant write.
  if (!claimed.guildsResetComplete) {
    await Guild.updateMany({}, { $set: { seasonReputation: 0 } });
    claimed.guildsResetComplete = true;
    await claimed.save();
  }

  // Step 4: create the next season, exactly once. The unique index on
  // seasonNumber (models/Season.js) makes a duplicate create fail with a
  // Mongo E11000 error instead of silently creating two Season #6
  // documents — caught below and treated as "already created on a
  // previous, interrupted attempt" rather than a real error.
  let nextSeason = await Season.findOne({ seasonNumber: claimed.seasonNumber + 1 });
  if (!nextSeason) {
    try {
      nextSeason = await Season.create({
        seasonNumber: claimed.seasonNumber + 1,
        startedAt: now,
        endsAt: now + SEASON_DURATION_MS,
        status: 'active',
      });
    } catch (err) {
      if (err.code === 11000) {
        nextSeason = await Season.findOne({ seasonNumber: claimed.seasonNumber + 1 });
      } else {
        throw err;
      }
    }
  }

  // Every step above is now confirmed done — only at this point does this
  // season's own record flip to 'completed'. If the process dies before
  // this line, the next call to _resolveSeasonIfDue finds status
  // 'resolving' again at the top of this function and redoes only
  // whatever's still unmarked — nothing above gets paid, reset, or
  // created twice.
  claimed.status = 'completed';
  await claimed.save();

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
    // Pure read, no other mutation in this command — the post-find hook in
    // models/Guild.js no longer auto-saves (see its comment for why), so
    // this explicitly persists whatever it normalized (interest, a rolled
    // quest/mission) instead of silently discarding it after every browse.
    await Promise.all(openGuilds.map(g => Guild.ensureGuildState(g)));
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

    return msg.reply(`🏰 *GUILDS LOOKING FOR MEMBERS*\n\n${lines.join('\n\n')}\n\nUse *.guild join [name or ID]* to apply.`);
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

    const guilds = await Guild.find();
    if (!guilds.length) return msg.reply('❌ No guilds exist yet.');

    // Bulk update rather than fetching every guild individually just for
    // the increment — this is meant to scale to however many guilds exist
    // without needing one round-trip per guild. It does mean this
    // bypasses per-guild activity-log entries (Guild.logActivity needs an
    // in-memory doc to push onto) — the GuildEvent history this creates
    // is the audit trail for this particular action instead.
    await Guild.updateMany({}, { $inc: { bank: amount } });
    await GuildEvent.create({ message, coinsPerGuild: amount, guildsAffected: guilds.length, triggeredBy: senderId });

    // Intentionally await, not return — the background member-notification
    // IIFE below still needs to run after this confirmation goes out.
    await msg.reply(`🎉 Event triggered! Every guild (${guilds.length}) just received 💰${formatNum(amount)} in their treasury.\n\nMessage: "${message}"`);

    // Notify every member of every affected guild in the background — the
    // owner's confirmation above doesn't wait on this, so triggering an
    // event across many guilds/members can't stall or time out the
    // command itself. Sequential per guild (not every guild at once) so
    // this doesn't try to blast every member of every guild
    // simultaneously on an unstable connection; members WITHIN one guild
    // are still notified in parallel. "Your guild", not "every guild" —
    // from an individual recipient's own perspective it's specifically
    // THEIR guild that benefited, which is what they actually care about.
    (async () => {
      const notifyText = `🎉 *Your guild just received a bonus!*\n\n💰 +${formatNum(amount)} added to the treasury.\n\n"${message}"`;
      for (const guild of guilds) {
        await _notifyGuildMembers(client, guild, notifyText);
      }
    })().catch(err => console.error('guildevent member notification batch failed:', err.message));
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
    return msg.reply(`🎊 *RECENT GUILD EVENTS*\n\n${lines.join('\n\n')}`);
  },

  // Public holidays that trigger a global 1M-coin celebration for every
  // guild — checked by month/day only, so each fires every year on the
  // same date. Deliberately a short, explicit list rather than guessing
  // at "any other public event" — add more the same way if wanted.
  // (Exported as data, not a function, purely so it's easy to find/edit —
  // it isn't a command and index.js never touches it directly.)
  _GUILD_HOLIDAYS: [
    { key: 'christmas', month: 12, day: 25, label: 'Christmas' },
    { key: 'newyear', month: 1, day: 1, label: 'New Year' },
  ],

  // Internal — called every minute by index.js's scheduler, not a real
  // dot-command (leading underscore excludes it from the command
  // dispatcher — same convention as _maybeSendDailyStats in
  // commands/general.js and _sweepInactiveUsers in commands/admin.js).
  // Gated to run once a day; checks two independent things:
  //   1. Every guild's own anniversary (1 year, 2 years, ...), computed
  //      from its own createdAt — a per-guild event, only that guild's
  //      members get notified.
  //   2. The calendar holidays above — a global event, every guild gets
  //      the bonus and every member of every guild is notified, same as a
  //      manual .guildevent.
  // Both pay a flat 1,000,000 coins. Safe to re-run if it ever fails
  // partway through: each guild's anniversary flag and each holiday's
  // per-year marker are only written AFTER that specific payout succeeds,
  // so a retry only ever picks up whatever didn't finish, never re-pays
  // something that already went through.
  async _maybeSendGuildEvents(client) {
    const now = new Date();
    if (now.getUTCHours() !== 8 || now.getUTCMinutes() !== 0) return; // 9AM WAT — a different minute than the other daily tasks, so the daily DB work doesn't all land at once

    const todayKey = now.toISOString().slice(0, 10);
    const state = await BotState.findOne({ key: 'guildEventsLastRun' }).catch(() => null);
    if (state?.value === todayKey) return;

    const AUTO_EVENT_AMOUNT = 1000000;

    try {
      // ── Per-guild anniversaries ────────────────────────────────────
      const guilds = await Guild.find();
      for (const guild of guilds) {
        // Doubles as the daily maintenance sweep for every guild in the
        // database — interest/quest/mission normalization used to get
        // persisted as a side effect of this same Guild.find() via the
        // model's read hooks; now that those hooks no longer auto-save
        // (see models/Guild.js), this explicit call keeps that same
        // "every guild gets freshened at least once a day" guarantee for
        // any guild that isn't otherwise touched by a command that day.
        await Guild.ensureGuildState(guild);

        const ageYears = Math.floor((Date.now() - guild.createdAt.getTime()) / (365 * 24 * 60 * 60 * 1000));
        if (ageYears < 1 || ageYears <= (guild.lastAnniversaryYearRewarded || 0)) continue;

        guild.bank += AUTO_EVENT_AMOUNT;
        guild.lastAnniversaryYearRewarded = ageYears;
        const ordinal = ageYears === 1 ? '1st' : ageYears === 2 ? '2nd' : ageYears === 3 ? '3rd' : `${ageYears}th`;
        const label = `${ordinal} Anniversary`;
        Guild.logActivity(guild, { eventType: 'event_bonus', text: label, amount: AUTO_EVENT_AMOUNT });
        await guild.save();
        await GuildEvent.create({ message: `${guild.name}'s ${label}`, coinsPerGuild: AUTO_EVENT_AMOUNT, guildsAffected: 1, triggeredBy: 'system' });

        const notifyText = `🎉 *Happy ${label}, ${guild.name}!*\n\n💰 +${formatNum(AUTO_EVENT_AMOUNT)} added to your guild's treasury to celebrate!`;
        _notifyGuildMembers(client, guild, notifyText).catch(err => console.error('Anniversary notification failed:', err.message));
      }

      // ── Global calendar holidays ───────────────────────────────────
      const holiday = module.exports._GUILD_HOLIDAYS.find(h => h.month === now.getUTCMonth() + 1 && h.day === now.getUTCDate());
      if (holiday) {
        const holidayStateKey = `guildHoliday_${holiday.key}_year`;
        const thisYear = String(now.getUTCFullYear());
        const holidayState = await BotState.findOne({ key: holidayStateKey }).catch(() => null);

        if (holidayState?.value !== thisYear) {
          const allGuilds = await Guild.find();
          if (allGuilds.length) {
            await Guild.updateMany({}, { $inc: { bank: AUTO_EVENT_AMOUNT } });
            await GuildEvent.create({ message: holiday.label, coinsPerGuild: AUTO_EVENT_AMOUNT, guildsAffected: allGuilds.length, triggeredBy: 'system' });

            const notifyText = `🎉 *Happy ${holiday.label}!*\n\n💰 +${formatNum(AUTO_EVENT_AMOUNT)} added to your guild's treasury to celebrate!`;
            (async () => {
              for (const g of allGuilds) await _notifyGuildMembers(client, g, notifyText);
            })().catch(err => console.error('Holiday notification batch failed:', err.message));
          }
          await BotState.findOneAndUpdate({ key: holidayStateKey }, { value: thisYear }, { upsert: true });
        }
      }

      await BotState.findOneAndUpdate({ key: 'guildEventsLastRun' }, { value: todayKey }, { upsert: true });
      console.log(`✅ Daily guild events check completed at ${now.toLocaleString()}`);
    } catch (err) {
      console.error('❌ Guild events daily check failed:', err.message);
    }
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

    // Pure read, no other mutation in this command — see the .guild
    // (bare) comment above for why this explicit call is needed now that
    // the post-find hook in models/Guild.js no longer auto-saves.
    await Guild.ensureGuildState(guild);

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

    return msg.reply(card + formatGuildUnlockNotice(unlockedNow) + challengeResultNote);
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

    return msg.reply(
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

    // Everything from the load through the save happens inside this
    // guild's lock (utils/guildLock.js) — including the role check and
    // name resolution, not just the final .save(). Loading the guild
    // BEFORE the lock and mutating a possibly-stale members[] array would
    // let this silently overwrite a promotion/demotion/another removal
    // that landed on the same guild in between.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };

      const actorRole = getRole(guild, contact.id._serialized);
      if (actorRole !== 'leader' && actorRole !== 'officer') return { error: 'norole' };

      if (guild.members.length <= 1) return { error: 'onlymember' };

      const memberResult = await _resolveMemberByName(client, guild, query);
      if (!memberResult) return { error: 'nomatch', guildName: guild.name };
      if (memberResult.ambiguous) return { error: 'ambiguous', names: memberResult.ambiguous };

      const { member: target, name: targetName } = memberResult;

      if (target.userId === contact.id._serialized) return { error: 'self' };
      if (ROLE_RANK[actorRole] <= ROLE_RANK[target.role]) {
        return { error: 'outrank', targetName, targetRole: target.role };
      }

      guild.members = guild.members.filter(m => m.userId !== target.userId);
      Guild.logActivity(guild, { eventType: 'member_left', userId: target.userId });
      await guild.save();

      return { guild, targetName, targetUserId: target.userId };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader or an officer can remove members.');
    if (result.error === 'onlymember') return msg.reply('❌ There are no other members to remove.');
    if (result.error === 'nomatch') return msg.reply(`❌ No member named "${query}" found in *${result.guildName}*.`);
    if (result.error === 'ambiguous') {
      return msg.reply(`❌ That matches multiple members: ${result.names.join(', ')}. Be more specific.`);
    }
    if (result.error === 'self') return msg.reply('❌ You can\'t remove yourself — use .guild leave instead.');
    if (result.error === 'outrank') {
      return msg.reply(`❌ You don't outrank ${roleLabel(result.targetRole)} ${result.targetName} enough to remove them.`);
    }

    const { guild, targetName, targetUserId } = result;
    await User.findOneAndUpdate({ id: targetUserId }, { guildId: null });

    return msg.reply(`✅ Removed *${targetName}* from *${guild.emblem} ${guild.name}*.`);
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

    // See .guild remove's comment above for why the whole cycle (load
    // through save) needs to be inside the lock, not just the save.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      const memberResult = await _resolveMemberByName(client, guild, query);
      if (!memberResult) return { error: 'nomatch', guildName: guild.name };
      if (memberResult.ambiguous) return { error: 'ambiguous', names: memberResult.ambiguous };

      const { member: target, name: targetName } = memberResult;

      if (target.role === 'leader') return { error: 'isleader' };
      if (target.role === 'officer') return { error: 'maxrank', targetName };

      const next = target.role === 'member' ? 'veteran' : 'officer';
      target.role = next;
      await guild.save();

      return { guildName: guild.name, targetName, next };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can promote members.');
    if (result.error === 'nomatch') return msg.reply(`❌ No member named "${query}" found in *${result.guildName}*.`);
    if (result.error === 'ambiguous') {
      return msg.reply(`❌ That matches multiple members: ${result.names.join(', ')}. Be more specific.`);
    }
    if (result.error === 'isleader') return msg.reply('❌ That\'s you — the leader can\'t promote themselves.');
    if (result.error === 'maxrank') {
      return msg.reply(`❌ ${result.targetName} is already an Officer — the highest rank .guild promote can reach.`);
    }

    const { guildName, targetName, next } = result;
    return msg.reply(`✅ ${roleIcon(next)} *${targetName}* promoted to ${roleLabel(next)} in *${guildName}*.`);
  },

  // .guild demote [member's name] — leader only. Steps a member down one
  // rank: officer -> veteran -> member.
  async guild_demote(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild demote [member\'s name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // See .guild remove's comment above for why the whole cycle (load
    // through save) needs to be inside the lock, not just the save.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      const memberResult = await _resolveMemberByName(client, guild, query);
      if (!memberResult) return { error: 'nomatch', guildName: guild.name };
      if (memberResult.ambiguous) return { error: 'ambiguous', names: memberResult.ambiguous };

      const { member: target, name: targetName } = memberResult;

      if (target.role === 'leader') return { error: 'isleader' };
      if (target.role === 'member') return { error: 'minrank', targetName };

      const next = target.role === 'officer' ? 'veteran' : 'member';
      target.role = next;
      await guild.save();

      return { guildName: guild.name, targetName, next };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can demote members.');
    if (result.error === 'nomatch') return msg.reply(`❌ No member named "${query}" found in *${result.guildName}*.`);
    if (result.error === 'ambiguous') {
      return msg.reply(`❌ That matches multiple members: ${result.names.join(', ')}. Be more specific.`);
    }
    if (result.error === 'isleader') {
      return msg.reply('❌ The leader can\'t be demoted — leadership transfer isn\'t supported yet.');
    }
    if (result.error === 'minrank') return msg.reply(`❌ ${result.targetName} is already at the lowest rank (Member).`);

    const { guildName, targetName, next } = result;
    return msg.reply(`✅ ${roleIcon(next)} *${targetName}* demoted to ${roleLabel(next)} in *${guildName}*.`);
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
    return msg.reply('✅ Guild description updated.');
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

    return msg.reply(`📢 *GUILD ANNOUNCEMENT*\n\n${text}\n\nAll members are encouraged to check .guild info.`);
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

    if (user.coins < amount) return msg.reply('❌ Not enough coins.');

    // Everything that touches the guild document — load, membership
    // check, bank/contribution/quest mutation, save — happens inside this
    // guild's lock (utils/guildLock.js). Without it, two members donating
    // to the SAME guild at nearly the same instant could both load the
    // same bank/contribution/quest values, each apply their own donation
    // in memory, and have one save silently overwrite the other's — the
    // second donor's coins would leave their wallet but never actually
    // land in the guild's bank.
    //
    // Restructured so the donor's OWN wallet debit (below, after this)
    // only happens once the guild side is confirmed saved — if the guild
    // save throws, this whole call rejects and the wallet is never
    // touched, rather than the original code's Promise.all firing both
    // saves at once regardless of whether the other succeeded.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };

      const member = getMember(guild, contact.id._serialized);
      if (!member) return { error: 'nomember' };

      // Same convention as guild_info above — reflects interest already
      // credited by the post-find hook in models/Guild.js at fetch time,
      // before this donation's own += is applied below.
      const interestNote = guild._interestCredited > 0
        ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
        : '';

      guild.bank += amount;
      member.contribution += amount;
      Guild.logActivity(guild, { eventType: 'donate', userId: contact.id._serialized, amount });

      // In-memory only — guild is already loaded and already being saved
      // below, so this reuses that same write instead of a second
      // fetch/save. No-ops (returns null) if the active quest isn't a
      // "donate" quest.
      const questResult = Guild.applyQuestProgress(guild, contact.id._serialized, 'donate', amount);

      await guild.save();
      return { guild, member, interestNote, questResult };
    });

    if (result.error === 'notfound') {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }
    if (result.error === 'nomember') {
      return msg.reply('❌ Guild membership record not found — try leaving and rejoining.');
    }

    const { guild, member, interestNote, questResult } = result;
    user.coins -= amount;
    await user.save();

    const questNote = _formatQuestCompletionNote(questResult);

    // Bank just changed (and possibly level/questsCompleted too, if that
    // donation finished off the active quest) — check right after, rather
    // than waiting for the guild to next be viewed.
    const unlockedNow = await checkGuildAchievements(guild._id);

    return msg.reply(
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

    // Everything that touches the guild document — load, leader check,
    // bank debit, save — happens inside this guild's lock, same as .guild
    // donate. Restructured so the leader's OWN wallet credit (below,
    // after this) only happens once the treasury debit is confirmed
    // saved, instead of the original Promise.all firing both saves at
    // once regardless of whether the other succeeded — without this, a
    // failed wallet save after a successful bank debit would make the
    // withdrawn coins vanish outright.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      const interestNote = guild._interestCredited > 0
        ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
        : '';
      if (guild.bank < amount) return { error: 'insufficient', bank: guild.bank, interestNote };

      guild.bank -= amount;
      Guild.logActivity(guild, { eventType: 'withdraw', userId: contact.id._serialized, amount });
      await guild.save();

      return { guild, interestNote };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can withdraw from the treasury.');
    if (result.error === 'insufficient') {
      return msg.reply(`❌ Not enough in the treasury. Bank: ${formatNum(result.bank)}${result.interestNote}`);
    }

    const { guild, interestNote } = result;
    user.coins += amount;
    await user.save();

    return msg.reply(
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
    return msg.reply(text.trim());
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

    // Whole cycle inside the guild's lock — two upgrade purchases (or an
    // upgrade racing a withdraw/donate) landing on the same guild at once
    // could otherwise both read the same stale bank/level and one save
    // would silently overwrite the other's.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      const info = Guild.UPGRADE_NAMES[upgradeKey];
      const currentLevel = guild.upgrades[upgradeKey] || 0;
      const cost = Guild.getUpgradeCost(currentLevel);
      if (cost === null) return { error: 'maxed', label: info.label };

      const interestNote = guild._interestCredited > 0
        ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
        : '';
      if (guild.bank < cost) return { error: 'insufficient', cost, bank: guild.bank, interestNote };

      guild.bank -= cost;
      guild.upgrades[upgradeKey] = currentLevel + 1;
      Guild.logActivity(guild, {
        eventType: 'upgrade',
        userId: contact.id._serialized,
        amount: cost,
        text: `${info.label} -> level ${currentLevel + 1}`,
      });
      await guild.save();

      return { guild, info, newLevel: currentLevel + 1, interestNote };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can purchase upgrades.');
    if (result.error === 'maxed') {
      return msg.reply(`❌ *${result.label}* is already at max level (${Guild.UPGRADE_MAX_LEVEL}).`);
    }
    if (result.error === 'insufficient') {
      return msg.reply(`❌ Not enough in the treasury. Need 💰${formatNum(result.cost)}, have ${formatNum(result.bank)}${result.interestNote}.`);
    }

    const { guild, info, newLevel, interestNote } = result;
    return msg.reply(
      `✅ *${info.label}* upgraded to level ${newLevel}! (${info.perLevel} ${info.effect})${interestNote}\n` +
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
    return msg.reply(text);
  },

  // .guild buy [banner key] — leader only.
  async guild_buy(client, msg, args) {
    const contact = await msg.getContact();
    const key = (args[0] || '').toLowerCase();
    const banner = Guild.SHOP_BANNERS[key];
    if (!banner) return msg.reply('❌ Usage: .guild buy [banner name]\n\nUse *.guild shop* to see what\'s available.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Whole cycle inside the guild's lock — same reasoning as .guild
    // upgrade above.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };
      if (guild.ownedBanners.includes(key)) return { error: 'owned', guildName: guild.name };

      const interestNote = guild._interestCredited > 0
        ? ` (📈 +${formatNum(guild._interestCredited)} interest just credited)`
        : '';
      if (guild.bank < banner.cost) return { error: 'insufficient', bank: guild.bank, interestNote };

      guild.bank -= banner.cost;
      guild.ownedBanners.push(key);
      Guild.logActivity(guild, {
        eventType: 'shop_purchase',
        userId: contact.id._serialized,
        amount: banner.cost,
        text: `${banner.name} Banner`,
      });
      await guild.save();

      return { guild, interestNote };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can buy from the shop.');
    if (result.error === 'owned') return msg.reply(`❌ *${result.guildName}* already owns the ${banner.name} banner.`);
    if (result.error === 'insufficient') {
      return msg.reply(`❌ Not enough in the treasury. Need 💰${formatNum(banner.cost)}, have ${formatNum(result.bank)}${result.interestNote}.`);
    }

    const { guild, interestNote } = result;
    return msg.reply(`✅ Purchased the *${banner.name} Banner*!${interestNote}\nEquip it with *.guild banner ${key}*.\nGuild bank: ${formatNum(guild.bank)}`);
  },

  // .guild banner [name|none] — leader only. Equips an already-owned
  // banner (free to switch), or clears it back to the default border.
  async guild_banner(client, msg, args) {
    const contact = await msg.getContact();
    const key = (args[0] || '').toLowerCase();
    if (!key) return msg.reply('❌ Usage: .guild banner [name|none]\n\nUse *.guild shop* to see what your guild owns.');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Whole cycle inside the guild's lock — a banner change racing a shop
    // purchase (which also touches this guild doc) could otherwise land
    // on a stale in-memory copy.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      if (key === 'none') {
        guild.activeBanner = null;
        await guild.save();
        return { cleared: true };
      }

      if (!guild.ownedBanners.includes(key)) return { error: 'notowned', guildName: guild.name };

      guild.activeBanner = key;
      await guild.save();
      return { cleared: false };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can change the guild banner.');
    if (result.error === 'notowned') return msg.reply(`❌ *${result.guildName}* doesn't own that banner yet. Check *.guild shop*.`);
    if (result.cleared) return msg.reply('✅ Banner cleared — back to the default look.');

    return msg.reply(`✅ Equipped the *${Guild.SHOP_BANNERS[key].name} Banner*!`);
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

    // Pure read, no other mutation in this command — same reasoning as
    // .guild info/.guild season/.guild leaderboard/bare .guild. Without
    // this, a quest that just expired gets silently re-rolled (in memory
    // only) every single time someone checks it instead of the roll
    // actually sticking.
    await Guild.ensureGuildState(guild);

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

    return msg.reply(text + formatGuildUnlockNotice(unlockedNow));
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

    // Pure read, no other mutation in this command — see .guild quest's
    // identical comment above.
    await Guild.ensureGuildState(guild);

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

    return msg.reply(text + formatGuildUnlockNotice(unlockedNow));
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
    return msg.reply(text);
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

    return msg.reply(`📜 *RECENT GUILD ACTIVITY* — ${guild.emblem} ${guild.name}\n\n${lines.join('\n')}`);
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

    return msg.reply(`🏰 Guild *${name}* (#${guild.guildId}) created! Invite members with .guild invite @user`);
  },

  // .guild invite @user — leader or officer
  async guild_invite(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .guild invite @user');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const target = mentioned[0];

    // Whole cycle inside the guild's lock — two invites (or an invite
    // racing an accept/decline for someone else) landing on the same
    // guild at once could otherwise both read the same stale
    // pendingInvites array and one save would drop the other's entry.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };

      const actorRole = getRole(guild, contact.id._serialized);
      if (actorRole !== 'leader' && actorRole !== 'officer') return { error: 'norole' };

      if (guild.pendingInvites.includes(target.id._serialized)) return { error: 'already' };

      guild.pendingInvites.push(target.id._serialized);
      await guild.save();
      return { guildName: guild.name };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader or an officer can invite.');
    if (result.error === 'already') return msg.reply('❌ Already invited!');

    return msg.reply(
      `📨 Invited @${mentionTag(target)} to *${result.guildName}*! They can type *.guild accept* to join.`,
      undefined,
      { mentions: [target.id._serialized] }
    );
  },

  // .guild accept
  async guild_accept(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (user.guildId) return msg.reply('❌ Leave your current guild first.');

    const invited = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!invited) return msg.reply('❌ No pending guild invite found.');

    // The findOne above only identifies WHICH guild to lock — everything
    // that actually reads/mutates the guild happens on a fresh load taken
    // INSIDE that guild's lock, re-checking the invite is still there.
    // Without the re-check, a stale pre-lock read could let this accept
    // an invite that was withdrawn or declined a moment earlier.
    const result = await withGuildLock(invited._id, async () => {
      const guild = await Guild.findById(invited._id);
      if (!guild) return { error: 'notfound' };
      if (!guild.pendingInvites.includes(contact.id._serialized)) return { error: 'gone' };

      guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
      guild.members.push({ userId: contact.id._serialized, role: 'member', joinedAt: new Date(), contribution: 0 });
      Guild.logActivity(guild, { eventType: 'member_joined', userId: contact.id._serialized });
      await guild.save();

      return { guild };
    });

    if (result.error === 'notfound' || result.error === 'gone') {
      return msg.reply('❌ No pending guild invite found.');
    }

    // Guild side confirmed saved first — only then does the new member's
    // own user doc get updated, same pattern as .guild donate/.guild
    // withdraw above.
    user.guildId = result.guild._id.toString();
    await user.save();

    return msg.reply(`🏰 You joined *${result.guild.emblem} ${result.guild.name}*!`);
  },

  // .guild decline
  async guild_decline(client, msg, args) {
    const contact = await msg.getContact();
    const invited = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!invited) return msg.reply('❌ No pending invite.');

    // Same identify-outside/re-verify-inside-the-lock pattern as .guild
    // accept above.
    const result = await withGuildLock(invited._id, async () => {
      const guild = await Guild.findById(invited._id);
      if (!guild || !guild.pendingInvites.includes(contact.id._serialized)) return { error: 'gone' };

      guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
      await guild.save();
      return {};
    });

    if (result.error === 'gone') return msg.reply('❌ No pending invite.');
    return msg.reply('✅ Invite declined.');
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

    const found = await _resolveGuildForJoin(query);
    if (!found) return msg.reply(`❌ No guild found matching "${query}". Use *.guild* to browse guilds looking for members.`);

    // The resolve above only identifies WHICH guild to lock — recruitment
    // setting, capacity, and "already applied" are all re-checked on a
    // fresh load taken INSIDE that guild's lock, since any of them could
    // have changed (a slot filling up, recruitment closing) between the
    // resolve and the lock actually being acquired.
    const result = await withGuildLock(found._id, async () => {
      const guild = await Guild.findById(found._id);
      if (!guild) return { error: 'notfound' };

      if (guild.recruitment === 'closed') return { error: 'closed', guildName: guild.name };
      if (guild.recruitment === 'invite') return { error: 'inviteonly', guildName: guild.name };
      const maxMembers = Guild.effectiveMaxMembers(guild);
      if (guild.members.length >= maxMembers) {
        return { error: 'full', guildName: guild.name, count: guild.members.length, max: maxMembers };
      }
      if (guild.pendingApplications.includes(contact.id._serialized)) {
        return { error: 'already', guildName: guild.name };
      }

      guild.pendingApplications.push(contact.id._serialized);
      await guild.save();
      return { guild };
    });

    if (result.error === 'notfound') {
      return msg.reply(`❌ No guild found matching "${query}". Use *.guild* to browse guilds looking for members.`);
    }
    if (result.error === 'closed') return msg.reply(`❌ *${result.guildName}* isn't accepting new members right now.`);
    if (result.error === 'inviteonly') {
      return msg.reply(`❌ *${result.guildName}* is invite-only — ask the leader or an officer to invite you.`);
    }
    if (result.error === 'full') return msg.reply(`❌ *${result.guildName}* is full (${result.count}/${result.max}).`);
    if (result.error === 'already') {
      return msg.reply(`❌ You've already applied to *${result.guildName}* — wait for a leader or officer to review it.`);
    }

    const { guild } = result;
    return msg.reply(`📨 Application sent to *${guild.emblem} ${guild.name}*! A leader or officer needs to approve it with *.guild acceptapp*.`);
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

    return msg.reply(`💤 *Inactive Members (${INACTIVE_DAYS}+ days) — ${guild.name}*\n\n${lines.join('\n')}`);
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
    return msg.reply(`📨 *Pending Applications — ${guild.name}*\n\n${list}\n\nUse *.guild acceptapp [name]* or *.guild declineapp [name]*.`);
  },

  // .guild acceptapp [applicant's name] — leader/officer only.
  async guild_acceptapp(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply("❌ Usage: .guild acceptapp [applicant's name]");

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Whole cycle — including applicant-name resolution and the "did
    // they already join elsewhere" check — happens inside this guild's
    // lock. See .guild remove's comment above for why.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };

      const actorRole = getRole(guild, contact.id._serialized);
      if (actorRole !== 'leader' && actorRole !== 'officer') return { error: 'norole' };
      if (!guild.pendingApplications.length) return { error: 'none' };

      const appResult = await _resolveUserIdByName(client, guild.pendingApplications, query);
      if (!appResult) return { error: 'nomatch' };
      if (appResult.ambiguous) return { error: 'ambiguous', names: appResult.ambiguous };

      const { userId: applicantId, name: applicantName } = appResult;

      const maxMembers = Guild.effectiveMaxMembers(guild);
      if (guild.members.length >= maxMembers) {
        return { error: 'full', guildName: guild.name, count: guild.members.length, max: maxMembers };
      }

      // The applicant might have joined a different guild while waiting
      // on this one — double-check rather than silently creating an
      // inconsistent double-membership.
      const applicantUser = await User.findOne({ id: applicantId });
      if (!applicantUser || applicantUser.guildId) {
        guild.pendingApplications = guild.pendingApplications.filter(id => id !== applicantId);
        await guild.save();
        return { error: 'unavailable', applicantName };
      }

      guild.pendingApplications = guild.pendingApplications.filter(id => id !== applicantId);
      guild.members.push({ userId: applicantId, role: 'member', joinedAt: new Date(), contribution: 0 });
      Guild.logActivity(guild, { eventType: 'member_joined', userId: applicantId });
      await guild.save();

      return { guild, applicantUser, applicantName };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader or an officer can approve applications.');
    if (result.error === 'none') return msg.reply('📭 No pending applications.');
    if (result.error === 'nomatch') return msg.reply(`❌ No applicant named "${query}" found.`);
    if (result.error === 'ambiguous') {
      return msg.reply(`❌ That matches multiple applicants: ${result.names.join(', ')}. Be more specific.`);
    }
    if (result.error === 'full') {
      return msg.reply(`❌ *${result.guildName}* is full (${result.count}/${result.max}) — remove someone first.`);
    }
    if (result.error === 'unavailable') {
      return msg.reply(`❌ ${result.applicantName} is no longer available to join — application removed.`);
    }

    // Guild side confirmed saved first — only then does the applicant's
    // own user doc get updated, same pattern as .guild accept above.
    const { guild, applicantUser, applicantName } = result;
    applicantUser.guildId = guild._id.toString();
    await applicantUser.save();

    return msg.reply(`✅ ${applicantName} has been accepted into *${guild.emblem} ${guild.name}*!`);
  },

  // .guild declineapp [applicant's name] — leader/officer only.
  async guild_declineapp(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply("❌ Usage: .guild declineapp [applicant's name]");

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Whole cycle inside the guild's lock — see .guild remove's comment
    // above for why.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };

      const actorRole = getRole(guild, contact.id._serialized);
      if (actorRole !== 'leader' && actorRole !== 'officer') return { error: 'norole' };
      if (!guild.pendingApplications.length) return { error: 'none' };

      const appResult = await _resolveUserIdByName(client, guild.pendingApplications, query);
      if (!appResult) return { error: 'nomatch' };
      if (appResult.ambiguous) return { error: 'ambiguous', names: appResult.ambiguous };

      guild.pendingApplications = guild.pendingApplications.filter(id => id !== appResult.userId);
      await guild.save();
      return { applicantName: appResult.name };
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader or an officer can decline applications.');
    if (result.error === 'none') return msg.reply('📭 No pending applications.');
    if (result.error === 'nomatch') return msg.reply(`❌ No applicant named "${query}" found.`);
    if (result.error === 'ambiguous') {
      return msg.reply(`❌ That matches multiple applicants: ${result.names.join(', ')}. Be more specific.`);
    }

    return msg.reply(`✅ Declined ${result.applicantName}'s application.`);
  },

  // .guild recruitment                       — view current setting
  // .guild recruitment [open|invite|closed]  — set (leader only)
  async guild_recruitment(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const setting = args[0]?.toLowerCase();
    if (!setting) {
      // View mode — pure read, no lock needed (same as the other bare
      // read commands).
      const guild = await Guild.findById(user.guildId);
      if (!guild) return msg.reply('❌ Guild not found.');
      return msg.reply(`🔧 Recruitment is currently *${guild.recruitment}*.\nUsage: .guild recruitment [open|invite|closed]`);
    }
    if (!['open', 'invite', 'closed'].includes(setting)) {
      return msg.reply('❌ Usage: .guild recruitment [open|invite|closed]');
    }

    // Set mode — whole cycle inside the guild's lock, same reasoning as
    // every other guild-doc mutation above.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      guild.recruitment = setting;
      await guild.save();
      return {};
    });

    if (result.error === 'notfound') return msg.reply('❌ Guild not found.');
    if (result.error === 'norole') return msg.reply('❌ Only the guild leader can change the recruitment setting.');

    return msg.reply(`✅ Recruitment set to *${setting}*.`);
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
    return msg.reply(`✅ Guild emblem updated to ${emblem}!`);
  },

  // .guild leave
  async guild_leave(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Whole cycle inside the guild's lock — see .guild remove's comment
    // above for why. Restructured so the user's own guildId is only
    // cleared once the guild's own membership save is confirmed, instead
    // of the original Promise.all firing both at once — without this, a
    // failed guild save could leave someone stuck in a guild their own
    // user doc no longer points at.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId === contact.id._serialized) return { error: 'isleader' };

      guild.members = guild.members.filter(m => m.userId !== contact.id._serialized);
      Guild.logActivity(guild, { eventType: 'member_left', userId: contact.id._serialized });
      await guild.save();

      return { guildName: guild.name };
    });

    if (result.error === 'notfound') {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }
    if (result.error === 'isleader') return msg.reply('❌ Leaders cannot leave. Disband the guild instead.');

    user.guildId = null;
    await user.save();
    return msg.reply(`✅ You left *${result.guildName}*.`);
  },

  // .guild disband — leader only
  async guild_disband(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    // Locked so a disband can't run in the middle of some OTHER command's
    // load-then-save for this same guild (e.g. a donate mid-flight) —
    // without this, that other command's later save could silently
    // debit/credit against a guild that no longer exists. Any command
    // queued behind this one re-fetches fresh once it's their turn and
    // correctly finds the guild gone.
    const result = await withGuildLock(user.guildId, async () => {
      const guild = await Guild.findById(user.guildId);
      if (!guild) return { error: 'notfound' };
      if (guild.leaderId !== contact.id._serialized) return { error: 'norole' };

      // Remove guild from all members
      await User.updateMany({ guildId: guild._id.toString() }, { guildId: null });
      await Guild.findByIdAndDelete(guild._id);
      return { guildName: guild.name };
    });

    if (result.error === 'notfound') {
      user.guildId = null;
      await user.save();
      return msg.reply('❌ Guild not found.');
    }
    if (result.error === 'norole') return msg.reply('❌ Only the leader can disband.');

    return msg.reply(`🏰 Guild *${result.guildName}* has been disbanded.`);
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
      // Includes 'resolving' — a challenge mid-atomic-claim (see
      // _resolveChallengeIfDue) is still effectively in progress for the
      // handful of milliseconds that state exists; without this, a new
      // challenge could theoretically be started in that gap.
      status: { $in: ['pending', 'active', 'resolving'] },
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
      status: { $in: ['pending', 'active', 'resolving'] },
    });
    if (targetBusy) return msg.reply(`❌ *${target.name}* already has a pending or active challenge.`);

    await GuildChallenge.create({ challengerGuildId: guildIdStr, challengedGuildId: targetIdStr });
    return msg.reply(`⚔️ Challenge sent to *${target.emblem} ${target.name}*! Their leader can accept with *.guild acceptchallenge*.`);
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

    return msg.reply(`⚔️ Challenge accepted! *${guild.emblem} ${guild.name}* vs *${challenger.emblem} ${challenger.name}* — 48 hours, most reputation gained wins.`);
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
    return msg.reply('✅ Challenge declined.');
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
    return msg.reply('✅ Challenge cancelled.');
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
    // Pure read, no other mutation in this command — see the .guild
    // (bare) comment above for why this explicit call is needed.
    await Promise.all(top.map(g => Guild.ensureGuildState(g)));
    const remaining = Math.max(0, season.endsAt - Date.now());

    let text = `⚔️ *SEASON ${season.seasonNumber}*\n⏳ Ends in ${formatCooldown(remaining)}\n\n`;
    text += !top.length || (top[0].seasonReputation || 0) <= 0
      ? 'No guild has earned any season reputation yet.'
      : `🏆 *Standings*\n${top.map((g, i) => `${i + 1}. #${g.guildId ?? '?'} ${g.emblem} ${g.name} — 🌟 ${formatNum(g.seasonReputation || 0)}`).join('\n')}`;

    return msg.reply(text);
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
    // Pure read, no other mutation in this command — see the .guild
    // (bare) comment above for why this explicit call is needed.
    await Promise.all(guilds.map(g => Guild.ensureGuildState(g)));

    const valueFor = g =>
      metric === 'wealth' ? `💰 ${formatNum(g.bank)}` :
      metric === 'xp' ? `⭐ ${formatNum(g.xp)} XP` :
      metric === 'reputation' ? `🌟 ${formatNum(g.reputation || 0)} rep` :
      `⚡ Lv.${g.level}`;

    let text = `🏆 *Guild Leaderboard — ${metric[0].toUpperCase()}${metric.slice(1)}*\n\n`;
    guilds.forEach((g, i) => {
      text += `${i + 1}. #${g.guildId ?? '?'} ${g.emblem} ${g.name} — ${valueFor(g)} | 👥 ${g.members.length}\n`;
    });
    return msg.reply(text);
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
