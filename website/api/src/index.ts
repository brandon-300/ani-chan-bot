/**
 * AniChan TypeScript / Express.js / MongoDB backend.
 * Isolated staging deployment; does NOT overwrite the existing Pages website.
 * No new WhatsApp commands. Registration identity proof uses .reg CODE.
 */
import { httpServerHandler } from 'cloudflare:node';
import express, { type Request, type Response, type NextFunction } from 'express';
import { type Filter } from 'mongodb';
import { auth } from './auth';
import { bot } from './bot';
import { cfg, withMongo } from './mongo';
import { mailReady } from './email';

interface Card { cardId: string; name: string; series: string; tier: string }

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'180kb',strict:true}));
app.use(auth);
app.use(bot);
function apiError(res:Response,status:number,error:string):void {
  res.status(status).set('Cache-Control','no-store').json({error});
}
const scalar=(v:unknown,n:number)=>typeof v==='string'?v.trim().slice(0,n):'';
const escapeRegex=(s:string)=>Array.from(s).map(c=>'\\^$.*+?()[]{}|'.includes(c)?'\\'+c:c).join('');
const safePage=(v:unknown)=>{const page=Number(v);return Number.isSafeInteger(page)&&page>0?Math.min(50,page):1};

app.get('/api/health',(_req:Request,res:Response)=>{
  res.set('Cache-Control','no-store').json({
    ok:true,service:'anichan-api',
    stack:'TypeScript / Express.js / MongoDB Atlas',
    databaseConfigured:Boolean(cfg().MONGODB_URI),
    emailReady:mailReady(),
    whatsappLinking:Boolean(cfg().BOT_LINK_SECRET && cfg().WHATSAPP_LINK_ENABLED==='true'),
    productionCutover:false
  });
});
app.get('/api/cards', async(req:Request,res:Response)=>{
  const query=scalar(req.query.q,64),tier=scalar(req.query.tier,4).toUpperCase(),page=safePage(req.query.page);
  if(!cfg().MONGODB_URI)return apiError(res,503,'MongoDB is not configured for this staging API.');
  const filter:Filter<Card>={};
  if(query){
    const escaped=escapeRegex(query);
    filter.$or=[{name:{$regex:escaped,$options:'i'}},{series:{$regex:escaped,$options:'i'}}];
  }
  if(['C','B','A','S','SS','SSS'].includes(tier))filter.tier=tier;
  try{
    await withMongo(async(_db,client)=>{
      const collection=client.db('anichan').collection<Card>('cardcatalogues');
      const [total,cards]=await Promise.all([
        collection.countDocuments(filter),
        collection.find(filter,{projection:{_id:0,cardId:1,name:1,series:1,tier:1}})
          .sort({name:1}).skip((page-1)*20).limit(20).toArray()
      ]);
      res.set('Cache-Control','public, max-age=30').json({cards,total,page});
    });
  }catch(e){
    console.error('Catalogue read error:',e instanceof Error?e.name:'Unknown');
    apiError(res,503,'Catalogue temporarily unavailable.');
  }
});
app.use((_req:Request,res:Response)=>apiError(res,404,'Not found.'));
app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  console.error('AniChan API invalid request:',err instanceof Error?err.name:'Unknown');
  apiError(res,400,'Invalid request.');
});
app.listen(3000);
const apiHandler=httpServerHandler({port:3000});
type AssetEnv = { ASSETS:{fetch(request:globalThis.Request):Promise<globalThis.Response>} };
type ApiFetch = (request:globalThis.Request, environment:unknown, context:ExecutionContext) => Promise<globalThis.Response>;
const apiFetch = apiHandler.fetch as ApiFetch;
export default {
  fetch(request:globalThis.Request, environment:AssetEnv, context:ExecutionContext):Promise<globalThis.Response> {
    const url=new URL(request.url);
    if(url.pathname==='/api' || url.pathname.startsWith('/api/')){
      return apiFetch(request,environment,context);
    }
    // Pages advanced mode serves original AniChan frontend alongside Express.
    return environment.ASSETS.fetch(new globalThis.Request(new URL('/index.html',url)));
  }
};
