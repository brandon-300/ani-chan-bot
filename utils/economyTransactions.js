'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Receipt = require('../models/EconomyReceipt');
const { CardCatalogue, OwnedCard } = require('../models/Card');
const { generateUniqueCode } = require('./helpers');

class EconomyError extends Error {}

async function donateCoins({ senderId, receiverId, amount, messageId }) {
  if (!senderId || !receiverId || senderId === receiverId) throw new EconomyError('❌ You cannot donate to yourself.');
  if (!Number.isSafeInteger(amount) || amount < 1) throw new EconomyError('❌ Enter a positive, safe whole amount.');
  if (!messageId) throw new EconomyError('❌ Cannot verify this message. No transfer was made.');
  await Receipt.init();
  const receiptId = `donate:${senderId}:${messageId}`;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const previous = await Receipt.findById(receiptId).session(session);
      if (previous) {
        if (previous.receiverId !== receiverId || previous.amount !== amount) throw new EconomyError('❌ This message was already used for a different transfer.');
        return;
      }
      await Receipt.create([{ _id: receiptId, senderId, receiverId, amount }], { session });
      const debited = await User.updateOne({ id: senderId, coins: { $gte: amount } }, { $inc: { coins: -amount } }, { session });
      if (debited.matchedCount !== 1) throw new EconomyError('❌ Not enough coins.');
      const credited = await User.updateOne({ id: receiverId, coins: { $lte: Number.MAX_SAFE_INTEGER - amount } }, { $inc: { coins: amount } }, { session });
      if (credited.matchedCount !== 1) throw new EconomyError('❌ Recipient unavailable or wallet limit exceeded. No coins were transferred.');
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const previous = await Receipt.findById(receiptId);
    if (!previous || previous.receiverId !== receiverId || previous.amount !== amount) throw err;
  } finally {
    await session.endSession();
  }
}

async function openCardPack(userId) {
  // Concurrent claims can take a sampled card after the snapshot was read.
  // Retry only duplicate-key conflicts, with a fresh transaction and sample.
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await mongoose.startSession();
    try {
      let gained;
      await session.withTransaction(async () => {
        const user = await User.findOne({ id: userId }).session(session);
        const index = user?.inventory?.indexOf('Card Pack') ?? -1;
        if (index < 0) throw new EconomyError('❌ Card Pack not in inventory.');
        const picks = await CardCatalogue.aggregate([
          { $lookup: { from: OwnedCard.collection.name, localField: 'cardId', foreignField: 'catalogueId', as: 'owned' } },
          { $match: { cardId: { $type: 'string' }, 'owned.0': { $exists: false } } },
          { $sample: { size: 3 } },
        ]).session(session);
        if (picks.length !== 3) throw new EconomyError('❌ Fewer than 3 unclaimed cards are available. Your Card Pack was kept.');
        gained = [];
        for (const card of picks) {
          const [owned] = await OwnedCard.create([{
            ownerId: userId, catalogueId: card.cardId,
            code: await generateUniqueCode(OwnedCard),
            name: card.name, series: card.series, tier: card.tier,
            firstOwner: userId,
          }], { session });
          gained.push(owned);
        }
        user.inventory.splice(index, 1);
        await user.save({ session });
      });
      return gained;
    } catch (err) {
      if (err.code !== 11000 || attempt === 2) throw err;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = { donateCoins, openCardPack, EconomyError };
