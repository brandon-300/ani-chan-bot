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

  // Alternate names .ci's search should also match — populated when
  // renameCardsWithGemini.js corrects `name` to a full/formal form that no
  // longer contains the old value as a substring (e.g. "Kirito" ->
  // "Kazuto Kirigaya" — the nickname isn't a substring of the real name,
  // so a plain regex search on `name` alone stops finding it once
  // renamed). See commands/cards.js's .ci for how this is used, and
  // backfillAliasesFromRenameLog.js for retrofitting aliases onto cards
  // that were renamed before this field existed.
  aliases: { type: [String], default: [] },

  tier: {
    type: String,
    enum: ['C', 'B', 'A', 'S', 'SS', 'SSS'],
    default: 'C'
  },

  imageUrl: { type: String, default: '' },
  imagePath: { type: String, default: '' },
  description: { type: String, default: '' },
  value: { type: Number, default: 0 },

  // Which service imageUrl currently points at — 'anilist' (the original
  // pipeline, commands/cardmanager.js's createCardFromAniList/
  // .backfillimages), 'danbooru'/'gelbooru'/'safebooru' (.upgradeimages,
  // utils/danbooru.js), or 'google_image_search' (repairCardImages.js).
  // Exists purely so a later spot-check can find what changed:
  // db.cardcatalogues.find({ imageSource: 'danbooru' }) in mongosh, or
  // filter on it from a future review command — .upgradeimages applies its
  // best guess automatically (no per-card confirmation), so this is what
  // makes "I'll check it after the fact" actually practical instead of
  // having to remember/diff which 300 cards changed.
  //
  // BUGFIX: 'safebooru' was missing from this enum even though
  // utils/danbooru.js's findCharacterArtwork() can return
  // { source: 'safebooru', ... } and commands/cardmanager.js's
  // .upgradeimages writes that straight into this field. Mongoose enum
  // validation runs on doc.save() and rejects any value not listed here —
  // so every card that matched via the Safebooru fallback was silently
  // failing to save, landing in .upgradeimages' "skipped/no match" list
  // even though a match WAS found (the save() threw inside that command's
  // try/catch, which logs it as a generic lookup failure with no obvious
  // sign it was actually this). Added here, plus 'google_image_search' for
  // repairCardImages.js's new pipeline.
  imageSource: { type: String, enum: ['anilist', 'danbooru', 'gelbooru', 'safebooru', 'google_image_search'], default: 'anilist' },

  // The exact post ID on whichever site imageSource points to (Danbooru's
  // or Gelbooru's own numeric post ID, not our cardId). ADDED Aug 2026
  // specifically for .upgradeimages retry: findCharacterArtwork() is
  // deterministic — the same name always finds the same top-ranked post —
  // so without remembering exactly which post was already tried, a retry
  // on a technically-valid-but-disliked match (e.g. an oddly stylized
  // Inuyasha) would just return the identical picture again. Passing this
  // back in as excludePostId lets retry actually surface the next-best
  // candidate instead. Left null for google_image_search cards — there's
  // no equivalent "post id" concept there, see imageSourceUrl instead.
  sourcePostId: { type: String, default: null },

  // ─── Image-repair provenance (repairCardImages.js) ─────────────────────
  // Populated only once a card has gone through the Google Image Search +
  // Gemini Vision repair pipeline (imageSource === 'google_image_search').
  // Every field defaults to null and nothing else in the codebase reads
  // them, so adding this block is purely additive — it can't affect
  // .upgradeimages, .backfillimages, .editcard, or the renderer.
  imageSourceUrl: { type: String, default: null }, // the page the image was found on (Custom Search's image.contextLink)
  imageSourceTitle: { type: String, default: null }, // that page/result's title — lets a human spot-check without re-searching
  imageQualityScore: { type: Number, default: null }, // repairCardImages.js's own 0-100 domain+resolution+text-match+vision score
  imageConfidence: { type: Number, default: null }, // Gemini Vision's own 0-1 confidence, when a vision check ran
  imageHash: { type: String, default: null }, // sha256 of the stored image bytes — flags the same picture reused across cards later
  imageVerifiedAt: { type: Date, default: null },
  imageReviewStatus: {
    type: String,
    enum: ['verified', 'needs_review', 'failed'],
    default: null, // null = never touched by repairCardImages.js — distinct from having been checked and cleared
  },

  // ─── Rendered card cache (utils/cardRenderer.js) ───────────────────────────
  // The custom trading-card PNG is expensive to (re)build — a Puppeteer
  // page render plus hair-color extraction — so it's cached here rather
  // than regenerated on every view/drop/claim. Lives on the CATALOGUE entry
  // (not OwnedCard) because the artwork and derived color theme are the
  // same for every owner of a given card; only ownership/trade history
  // differs per OwnedCard instance.
  //
  // renderVersion is compared against CARD_RENDER_VERSION (the one source
  // of truth for the visual design, defined in utils/cardRenderer.js) to
  // decide cache hit vs. miss — a version bump there invalidates every
  // cached card at once without touching the database. .editcard
  // (commands/cardmanager.js) also clears these three fields whenever a
  // face-affecting field changes, so a stale render is never served after
  // an edit.
  renderedUrl: { type: String, default: null },
  renderVersion: { type: Number, default: null },
  renderedAt: { type: Date, default: null },
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
    ref: 'CardCatalogue',
    // ADDED: nothing previously stopped two OwnedCard documents from
    // sharing the same catalogueId — the "only one owner at a time"
    // invariant was purely an application-level check (each command reads
    // "does an OwnedCard with this catalogueId already exist?" before
    // creating one), which two concurrent requests can both pass before
    // either has written anything. This unique index makes the database
    // itself the actual enforcer: a second concurrent create() for the
    // same catalogueId now fails outright (E11000) instead of silently
    // succeeding and creating two owners for one card. sparse (matching
    // `code` below) so it only applies once a card is actually
    // catalogue-linked, not to every OwnedCard row in general.
    //
    // UNCERTAIN: if any duplicate catalogueId rows already exist in the
    // live collection from before this fix, MongoDB will refuse to build
    // this index and will keep running WITHOUT it (silently, no crash) —
    // functionally the same unprotected state as today. Worth a one-off
    // check (`db.ownedcards.aggregate([{$match:{catalogueId:{$ne:null}}},
    // {$group:{_id:"$catalogueId",n:{$sum:1}}},{$match:{n:{$gt:1}}}])` in
    // mongosh) after deploying, rather than assuming it applied cleanly.
    unique: true,
    sparse: true,
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
  // Persisted expiry for .lendcard, checked lazily (see resolveExpiredLends
  // in commands/cards.js) in addition to the in-memory setTimeout that does
  // the normal 1-hour auto-return. The setTimeout alone isn't reliable on
  // Termux — a PM2 restart during that hour kills it with no re-arm on
  // boot, which would otherwise leave isLent stuck true forever. Having the
  // real expiry stored here means the next .lendcard/.unlendcard call (or
  // any future startup reconciliation job) can always catch up correctly.
  lendExpiresAt: { type: Date, default: null },
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

// ─── Sale Request (direct user-to-user sale via .sc) ─────────────────────────
// BUGFIX (Aug 2026): .sc used to transfer the card AND move coins the
// instant the seller ran the command — no consent from the buyer at all,
// and no way for them to decline. This mirrors TradeRequestSchema's
// propose-then-accept pattern above: nothing changes hands until the buyer
// runs .acceptsale (see commands/cards.js), same as a trade needs
// .accepttrade. .declinesale (or letting it expire after 10 min, checked
// the same way .accepttrade checks trade age) cancels it with no side
// effects.
const SaleRequestSchema = new mongoose.Schema({
  groupId: { type: String, required: true },
  sellerId: { type: String, required: true },
  buyerId: { type: String, required: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'OwnedCard', required: true },
  price: { type: Number, required: true },
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
  SaleRequest: mongoose.model('SaleRequest', SaleRequestSchema),
  CatalogueGrowthState: mongoose.model('CatalogueGrowthState', CatalogueGrowthStateSchema),
};
