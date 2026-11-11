// ─── API serializers ────────────────────────────────────────────────────────
// Pure functions that shape Mongoose documents into the public JSON the REST
// API returns. Keeping this separate from the routes means the exact response
// shape is unit-testable (tests/api-serializers.test.js) and can never leak
// private fields (loan, afk, warns, dob, ...) by accident — only the fields
// explicitly whitelisted here are ever exposed.

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    bio: u.bio,
    level: u.level,
    xp: u.xp,
    coins: u.coins,
    orbs: u.orbs,
    guildId: u.guildId ?? null,
    tradesCompleted: u.tradesCompleted ?? 0,
    achievements: Array.isArray(u.achievements) ? u.achievements.length : 0,
    cardCount: Array.isArray(u.cards) ? u.cards.length : 0,
    createdAt: u.createdAt ?? null,
    lastActiveAt: u.lastActiveAt ?? null,
  };
}

export function leaderboardEntry(u, type) {
  return { ...publicUser(u), score: u[type] ?? 0 };
}

export function publicCard(c) {
  if (!c) return null;
  return {
    cardId: c.cardId ?? null,
    anilistId: c.anilistId ?? null,
    malId: c.malId ?? null,
    name: c.name,
    series: c.series,
    aliases: Array.isArray(c.aliases) ? c.aliases : [],
    tier: c.tier ?? null,
    imageUrl: c.renderedUrl || c.imageUrl || '',
    description: c.description ?? '',
    value: c.value ?? 0,
  };
}

export function publicOwnedCard(c) {
  if (!c) return null;
  return {
    id: c._id ? String(c._id) : null,
    code: c.code ?? null,
    catalogueId: c.catalogueId ?? null,
    name: c.name ?? '',
    series: c.series ?? '',
    tier: c.tier ?? '',
    isForSale: Boolean(c.isForSale),
    price: c.price ?? 0,
    isLent: Boolean(c.isLent),
    timesTraded: c.timesTraded ?? 0,
    obtainedAt: c.obtainedAt ?? null,
  };
}

export function publicGuild(g) {
  if (!g) return null;
  return {
    guildId: g.guildId ?? null,
    name: g.name,
    emblem: g.emblem ?? '🏰',
    description: g.description ?? '',
    level: g.level ?? 1,
    xp: g.xp ?? 0,
    bank: g.bank ?? 0,
    reputation: g.reputation ?? 0,
    recruitment: g.recruitment ?? 'invite',
    maxMembers: g.maxMembers ?? 25,
    memberCount: Array.isArray(g.members) ? g.members.length : 0,
    leaderId: g.leaderId ?? null,
    questsCompleted: g.questsCompleted ?? 0,
    createdAt: g.createdAt ?? null,
  };
}

export function publicAuction(a) {
  if (!a) return null;
  return {
    id: a._id ? String(a._id) : null,
    code: a.code ?? null,
    cardName: a.cardName ?? '',
    cardTier: a.cardTier ?? '',
    startPrice: a.startPrice ?? 0,
    currentBid: a.currentBid ?? 0,
    currentBidder: a.currentBidder ?? null,
    sellerId: a.sellerId ?? null,
    endsAt: a.endsAt ?? null,
  };
}
