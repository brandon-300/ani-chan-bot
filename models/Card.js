const mongoose = require('mongoose');

// ─── Master Card Catalogue ────────────────────────────────────────────────────
const CardCatalogueSchema = new mongoose.Schema({
  cardId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },

  anilistId: {
    type: Number,
    unique: true,
    sparse: true
  },

  malId: {
    type: Number,
    unique: true,
    sparse: true
  },

  name: { type: String, required: true },
  series: { type: String, required: true },

  tier: {
    type: String,
    enum: ['C', 'B', 'A', 'S', 'SS', 'SSS'],
    default: 'C'
  },

  imageUrl: { type: String, default: '' },
  imagePath: { type: String, default: '' },
  description: { type: String, default: '' },
  value: { type: Number, default: 0 },
}, { timestamps: true });

// ─── User-Owned Card Instance ─────────────────────────────────────────────────
const OwnedCardSchema = new mongoose.Schema({
catalogueId: {
    type: String,
    ref: 'CardCatalogue'
},
  code: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  name: String,
  series: String,
  tier: String,
  index: { type: Number },            // user's personal card index
  isForSale: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  isLent: { type: Boolean, default: false },
  lentTo: { type: String, default: null },
  obtainedAt: { type: Date, default: Date.now },
  firstOwner: { type: String, default: null },
  timesTraded: { type: Number, default: 0 },
});

// ─── Auction ──────────────────────────────────────────────────────────────────
const AuctionSchema = new mongoose.Schema({
  sellerId: { type: String, required: true },
  code: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnedCard' },
  cardName: String,
  cardTier: String,
  startPrice: { type: Number, required: true },
  currentBid: { type: Number, default: 0 },
  currentBidder: { type: String, default: null },
  endsAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
});

// ─── Trade Request (Phase 6: safe trading) ───────────────────────────────────
// A proposed trade sits here until the partner accepts or declines — nothing
// changes ownership until then. Scoped to the group it was proposed in, so
// .accepttrade/.declinetrade always target the right offer.
const TradeRequestSchema = new mongoose.Schema({
  groupId: { type: String, required: true },
  initiatorId: { type: String, required: true },
  partnerId: { type: String, required: true },
  initiatorCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnedCard', required: true },
  partnerCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnedCard', required: true },
}, { timestamps: true });

module.exports = {
  CardCatalogue: mongoose.model('CardCatalogue', CardCatalogueSchema),
  OwnedCard: mongoose.model('OwnedCard', OwnedCardSchema),
  Auction: mongoose.model('Auction', AuctionSchema),
  TradeRequest: mongoose.model('TradeRequest', TradeRequestSchema),
};
