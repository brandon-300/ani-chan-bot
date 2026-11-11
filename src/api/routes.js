// ─── REST API routes ────────────────────────────────────────────────────────
// Read-only endpoints over the bot's MongoDB data, mounted at /api by
// server.js. Every response goes through the serializers in serializers.js,
// so nothing private (loan, afk, warns, dob, ...) can leak into a response.
import { Router } from 'express';
import User from '../models/User.js';
import Guild from '../models/Guild.js';
import CardModels from '../models/Card.js';
import {
  publicUser,
  leaderboardEntry,
  publicCard,
  publicOwnedCard,
  publicGuild,
  publicAuction,
} from './serializers.js';
import { BOT_NAME, BOT_PREFIX } from '../utils/config.js';

const { CardCatalogue, OwnedCard, Auction } = CardModels;

const router = Router();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function paginate(query, defaultLimit = 20, maxLimit = 100) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

function paginated(total, page, limit, items) {
  return { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1), items };
}

// ─── Health & overview ──────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: BOT_NAME,
    prefix: BOT_PREFIX,
    time: new Date().toISOString(),
  });
});

router.get('/stats', async (req, res, next) => {
  try {
    const [users, catalogueCards, ownedCards, guilds, activeAuctions] = await Promise.all([
      User.countDocuments(),
      CardCatalogue.countDocuments(),
      OwnedCard.countDocuments(),
      Guild.countDocuments(),
      Auction.countDocuments({ isActive: true, endsAt: { $gt: new Date() } }),
    ]);
    res.json({ users, catalogueCards, ownedCards, guilds, activeAuctions });
  } catch (err) {
    next(err);
  }
});

// ─── Leaderboards ───────────────────────────────────────────────────────────
const LEADERBOARD_TYPES = ['coins', 'xp', 'level', 'orbs', 'tradesCompleted'];

router.get('/leaderboard', async (req, res, next) => {
  try {
    const type = LEADERBOARD_TYPES.includes(req.query.type) ? req.query.type : 'coins';
    const { limit, page, skip } = paginate(req.query, 20);
    const [rows, total] = await Promise.all([
      User.find().sort({ [type]: -1, _id: 1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(),
    ]);
    res.json(paginated(total, page, limit, rows.map((u) => leaderboardEntry(u, type))));
  } catch (err) {
    next(err);
  }
});

// ─── Users ──────────────────────────────────────────────────────────────────
router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findOne({ id: req.params.id }).lean();
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/cards', async (req, res, next) => {
  try {
    const { limit, page, skip } = paginate(req.query, 50);
    const [rows, total] = await Promise.all([
      OwnedCard.find({ ownerId: req.params.id }).sort({ obtainedAt: -1 }).skip(skip).limit(limit).lean(),
      OwnedCard.countDocuments({ ownerId: req.params.id }),
    ]);
    res.json(paginated(total, page, limit, rows.map(publicOwnedCard)));
  } catch (err) {
    next(err);
  }
});

// ─── Card catalogue ─────────────────────────────────────────────────────────
router.get('/cards', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.q) {
      const rx = new RegExp(escapeRegex(String(req.query.q)), 'i');
      filter.$or = [{ name: rx }, { series: rx }, { aliases: rx }];
    }
    if (req.query.tier) filter.tier = String(req.query.tier).toUpperCase();
    const sort = req.query.sort === 'name' ? { name: 1 } : { value: -1, name: 1 };
    const { limit, page, skip } = paginate(req.query, 20);
    const [rows, total] = await Promise.all([
      CardCatalogue.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      CardCatalogue.countDocuments(filter),
    ]);
    res.json(paginated(total, page, limit, rows.map(publicCard)));
  } catch (err) {
    next(err);
  }
});

router.get('/cards/:cardId', async (req, res, next) => {
  try {
    const card = await CardCatalogue.findOne({ cardId: req.params.cardId }).lean();
    if (!card) return res.status(404).json({ error: 'card not found' });
    const currentOwners = await OwnedCard.countDocuments({ catalogueId: card.cardId });
    res.json({ ...publicCard(card), currentOwners });
  } catch (err) {
    next(err);
  }
});

// ─── Guilds ─────────────────────────────────────────────────────────────────
router.get('/guilds', async (req, res, next) => {
  try {
    const sort =
      req.query.sort === 'reputation'
        ? { reputation: -1, level: -1 }
        : { level: -1, xp: -1 };
    const { limit, page, skip } = paginate(req.query, 20);
    const [rows, total] = await Promise.all([
      Guild.find().sort(sort).skip(skip).limit(limit).lean(),
      Guild.countDocuments(),
    ]);
    res.json(paginated(total, page, limit, rows.map(publicGuild)));
  } catch (err) {
    next(err);
  }
});

router.get('/guilds/:id', async (req, res, next) => {
  try {
    const raw = req.params.id;
    const query = /^\d+$/.test(raw) ? { guildId: Number(raw) } : { name: raw };
    const guild = await Guild.findOne(query).lean();
    if (!guild) return res.status(404).json({ error: 'guild not found' });
    res.json(publicGuild(guild));
  } catch (err) {
    next(err);
  }
});

// ─── Auctions ───────────────────────────────────────────────────────────────
router.get('/auctions', async (req, res, next) => {
  try {
    const { limit, page, skip } = paginate(req.query, 20);
    const filter = { isActive: true, endsAt: { $gt: new Date() } };
    const [rows, total] = await Promise.all([
      Auction.find(filter).sort({ endsAt: 1 }).skip(skip).limit(limit).lean(),
      Auction.countDocuments(filter),
    ]);
    res.json(paginated(total, page, limit, rows.map(publicAuction)));
  } catch (err) {
    next(err);
  }
});

export default router;
