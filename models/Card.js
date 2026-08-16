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
  // BUGFIX (Aug 2026): this field was completely absent from the schema even
  // though every command in commands/cards.js (.claim, .sc, .tc/accepttrade,
  // shop purchases) and commands/economy.js (.use "Card Pack") reads and
  // writes it. Mongoose's default `strict: true` behavior silently drops any
  // field that isn't declared here on .create()/.save() — so ownerId was
  // NEVER actually being persisted to MongoDB. Adding it here is what
  // actually makes ownership persist.
  ownerId: {
    type: String,
    index: true
  },
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
  // Set true while this card is staked as collateral on an active bank loan
  // (commands/loan.js, .loan request). Mirrors the isLent flag's pattern —
  // prevents the SAME card from being staked into a second loan at once.
  // Cleared back to false on .loan repay, or when the loan is auto-defaulted
  // (overdue) and the card is seized to the bank vault — see BANK_VAULT_ID
  // in commands/loan.js.
  isStaked: { type: Boolean, default: false },
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

// ─── Catalogue Auto-Growth State ──────────────────────────────────────────────
// Singleton doc (always _id: 'singleton') tracking the background AniList
// discovery job — see runDiscoveryBatch()/_initCatalogueGrowth() in
// commands/cardmanager.js and the .autoexpand command. `page` is the AniList
// Page cursor to resume from next run, so repeated runs work through
// progressively less-popular anime over time instead of re-scanning the same
// top titles forever (already-seen characters get skipped via anilistId
// dedup either way, but advancing the cursor gets to new ones faster).
const CatalogueGrowthStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  enabled: { type: Boolean, default: false },
  page: { type: Number, default: 1 },
  totalAdded: { type: Number, default: 0 },
  lastRunAt: { type: Date, default: null },
  lastError: { type: String, default: null },
});

module.exports = {
  CardCatalogue: mongoose.model('CardCatalogue', CardCatalogueSchema),
  OwnedCard: mongoose.model('OwnedCard', OwnedCardSchema),
  Auction: mongoose.model('Auction', AuctionSchema),
  TradeRequest: mongoose.model('TradeRequest', TradeRequestSchema),
  CatalogueGrowthState: mongoose.model('CatalogueGrowthState', CatalogueGrowthStateSchema),
};
