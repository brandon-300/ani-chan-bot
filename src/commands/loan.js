const mongoose = require('mongoose');
const User = require('../models/User');
const { OwnedCard } = require('../models/Card');
const { formatNum, tierEmoji, cardValue, TIER_ORDER, parseAmount } = require('../utils/helpers');

// Thrown inside a mongoose session.withTransaction(...) callback purely to
// abort it with a specific, already-worded user-facing message attached —
// same pattern as commands/cards.js's TransactionAbort, duplicated locally
// rather than imported for the same reason getUserCards/getCardByIndex
// below are duplicated: keeps .loan self-contained. withTransaction()
// aborts the transaction and rethrows whatever the callback throws — the
// surrounding try/catch just below each transaction catches this specific
// type and replies with `.message` verbatim, instead of the generic
// "something went wrong" fallback used for a genuinely unexpected failure.
class TransactionAbort extends Error {}

// ─── Bank Vault ─────────────────────────────────────────────────────────────
// When a loan goes unpaid past its due date, the staked card is seized
// ("repossessed") rather than deleted — it's simply reassigned to this
// reserved ownerId so it stops appearing in the defaulting user's
// collection/.col but the card document itself isn't lost. This is a plain
// string, not a real WhatsApp id, so it can never collide with a real user
// and never receives messages.
const BANK_VAULT_ID = 'anichan-bank-vault';

// ─── Loan Brackets ──────────────────────────────────────────────────────────
// Ported 1:1 from the "Miyabi" bot's per-tier loan table. AniChan's card
// tiers (C/B/A/S/SS/SSS — see utils/helpers.js TIER_ORDER) are a 6-value
// scale, one short of Miyabi's 7 brackets (Tier 1-6 + Tier S), so nothing
// here is renamed or dropped: each bracket declares the minimum card tier
// needed to unlock it, and tiers unlock cumulatively (a higher card tier can
// always use any lower bracket too — .loan request picks the CHEAPEST
// bracket that still covers the requested amount). SSS is the only tier
// that unlocks both bracket 6 and bracket S, since it's AniChan's top card
// tier and Miyabi's table has two brackets above the 5th.
//
//   id    cap        interest   term       unlocked by
const LOAN_BRACKETS = [
  { id: '1', cap: 10_000,    interestPct: 5,  days: 1,  minTier: 'C' },
  { id: '2', cap: 25_000,    interestPct: 6,  days: 2,  minTier: 'B' },
  { id: '3', cap: 60_000,    interestPct: 8,  days: 3,  minTier: 'A' },
  { id: '4', cap: 150_000,   interestPct: 10, days: 7,  minTier: 'S' },
  { id: '5', cap: 350_000,   interestPct: 12, days: 10, minTier: 'SS' },
  { id: '6', cap: 800_000,   interestPct: 13, days: 12, minTier: 'SSS' },
  { id: 'S', cap: 1_500_000, interestPct: 15, days: 21, minTier: 'SSS' },
];

function bracketById(id) {
  return LOAN_BRACKETS.find(b => b.id === id) || null;
}

// Every bracket a card of this tier is allowed to borrow against, cheapest
// (lowest cap) first.
function eligibleBrackets(cardTier) {
  const rank = TIER_ORDER.indexOf(cardTier);
  if (rank === -1) return [];
  return LOAN_BRACKETS
    .filter(b => TIER_ORDER.indexOf(b.minTier) <= rank)
    .sort((a, b) => a.cap - b.cap);
}

// The cheapest bracket that still covers `amount`, or null if the card's
// tier can't reach that high at all.
function pickBracket(cardTier, amount) {
  const eligible = eligibleBrackets(cardTier);
  return eligible.find(b => b.cap >= amount) || null;
}

function maxLoanFor(cardTier) {
  const eligible = eligibleBrackets(cardTier);
  return eligible.length ? eligible[eligible.length - 1].cap : 0;
}

// ─── Card lookup (mirrors commands/cards.js's private getUserCards/
// getCardByIndex exactly, including sort order) ─────────────────────────────
// Duplicated locally rather than importing from cards.js because those two
// helpers aren't exported there (cards.js only exports actual .command
// functions) — this keeps .loan self-contained and avoids touching a
// 1,400+ line file just to add an export. If cards.js's sort order ever
// changes, this needs to change with it to keep card indices consistent
// with what .col shows.
async function getUserCards(userId) {
  const cards = await OwnedCard.find({ ownerId: userId });
  return cards.sort((a, b) => cardValue(a.tier) - cardValue(b.tier) || a.name.localeCompare(b.name));
}

async function getCardByIndex(userId, index) {
  const cards = await getUserCards(userId);
  return cards[index - 1] || null;
}

