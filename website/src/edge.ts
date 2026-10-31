// AniChan API v2: TypeScript + Express.js + native MongoDB driver.
// This module is staged behind /api/v2/* while the existing D1 website stays
// authoritative for website login. No MongoDB writes occur in this module.
import express, { type Request as ExpressRequest, type Response as ExpressResponse, type NextFunction } from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { env as workerEnv } from 'cloudflare:workers';
import { MongoClient, type Document, type Filter } from 'mongodb';
import legacy from '../worker.js';
import type { AniChanEnv, CatalogueCard } from './env.js';

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.use((_request: ExpressRequest, response: ExpressResponse, next: NextFunction) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const errorBody = (error: string) => ({ error });
const TIERS = new Set(['C', 'B', 'A', 'S', 'SS', 'SSS']);

/** Return only status information. Never include credentials or account records. */
app.get('/api/v2/health', (_req, res) => {
  const env = workerEnv as AniChanEnv;
  res.status(200).json({
    ok: true,
    app: 'AniChan',
    api: 'express-typescript-v2',
    databaseConfigured: Boolean(env.MONGODB_URI),
    dataMode: 'read-only',
    authenticationMode: 'legacy-d1',
    botLinkingReady: false
  });
});

app.get('/api/v2/catalogue', async (req, res) => {
  const env = workerEnv as AniChanEnv;
  if (!env.MONGODB_URI) {
    res.status(503).json(errorBody('MongoDB backend is not configured in this deployment.'));
    return;
  }

  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const page = Number.isSafeInteger(pageRaw) ? Math.max(1, Math.min(50, pageRaw)) : 1;
  const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
  const tier = typeof req.query.tier === 'string' ? req.query.tier.toUpperCase() : '';
  const where: Filter<Document> = {};

  if (term) {
    // Escaping prevents user input from defining an arbitrary Mongo regex.
    const escaped = [...term].map(char => '^$.*+?()[]{}|\\'.includes(char) ? '\\' + char : char).join('');
    where.$or = [{ name: { $regex: escaped, $options: 'i' } }, { series: { $regex: escaped, $options: 'i' } }];
  }
  if (TIERS.has(tier)) where.tier = tier;

  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 4500,
    connectTimeoutMS: 4500
  });

  try {
    await client.connect();
    const cards = client.db('anichan').collection<Document>('cardcatalogues');
    const [total, entries] = await Promise.all([
      cards.countDocuments(where, { maxTimeMS: 3500 }),
      cards.find(where, {
        projection: { _id: 0, cardId: 1, name: 1, series: 1, tier: 1 }
      }).sort({ tier: 1, name: 1 }).skip((page - 1) * 20).limit(20).maxTimeMS(3500).toArray()
    ]);
    res.status(200).json({ cards: entries as unknown as CatalogueCard[], total, page, source: 'mongodb-anichan-live' });
  } catch {
    // Avoid revealing connection strings, MongoDB hostnames, or credentials.
    res.status(503).json(errorBody('The catalogue is temporarily unavailable.'));
  } finally {
    await client.close().catch(() => undefined);
  }
});

app.all('/api/v2/{*path}', (_req, res) => {
  res.status(404).json(errorBody('Unknown AniChan API v2 endpoint.'));
});

app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });

// Preserve the existing, currently deployed D1 website API and frontend.
// The only new routes are /api/v2/*. No registration, password, session,
// gameplay, or MongoDB mutation behavior is changed by this staging build.
export default {
  async fetch(request: Request, env: AniChanEnv, context: any): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/v2/')) {
      // Cloudflare's exported fetch handler is optional in its interface;
      // Express supplies it at runtime, and we reject if unavailable.
      if (!expressHandler.fetch) return new Response('API handler unavailable', { status: 503 });
      return expressHandler.fetch(request as any, env as any, context as any) as Promise<Response>;
    }
    return legacy.fetch(request, env);
  }
};

