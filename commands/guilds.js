const Guild = require('../models/Guild');
const User = require('../models/User');
const { formatNum, formatCooldown, mentionName, mentionTag, resolveNameById, boldSans, doubleStruck, parseAmount, decodeIdKey } = require('../utils/helpers');
const { GUILD_ACHIEVEMENTS, checkGuildAchievements, formatGuildUnlockNotice } = require('../utils/guildAchievements');

const ROLE_RANK = Guild.ROLE_RANK;
const QUEST_DEFS = Guild.QUEST_DEFS;
const QUEST_ICON = { donate: '💰', cards: '🎴', games: '⚔️' };
const ROLE_ICON = { leader: '👑', officer: '🛡️', veteran: '⚔️', member: '👤' };
const ROLE_LABEL = { leader: 'Leader', officer: 'Officer', veteran: 'Veteran', member: 'Member' };

function roleIcon(role) { return ROLE_ICON[role] || '👤'; }
function roleLabel(role) { return ROLE_LABEL[role] || 'Member'; }
function getMember(guild, userId) { return guild.members.find(m => m.userId === userId); }
function getRole(guild, userId) { return getMember(guild, userId)?.role || null; }

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
  if (!questResult || !questResult.questCompleted) return '';
  const levelLine = questResult.guildLevelUp ? ` — 🏰 Guild leveled up to *${questResult.guildLevel}*!` : '';
  return `\n\n🎉 *Guild quest complete!* +💰${formatNum(questResult.rewardCoins)} treasury, +${formatNum(questResult.rewardXp)} guild XP${levelLine}`;
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
    const questTeaser = q.questType
      ? `\n\n${QUEST_ICON[q.questType]} Quest: ${formatNum(q.progress)}/${formatNum(q.goal)} — use *.guild quest* for details`
      : '';
    const card = [
      `╭━━━★彡 ${doubleStruck('GUILD')} 彡★━━━╮`,
      '',
      `${guild.emblem} *${guild.name}*`,
      guild.description ? `_${guild.description}_` : '_No description set._',
      '',
      line('Leader', leaderName),
      line('Members', `${guild.members.length}${officerCount ? ` (${officerCount} officer${officerCount === 1 ? '' : 's'})` : ''}`),
      line('Level', guild.level),
      line('XP', guild.xp),
      line('Bank', `${formatNum(guild.bank)}${interestNote}`),
      line('Created', guild.createdAt.toDateString()),
    ].join('\n') + questTeaser;

    msg.reply(card + formatGuildUnlockNotice(unlockedNow));
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
      `${roleIcon(m.role)} ${names[i]} — ${roleLabel(m.role)} — ${formatNum(m.contribution)} contribution`
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
    text += `Progress:\n${bar} ${formatNum(q.progress)}/${formatNum(q.goal)} (${pct}%)\n\n`;
    text += ranked.length
      ? `Contributors:\n${ranked.map(([, amount], i) => `${names[i]} — ${formatNum(amount)}`).join('\n')}\n\n`
      : 'No contributions yet — be the first!\n\n';
    text += `Reward:\n+${formatNum(q.rewardCoins)} guild coins\n+${formatNum(q.rewardXp)} guild XP\n\n`;
    text += `⏳ Resets in ${formatCooldown(remaining)}`;

    msg.reply(text + formatGuildUnlockNotice(unlockedNow));
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

    msg.reply(`🏰 Guild *${name}* created! Invite members with .guild invite @user`);
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

  // .guild leaderboard [level|xp|wealth] — defaults to level. Top 10
  // guilds ranked by the chosen metric.
  async guild_leaderboard(client, msg, args) {
    const metric = (args[0] || 'level').toLowerCase();
    const sortMap = {
      level: { level: -1, xp: -1 },
      xp: { xp: -1, level: -1 },
      wealth: { bank: -1, level: -1 },
    };
    const sortSpec = sortMap[metric];
    if (!sortSpec) return msg.reply('❌ Usage: .guild leaderboard [level|xp|wealth]');

    const guilds = await Guild.find().sort(sortSpec).limit(10);
    if (!guilds.length) return msg.reply('❌ No guilds have been created yet.');

    const valueFor = g =>
      metric === 'wealth' ? `💰 ${formatNum(g.bank)}` :
      metric === 'xp' ? `⭐ ${formatNum(g.xp)} XP` :
      `⚡ Lv.${g.level}`;

    let text = `🏆 *Guild Leaderboard — ${metric[0].toUpperCase()}${metric.slice(1)}*\n\n`;
    guilds.forEach((g, i) => {
      text += `${i + 1}. ${g.emblem} ${g.name} — ${valueFor(g)} | 👥 ${g.members.length}\n`;
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