// ─── Time formatting ────────────────────────────────────────────────────────
// Loan terms run 1-21 days, so unlike utils/helpers.js's formatCooldown
// (hours/min/sec, built for short command cooldowns) this needs a
// days-aware version for .loan status / due-date messages.
function formatDuration(ms) {
  if (ms <= 0) return '0h';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || !d) parts.push(`${h}h`);
  return parts.join(' ');
}

// A blank loan object, shared by both the default-seizure and repay paths
// below so the "cleared" shape is defined in exactly one place.
function clearedLoan() {
  return {
    active: false,
    bracket: null,
    principal: 0,
    interest: 0,
    totalOwed: 0,
    cardId: null,
    cardName: null,
    cardTier: null,
    issuedAt: null,
    dueAt: null,
  };
}

// ─── Auto-default check ─────────────────────────────────────────────────────
// Called at the top of every .loan subcommand. If the user has an active
// loan that's past its due date, this seizes the staked card to the bank
// vault, clears the loan, and returns a message describing what happened.
// Returns null if there's nothing to resolve (no active loan, one that's
// still within its term, or a seizure attempt that failed and was left
// active/overdue for the next retry) — callers proceed normally in that
// case.
//
// The card seizure and the loan clearing now happen in one transaction —
// previously the seizure was a swallowed .catch(), and the loan was
// cleared and saved regardless of whether it succeeded. A transient
// failure there meant the debt simply vanished while the card was never
// actually transferred to the vault and never had isStaked cleared either
// — permanently stuck (staked forever, with no loan left to repay against
// it, and no way to seize it again since the loan record was already
// gone). Now both commit together or neither does.
//
// Deliberately builds the cleared loan into a local variable and only
// assigns it to `user.loan` AFTER the transaction is confirmed committed —
// mutating `user.loan` (the caller's in-memory document) any earlier would
// leave it wrongly showing "cleared" if the transaction then aborted,
// even though nothing was actually saved.
async function resolveOverdueIfNeeded(user) {
  if (!user.loan?.active || !user.loan.dueAt) return null;
  if (Date.now() <= user.loan.dueAt) return null;

  const seizedCardName = user.loan.cardName || 'your staked card';
  const seizedCardTier = user.loan.cardTier || '';
  const owedAtDefault = user.loan.totalOwed;
  const cardId = user.loan.cardId;
  const newLoan = clearedLoan();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (cardId) {
        await OwnedCard.updateOne(
          { _id: cardId },
          { $set: { ownerId: BANK_VAULT_ID, isStaked: false } },
          { session }
        );
      }
      await User.updateOne(
        { _id: user._id },
        { $set: { loan: newLoan } },
        { session }
      );
    });
  } catch (err) {
    console.error('loan default: seizure transaction failed — loan left active/overdue for retry:', err.message);
    return null;
  } finally {
    await session.endSession();
  }

  // Only reaches here once both writes above are confirmed committed —
  // now safe to reflect the change on the in-memory object the caller
  // holds, so its own subsequent checks (e.g. "already have an active
  // loan?") see the update.
  user.loan = newLoan;

  return (
    `⚠️ *Loan Defaulted*\n\n` +
    `Your loan of 💰 ${formatNum(owedAtDefault)} coins went unpaid past its due date.\n` +
    `🏦 The bank has repossessed your staked card: ${tierEmoji(seizedCardTier)} *${seizedCardName}* [${seizedCardTier}].\n\n` +
    `Your slate is now clean — you can .loan request a new loan whenever you're ready.`
  );
}

function usageText() {
  const lines = LOAN_BRACKETS.map(b =>
    `${tierEmoji(b.minTier)} *${b.minTier === 'SSS' && b.id !== '6' ? 'SSS (large)' : b.minTier}*: up to ${formatNum(b.cap)} | ${b.interestPct}% interest over ${b.days} day${b.days > 1 ? 's' : ''}`
  ).join('\n');

  return (
    `💸 *Loan Command Usage*\n` +
    `• *.loan request <amount> <card index>* — Request a loan.\n` +
    `• *.loan repay* — Repay your current loan.\n` +
    `• *.loan status* — Check your active loan details.\n\n` +
    `🔒 You need to stake a card of the matching tier to request up to its maximum loan amount. Card index comes from *.col*. Amount supports shorthand: 10k, 1.5m, etc.\n\n` +
    `*Per-Tier Maximums*\n${lines}`
  );
}

