const mongoose = require('mongoose');

// ─── Master Card Catalogue ────────────────────────────────────────────────────
const CardCatalogueSchema = new mongoose.Schema({
  name: { type: String, required: true },
  series: { type: String, required: true },
  tier: {
    type: String,
    enum: ['C', 'B', 'A', 'S', 'SS', 'SSS'],
    default: 'C'
  },
  imageUrl: { type: String, default: '' },
  description: { type: String, default: '' },
});

// ─── User-Owned Card Instance ─────────────────────────────────────────────────
const OwnedCardSchema = new mongoose.Schema({
  ownerId: { type: String, required: true },
  catalogueId: { type: mongoose.Schema.Types.ObjectId, ref: 'CardCatalogue', required: true },
  name: String,
  series: String,
  tier: String,
  index: { type: Number },            // user's personal card index
  isForSale: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  isLent: { type: Boolean, default: false },
  lentTo: { type: String, default: null },
  obtainedAt: { type: Date, default: Date.now },
});

// ─── Auction ──────────────────────────────────────────────────────────────────
const AuctionSchema = new mongoose.Schema({
  sellerId: { type: String, required: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnedCard' },
  cardName: String,
  cardTier: String,
  startPrice: { type: Number, required: true },
  currentBid: { type: Number, default: 0 },
  currentBidder: { type: String, default: null },
  endsAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
});

module.exports = {
  CardCatalogue: mongoose.model('CardCatalogue', CardCatalogueSchema),
  OwnedCard: mongoose.model('OwnedCard', OwnedCardSchema),
  Auction: mongoose.model('Auction', AuctionSchema),
};
