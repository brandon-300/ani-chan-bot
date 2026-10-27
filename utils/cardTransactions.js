const { transaction, BusinessError } = require('./transaction');
const { OwnedCard, CardCatalogue } = require('../models/Card');
const User = require('../models/User');
const { generateUniqueCode, cardValue } = require('./helpers');

const available = {
  isLent: { $ne: true },
  isStaked: { $ne: true },
  isForSale: { $ne: true },
  isAuctioned: { $ne: true },
};

function unownedSample(tier, session) {
  return CardCatalogue.aggregate([
    { $match: { tier, cardId: { $type: 'string' } } },
    {
      $lookup: {
        from: OwnedCard.collection.name,
        localField: 'cardId',
        foreignField: 'catalogueId',
        as: 'owned',
      },
    },
    { $match: { 'owned.0': { $exists: false } } },
    { $sample: { size: 1 } },
  ]).session(session);
}

async function fuseCards(userId, ids, targetTier, doubleTier, success, luckyRoll) {
  return transaction(async (session) => {
    const selected = await OwnedCard.find({
      _id: { $in: ids },
      ownerId: userId,
      ...available,
    }).session(session);
    if (selected.length !== 3 || !selected.every((c) => c.tier === selected[0].tier))
      throw new BusinessError(
        '❌ Fusion inputs changed or are no longer available. Nothing was consumed.'
      );
    const tiers = ['C', 'B', 'A', 'S', 'SS', 'SSS'];
    const tierIndex = tiers.indexOf(selected[0].tier);
    if (
      tierIndex < 0 ||
      tiers[tierIndex + 1] !== targetTier ||
      (doubleTier && tiers[tierIndex + 2] !== doubleTier)
    )
      throw new BusinessError('Fusion tier changed; nothing was consumed.');
    let [result] = await unownedSample(targetTier, session);
    if (!result)
      throw new BusinessError(
        '❌ No unclaimed target-tier card is available. Nothing was consumed.'
      );
    let lucky = false;
    if (success && luckyRoll && doubleTier) {
      const [higher] = await unownedSample(doubleTier, session);
      if (higher) {
        result = higher;
        lucky = true;
      }
    }
    const removed = await OwnedCard.deleteMany(
      { _id: { $in: ids }, ownerId: userId, ...available },
      { session }
    );
    if (removed.deletedCount !== 3)
      throw new BusinessError('❌ Fusion inputs changed. Nothing was consumed.');
    if (success) {
      await OwnedCard.create(
        [
          {
            ownerId: userId,
            catalogueId: result.cardId,
            code: await generateUniqueCode(OwnedCard),
            name: result.name,
            series: result.series,
            tier: result.tier,
            firstOwner: userId,
          },
        ],
        { session }
      );
    }
    return { resultCatalogue: result, lucky };
  });
}

async function resellCard(userId, cardId, price) {
  if (!Number.isSafeInteger(price) || price < 1) throw new BusinessError('Invalid resell price.');
  return transaction(async (session) => {
    const card = await OwnedCard.findOne({ _id: cardId, ownerId: userId, ...available }).session(
      session
    );
    if (!card || Math.floor(cardValue(card.tier) * 0.5) !== price)
      throw new BusinessError('Card value changed; nothing was sold.');
    const removed = await OwnedCard.deleteOne(
      { _id: cardId, ownerId: userId, ...available },
      { session }
    );
    if (removed.deletedCount !== 1)
      throw new BusinessError('❌ Card ownership or availability changed. Nothing was sold.');
    const paid = await User.updateOne(
      { id: userId, bank: { $lte: Number.MAX_SAFE_INTEGER - price } },
      { $inc: { bank: price } },
      { session }
    );
    if (paid.matchedCount !== 1)
      throw new BusinessError('❌ Account unavailable or bank limit exceeded. Your card was kept.');
  });
}
module.exports = { fuseCards, resellCard, unownedSample, available };