module.exports = {
  // .loan request|repay|status — see usageText() above for the full help
  // text shown when no valid subcommand is given.
  async loan(client, msg, args) {
    const sub = (args[0] || '').toLowerCase();
    const contact = await msg.getContact();
    const userId = contact.id._serialized;
    const user = await User.findOrCreate(userId, contact.pushname);

    // ── .loan request <amount> <card index> ──────────────────────────────
    if (sub === 'request') {
      const overdueMsg = await resolveOverdueIfNeeded(user);

      const amount = parseAmount(args[1]);
      const cardIndex = parseInt(args[2]);
      if (!amount || amount < 1 || !cardIndex || cardIndex < 1) {
        return msg.reply(
          (overdueMsg ? overdueMsg + '\n\n' : '') +
          '❌ Usage: .loan request <amount> <card index>\nAmount supports shorthand: 10k, 1.5m, etc. Card index comes from *.col*.'
        );
      }

      if (user.loan?.active) {
        return msg.reply(
          `❌ You already have an active loan of 💰 ${formatNum(user.loan.totalOwed)} coins.\nRepay it first with *.loan repay*, or check *.loan status*.`
        );
      }

      const card = await getCardByIndex(userId, cardIndex);
      if (!card) {
        return msg.reply((overdueMsg ? overdueMsg + '\n\n' : '') + '❌ Card not found at that index — check *.col* for your current card list.');
      }
      if (card.isStaked) return msg.reply('❌ That card is already staked on another loan.');
      if (card.isLent) return msg.reply('❌ That card is currently lent out — get it back before staking it.');
      if (card.isForSale) return msg.reply('❌ That card is currently listed in the shop — remove it with *.rc* first.');

      const bracket = pickBracket(card.tier, amount);
      if (!bracket) {
        const max = maxLoanFor(card.tier);
        return msg.reply(
          `❌ A ${tierEmoji(card.tier)} *${card.tier}* card can only secure loans up to 💰 ${formatNum(max)} coins. Stake a higher-tier card for more.`
        );
      }

      const interest = Math.ceil(amount * bracket.interestPct / 100);
      const totalOwed = amount + interest;
      const issuedAt = Date.now();
      const dueAt = issuedAt + bracket.days * 86_400_000;

      // ─── Transaction: stake the card AND record the loan together ──────
      // Previously these were two independent Promise.all saves — one
      // succeeding while the other failed could lock a card as staked
      // with no loan ever recorded against it (permanently stuck, no
      // coins credited), or record the loan without ever actually marking
      // the card staked (letting it be freely sold/traded/lent while
      // still "securing" an active loan). Re-checks the card's flags and
      // the user's loan status again fresh inside the transaction, same
      // reasoning as everywhere else in this pass — the reads above can
      // be stale by the time this actually runs. Uses atomic update
      // operators ($set/$inc) rather than loading-then-.save()-ing full
      // documents, so nothing here mutates `card`/`user` until the
      // transaction is confirmed committed, below.
      let newLoan;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const [freshCard, freshUser] = await Promise.all([
            OwnedCard.findById(card._id).session(session),
            User.findOne({ id: userId }).session(session),
          ]);

          if (!freshCard || freshCard.isStaked || freshCard.isLent || freshCard.isForSale) {
            throw new TransactionAbort('❌ That card is no longer available to stake — check *.col* and try again.');
          }
          if (freshUser?.loan?.active) {
            throw new TransactionAbort(`❌ You already have an active loan of 💰 ${formatNum(freshUser.loan.totalOwed)} coins.\nRepay it first with *.loan repay*, or check *.loan status*.`);
          }

          newLoan = {
            active: true,
            bracket: bracket.id,
            principal: amount,
            interest,
            totalOwed,
            cardId: freshCard._id.toString(),
            cardName: freshCard.name,
            cardTier: freshCard.tier,
            issuedAt,
            dueAt,
          };

          await Promise.all([
            OwnedCard.updateOne({ _id: freshCard._id }, { $set: { isStaked: true } }, { session }),
            User.updateOne({ _id: freshUser._id }, { $set: { loan: newLoan }, $inc: { bank: amount } }, { session }),
          ]);
        });
      } catch (err) {
        if (err instanceof TransactionAbort) return msg.reply(err.message);
        console.error('loan request: transaction failed:', err.message);
        return msg.reply('⚠️ Something went wrong setting up that loan — nothing was staked or credited. Please try again.');
      } finally {
        await session.endSession();
      }

      // Only reaches here once everything above is confirmed committed.
      card.isStaked = true;
      user.loan = newLoan;
      user.bank += amount;

      return msg.reply(
        (overdueMsg ? overdueMsg + '\n\n' : '') +
        `🏦 *Loan Approved!*\n\n` +
        `Staked collateral: ${tierEmoji(card.tier)} *${card.name}* [${card.tier}]\n` +
        `💰 Principal: ${formatNum(amount)} coins\n` +
        `📈 Interest: ${bracket.interestPct}% (${formatNum(interest)} coins)\n` +
        `💳 Total owed: ${formatNum(totalOwed)} coins\n` +
        `⏳ Due in: ${bracket.days} day${bracket.days > 1 ? 's' : ''}\n\n` +
        `✅ ${formatNum(amount)} coins deposited directly to your 🏦 bank.\nBank balance: ${formatNum(user.bank)} coins\n\n` +
        `Repay anytime with *.loan repay* — miss the due date and the bank keeps your card.`
      );
    }

    // ── .loan repay ────────────────────────────────────────────────────────
    if (sub === 'repay') {
      const overdueMsg = await resolveOverdueIfNeeded(user);
      if (overdueMsg) return msg.reply(overdueMsg);

      if (!user.loan?.active) return msg.reply('❌ You have no active loan to repay.');

      const owed = user.loan.totalOwed;
      const available = user.bank + user.coins;
      if (available < owed) {
        return msg.reply(
          `❌ Not enough to repay. You owe 💰 ${formatNum(owed)} coins.\n` +
          `🏦 Bank: ${formatNum(user.bank)} | 💰 Wallet: ${formatNum(user.coins)}\n` +
          `You need ${formatNum(owed - available)} more coins.`
        );
      }

      const { cardName, cardTier } = user.loan;

      // ─── Transaction: pay off the loan AND unstake the card together ───
      // Previously the unstake update was a swallowed .catch() — the
      // money was already deducted and the loan already cleared
      // regardless of whether it succeeded. A transient failure there
      // meant the user was charged in full and owed nothing anymore, but
      // their card stayed isStaked forever with no loan left to repay
      // against it — permanently stuck. Now the payment and the unstake
      // commit together or not at all; a failure here leaves the loan
      // exactly as it was (still active, still owed), safe to retry. Also
      // re-checks the balance fresh inside the transaction, same
      // reasoning as everywhere else in this pass.
      let finalBank, finalCoins;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const freshUser = await User.findOne({ id: userId }).session(session);
          if (!freshUser?.loan?.active) {
            throw new TransactionAbort('❌ You have no active loan to repay.');
          }

          const freshOwed = freshUser.loan.totalOwed;
          const freshAvailable = freshUser.bank + freshUser.coins;
          if (freshAvailable < freshOwed) {
            throw new TransactionAbort(
              `❌ Not enough to repay. You owe 💰 ${formatNum(freshOwed)} coins.\n` +
              `🏦 Bank: ${formatNum(freshUser.bank)} | 💰 Wallet: ${formatNum(freshUser.coins)}\n` +
              `You need ${formatNum(freshOwed - freshAvailable)} more coins.`
            );
          }

          const fromBank = Math.min(freshUser.bank, freshOwed);
          const fromWallet = freshOwed - fromBank;

          if (freshUser.loan.cardId) {
            await OwnedCard.updateOne(
              { _id: freshUser.loan.cardId },
              { $set: { isStaked: false } },
              { session }
            );
          }
          await User.updateOne(
            { _id: freshUser._id },
            { $set: { loan: clearedLoan() }, $inc: { bank: -fromBank, coins: -fromWallet } },
            { session }
          );

          finalBank = freshUser.bank - fromBank;
          finalCoins = freshUser.coins - fromWallet;
        });
      } catch (err) {
        if (err instanceof TransactionAbort) return msg.reply(err.message);
        console.error('loan repay: transaction failed:', err.message);
        return msg.reply('⚠️ Something went wrong repaying that loan — you were not charged. Please try again.');
      } finally {
        await session.endSession();
      }

      return msg.reply(
        `✅ *Loan Repaid!*\n\n` +
        `💳 Paid off: ${formatNum(owed)} coins\n` +
        `🔓 ${tierEmoji(cardTier)} *${cardName}* [${cardTier}] is no longer staked.\n\n` +
        `🏦 Bank: ${formatNum(finalBank)} | 💰 Wallet: ${formatNum(finalCoins)}`
      );
    }

    // ── .loan status ────────────────────────────────────────────────────────
    if (sub === 'status') {
      const overdueMsg = await resolveOverdueIfNeeded(user);
      if (overdueMsg) return msg.reply(overdueMsg);

      if (!user.loan?.active) return msg.reply('📭 You have no active loan.\nUse *.loan request <amount> <card index>* to take one out.');

      const l = user.loan;
      const bracket = bracketById(l.bracket);
      const remaining = l.dueAt - Date.now();

      return msg.reply(
        `🏦 *Your Active Loan*\n\n` +
        `Collateral: ${tierEmoji(l.cardTier)} *${l.cardName}* [${l.cardTier}]\n` +
        `💰 Principal: ${formatNum(l.principal)} coins\n` +
        `📈 Interest: ${bracket ? bracket.interestPct + '%' : ''} (${formatNum(l.interest)} coins)\n` +
        `💳 Total owed: ${formatNum(l.totalOwed)} coins\n` +
        `⏳ Time remaining: ${formatDuration(remaining)}\n\n` +
        `Repay with *.loan repay* before it's due, or the bank keeps your card.`
      );
    }

    // ── No/unknown subcommand — show usage ──────────────────────────────────
    return msg.reply(usageText());
  },
};
