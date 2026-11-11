/**
 * Built-in REST API for Ani-Chan Bot (Baileys branch).
 *
 * Exposes read-only access to the same MongoDB the WhatsApp bot uses, so a
 * website (or later a Discord bot) can show live leaderboards, the card
 * catalogue, guilds and auctions. All responses go through serializers.js —
 * only whitelisted fields are ever exposed.
 *
 * Config (documented in .env.example):
 *   API_ENABLED — "false" disables the server entirely (default "true")
 *   API_PORT    — listen port (default 3000)
 *   API_KEY     — optional shared secret, required as the X-API-Key header on
 *                 /api/admin/* routes. Empty = admin routes return 503.
 */
import express from 'express';
import apiRouter from './routes.js';
import User from '../models/User.js';
import { publicUser } from './serializers.js';
import { BOT_NAME, BOT_PREFIX } from '../utils/config.js';
import logger from '../utils/logger.js';

const API_ENABLED = String(process.env.API_ENABLED ?? 'true').toLowerCase() !== 'false';
const API_PORT = (() => {
  const n = parseInt(process.env.API_PORT ?? '', 10);
  return Number.isNaN(n) ? 3000 : n;
})();
const API_KEY = process.env.API_KEY || '';

export { API_ENABLED, API_PORT };

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({ error: 'API_KEY is not configured on the bot; admin routes are disabled' });
  }
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use((req, res, next) => {
    logger.write('INFO', 'api.request', { method: req.method, path: req.path });
    next();
  });

  app.use('/api', apiRouter);

  // Protected admin routes (pattern for future write endpoints that the
  // website or Discord bot will call with the shared API key).
  app.get('/api/admin/users', requireApiKey, async (req, res, next) => {
    try {
      const users = await User.find().sort({ lastActiveAt: -1 }).limit(100).lean();
      res.json({ count: users.length, users: users.map(publicUser) });
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('api.error', err, { method: req.method, path: req.path });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

let server = null;

export async function startApiServer() {
  if (!API_ENABLED) {
    logger.write('INFO', 'api.disabled', { reason: 'API_ENABLED=false' });
    return null;
  }
  if (server) return server;
  const app = createApp();
  server = app.listen(API_PORT, () => {
    logger.write('INFO', 'api.listening', { port: API_PORT, bot: BOT_NAME });
    console.log(`🌐 REST API listening on http://localhost:${API_PORT}/api/health`);
  });
  return server;
}
