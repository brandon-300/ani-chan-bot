/**
 * AniChan future TypeScript / Express.js backend.
 * Staged separately: neither the live Pages site nor the WhatsApp bot is switched.
 * The MongoDB catalogue route is deliberately READ ONLY in this phase.
 */
import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import express, { type Request, type Response, type NextFunction } from 'express';
import { MongoClient, type Filter } from 'mongodb';

interface Environment { MONGODB_URI?: string }
interface Card { cardId: string; name: string; series: string; tier: string }

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function getEnv(): Environment { return env as unknown as Environment }

function apiError(res: Response, status: number, message: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error: message });
}
function parsePage(value: unknown): number {
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 1 ? Math.min(num, 50) : 1;
}
function queryValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true, service: 'anichan-api',
    stack: 'TypeScript / Express.js / MongoDB Atlas',
    databaseConfigured: Boolean(getEnv().MONGODB_URI),
    productionCutover: false
  });
});

app.get('/api/cards', async (req: Request, res: Response) => {
  const { MONGODB_URI } = getEnv();
  if (!MONGODB_URI) return apiError(res, 503, 'MongoDB connection is not configured.');
  const nameQuery = queryValue(req.query.q, 64);
  const tier = queryValue(req.query.tier, 4).toUpperCase();
  const page = parsePage(req.query.page);
  const filter: Filter<Card> = {};
  if (nameQuery) {
    const safe = escapedRegex(nameQuery);
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { series: { $regex: safe, $options: 'i' } }
    ];
  }
  if (['C', 'B', 'A', 'S', 'SS', 'SSS'].includes(tier)) filter.tier = tier;

  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 4500,
    connectTimeoutMS: 4500,
    maxIdleTimeMS: 10000
  });
  try {
    await client.connect();
    const collection = client.db('anichan').collection<Card>('cardcatalogues');
    const [total, records] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter, {
        projection: { _id: 0, cardId: 1, name: 1, series: 1, tier: 1 }
      }).sort({ name: 1 }).skip((page - 1) * 20).limit(20).toArray()
    ]);
    res.set('Cache-Control', 'public, max-age=30').json({ cards: records, total, page });
  } catch (error) {
    // Neither error messages nor logs must disclose MongoDB credentials.
    console.error('MongoDB cards request failed:', error instanceof Error ? error.name : 'UnknownError');
    apiError(res, 503, 'Card catalogue is temporarily unavailable.');
  } finally {
    await client.close().catch(() => {});
  }
});

app.use((_req: Request, res: Response) => apiError(res, 404, 'Not found.'));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('AniChan API request rejected:', err instanceof Error ? err.name : 'UnknownError');
  apiError(res, 400, 'Invalid API request.');
});
app.listen(3000);
export default httpServerHandler({ port: 3000 });
