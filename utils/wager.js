'use strict';

const User = require('../models/User');

// Reject partial parses, fractions and unsafe arithmetic before rolling.
function parseWager(input, fallback, minimum = 1, maxMultiplier = 1) {
  const text = input === undefined ? String(fallback ?? '') : String(input).trim();
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount >= minimum
    && amount <= Math.floor(Number.MAX_SAFE_INTEGER / maxMultiplier) ? amount : null;
}

// One guarded net settlement: concurrent bets cannot spend a stale balance,
// and a positive payout cannot overflow the wallet's safe integer range.
async function settleWager(userId, stake, gain) {
  if (!Number.isSafeInteger(stake) || stake < 1 || !Number.isSafeInteger(gain) || gain < -stake) {
    throw new Error('Invalid wager settlement');
  }
  return User.findOneAndUpdate({
    id: userId,
    coins: { $gte: stake, $lte: Number.MAX_SAFE_INTEGER - Math.max(0, gain) },
  }, { $inc: { coins: gain } }, { new: true });
}

module.exports = { parseWager, settleWager };
