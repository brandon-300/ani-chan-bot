const { Auction, OwnedCard } = require('../models/Card');
const User = require('../models/User');
const { transaction, BusinessError } = require('./transaction');
const { available } = require('./cardTransactions');
const { generateUniqueCode } = require('./helpers');
const scheduler = require('./scheduler');
const logger = require('./logger');

function durationMs(text = '1h') {
  const match = /^(\d+)(m|h)$/i.exec(text);
  const value = match ? Number(match[1]) * (match[2].toLowerCase() === 'h' ? 3600000 : 60000) : 0;
  if (!Number.isSafeInteger(value) || value < 300000 || value > 86400000)
    throw new BusinessError('❌ Auction duration must be from 5m to 24h.');
  return value;
}
async function bankChange(id, amount, session) {
  const result = await User.updateOne(
    {
      id,
      bank: { $gte: Math.max(0, -amount), $lte: Number.MAX_SAFE_INTEGER - Math.max(0, amount) },
    },
    { $inc: { bank: amount } },
    { session }
  );
  if (result.matchedCount !== 1)
    throw new BusinessError(
      '❌ Bank funds unavailable or bank limit exceeded. Nothing was transferred.'
    );
}
async function arm(auction) {
  await scheduler.scheduleIfMissing({
    type: 'auction_end',
    key: `auction:${auction._id}`,
    runAt: auction.endsAt,
    payload: { auctionId: String(auction._id) },
  });
}
async function createAuction(sellerId, cardId, startPrice, duration, chatId) {
  if (!Number.isSafeInteger(startPrice) || startPrice < 1)
    throw new BusinessError('❌ Enter a positive auction starting price.');
  const endsAt = new Date(Date.now() + durationMs(duration));
  await Auction.init();
  const auction = await transaction(async (session) => {
    if (!(await User.exists({ id: sellerId }).session(session)))
      throw new BusinessError('❌ Seller account unavailable.');
    const card = await OwnedCard.findOne({ _id: cardId, ownerId: sellerId, ...available }).session(
      session
    );
    if (!card) throw new BusinessError('❌ This card is not available to auction.');
    const locked = await OwnedCard.updateOne(
      { _id: cardId, ownerId: sellerId, ...available },
      { $set: { isAuctioned: true } },
      { session }
    );
    if (locked.matchedCount !== 1) throw new BusinessError('❌ Card availability changed.');
    const [created] = await Auction.create(
      [
        {
          code: await generateUniqueCode(Auction),
          sellerId,
          cardId,
          cardName: card.name,
          cardTier: card.tier,
          startPrice,
          endsAt,
          chatId,
        },
      ],
      { session }
    );
    return created;
  });
  await arm(auction).catch((err) => logger.error('auction.schedule.failed', err));
  return auction;
}
async function bid(code, bidderId, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new BusinessError('❌ Enter a positive, safe bid.');
  return transaction(async (session) => {
    const auction = await Auction.findOne({
      code,
      isActive: true,
      endsAt: { $gt: new Date() },
    }).session(session);
    if (!auction) throw new BusinessError('❌ Auction not found or ended.');
    if (auction.sellerId === bidderId)
      throw new BusinessError('❌ Sellers cannot bid on their own auction.');
    const card = await OwnedCard.findOne({
      _id: auction.cardId,
      ownerId: auction.sellerId,
      isAuctioned: true,
    }).session(session);
    if (!card || (auction.currentBidder && !auction.escrowed))
      throw new BusinessError('❌ This legacy auction cannot accept bids.');
    const minimum = auction.currentBidder ? auction.currentBid + 1 : auction.startPrice;
    if (amount < minimum) throw new BusinessError(`❌ Minimum bid: ${minimum} bank coins.`);
    const ownRaise = auction.currentBidder === bidderId;
    await bankChange(bidderId, -(ownRaise ? amount - auction.currentBid : amount), session);
    if (auction.currentBidder && !ownRaise)
      await bankChange(auction.currentBidder, auction.currentBid, session);
    auction.currentBid = amount;
    auction.currentBidder = bidderId;
    auction.escrowed = true;
    await auction.save({ session });
    return auction;
  });
}
async function cancel(code, sellerId) {
  return transaction(async (session) => {
    const auction = await Auction.findOne({ code, sellerId, isActive: true }).session(session);
    if (!auction) throw new BusinessError('❌ Auction not found.');
    if (auction.currentBidder)
      throw new BusinessError('❌ An auction with a bid cannot be cancelled.');
    await OwnedCard.updateOne(
      { _id: auction.cardId, ownerId: sellerId },
      { $set: { isAuctioned: false } },
      { session, auctionMutation: true }
    );
    auction.isActive = false;
    auction.settledAt = new Date();
    auction.outcome = 'cancelled';
    await auction.save({ session });
    return auction;
  });
}
async function settle(auctionId) {
  return transaction(async (session) => {
    const auction = await Auction.findOne({
      _id: auctionId,
      isActive: true,
      endsAt: { $lte: new Date() },
    }).session(session);
    if (!auction) return null;
    const card = await OwnedCard.findOne({
      _id: auction.cardId,
      ownerId: auction.sellerId,
      isAuctioned: true,
    }).session(session);
    if (auction.currentBidder && auction.escrowed) {
      if (card) {
        await bankChange(auction.sellerId, auction.currentBid, session);
        const moved = await OwnedCard.updateOne(
          { _id: card._id, ownerId: auction.sellerId, isAuctioned: true },
          {
            $set: { ownerId: auction.currentBidder, isAuctioned: false },
            $inc: { timesTraded: 1 },
          },
          { session, auctionMutation: true }
        );
        if (moved.matchedCount !== 1)
          throw new BusinessError('Auction card changed during settlement.');
        auction.outcome = 'sold';
      } else {
        await bankChange(auction.currentBidder, auction.currentBid, session);
        auction.outcome = 'refunded';
      }
    } else {
      if (card)
        await OwnedCard.updateOne(
          { _id: card._id },
          { $set: { isAuctioned: false } },
          { session, auctionMutation: true }
        );
      // Legacy bids never reserved money in this version. Do not mint refunds.
      auction.outcome = 'no-sale';
    }
    auction.escrowed = false;
    auction.isActive = false;
    auction.settledAt = new Date();
    await auction.save({ session });
    return auction;
  });
}
async function reconcile() {
  for (const auction of await Auction.find({ isActive: true })) {
    try {
      await arm(auction);
    } catch (err) {
      logger.error('auction.reconcile.failed', err, { code: auction.code });
    }
  }
}
scheduler.registerHandler('auction_end', async ({ auctionId }, client) => {
  const auction = await settle(auctionId);
  if (!auction || !auction.chatId || !client) return;
  await client
    .sendMessage(
      auction.chatId,
      `🔨 Auction ${auction.code} ended: ${auction.cardName} — ${auction.outcome}${auction.outcome === 'sold' ? ` for ${auction.currentBid} bank coins` : ''}.`
    )
    .catch((err) => logger.error('auction.notice.failed', err));
});
module.exports = { createAuction, bid, cancel, settle, reconcile, durationMs };
