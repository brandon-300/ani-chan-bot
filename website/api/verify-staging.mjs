// Read-only smoke test for isolated AniChan API staging; no credentials needed.
const base = 'https://anichan-api-stage.pages.dev';
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function probe(path) {
  const response = await fetch(base+path, {signal:AbortSignal.timeout(30000),headers:{Accept:'application/json'}});
  let data; try {data=await response.json();} catch {data={error:'Invalid JSON'};}
  return {status:response.status,data};
}
let health;
for(let attempt=1;attempt<=20;attempt++) {
  try {
    health=await probe('/api/health');
    if(health.status===200 && health.data?.service==='anichan-api') break;
    console.log('Staging health attempt',attempt,'HTTP',health.status);
  } catch(err) {console.log('Staging health attempt',attempt,err.name);}
  if(attempt<20) await sleep(9000);
}
if(health?.status!==200 || health.data?.service!=='anichan-api') {
  console.error('AniChan staged API health not ready',health?.status||'network_error');
  process.exit(1);
}
console.log('Health OK. Database configured:',Boolean(health.data.databaseConfigured));
if(!health.data.databaseConfigured){console.error('MONGODB_URI unavailable to deployed Worker. Redeploy after saving encrypted secret.');process.exit(1);}
const cards=await probe('/api/cards?page=1');
if(cards.status!==200 || !Array.isArray(cards.data?.cards) || typeof cards.data?.total!=='number') {
  console.error('Read-only MongoDB catalogue test failed. HTTP',cards.status,'error:',String(cards.data?.error||'Invalid response'));
  process.exit(1);
}
console.log('Read-only MongoDB catalogue check passed. Public card count:',cards.data.total);
console.log('Database connection confirmed without any writes.');
