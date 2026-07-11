const User = require('../models/User');

// ─── Format Numbers ───────────────────────────────────────────────────────────
function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Cooldown Helper ──────────────────────────────────────────────────────────
function formatCooldown(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

// ─── Random Range ─────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Pick Random from Array ───────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Check if user is group admin ─────────────────────────────────────────────
async function isAdmin(msg) {
  const chat = await msg.getChat();
  if (!chat.isGroup) return false;
  const contact = await msg.getContact();
  const participant = chat.participants.find(
    p => p.id._serialized === contact.id._serialized
  );
  return participant && (participant.isAdmin || participant.isSuperAdmin);
}

// ─── Check if bot is admin ────────────────────────────────────────────────────
async function botIsAdmin(msg) {
  const chat = await msg.getChat();
  if (!chat.isGroup) return false;
  const botId = msg.to;
  const participant = chat.participants.find(p => p.id._serialized === botId);
  return participant && (participant.isAdmin || participant.isSuperAdmin);
}

// ─── XP & Level ──────────────────────────────────────────────────────────────
async function addXP(userId, amount) {
  const user = await User.findOne({ id: userId });
  if (!user) return;
  user.xp += amount;
  const nextLevel = user.level * 100;
  if (user.xp >= nextLevel) {
    user.xp -= nextLevel;
    user.level += 1;
    user.coins += user.level * 200;
    return { levelUp: true, level: user.level };
  }
  await user.save();
  return { levelUp: false };
}

// ─── Tier Weights for Card Drops ─────────────────────────────────────────────
function rollTier() {
  const r = Math.random() * 100;
  if (r < 50) return 'C';
  if (r < 75) return 'B';
  if (r < 88) return 'A';
  if (r < 95) return 'S';
  if (r < 99) return 'SS';
  return 'SSS';
}

// ─── Tier Emoji ───────────────────────────────────────────────────────────────
function tierEmoji(tier) {
  return { C: '⚪', B: '🟢', A: '🔵', S: '🟡', SS: '🟠', SSS: '🔴' }[tier] || '⚪';
}

module.exports = { formatNum, formatCooldown, rand, pick, isAdmin, botIsAdmin, addXP, rollTier, tierEmoji };
