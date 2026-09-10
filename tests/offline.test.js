import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function worker(){const listeners={},stores=new Map();let skips=0,network=0;
  const api={open:async name=>{if(!stores.has(name))stores.set(name,new Map());const cache=stores.get(name);return {addAll:async urls=>urls.forEach(url=>cache.set(url,new Response(url))),match:async request=>cache.get(typeof request==='string'?request:request.url)?.clone(),put:async(request,response)=>cache.set(typeof request==='string'?request:request.url,response)};},keys:async()=>[...stores.keys()],delete:async key=>stores.delete(key)};
  vm.runInNewContext(await readFile(new URL('../sw.js',import.meta.url),'utf8'),{URL,Response,caches:api,fetch:async()=>{network++;throw Error('offline');},self:{registration:{scope:'https://example.test/LoughdIn/'},location:{origin:'https://example.test'},clients:{claim:async()=>{}},skipWaiting:async()=>{skips++;},addEventListener:(name,fn)=>{listeners[name]=fn;}}});
  return {listeners,stores,skips:()=>skips,network:()=>network,run:async(name,extra={})=>{let pending;listeners[name]({...extra,waitUntil:p=>{pending=p;},respondWith:p=>{pending=p;}});return pending;}};
}
test('offline worker serves its complete scoped shell without touching API requests',async()=>{
  const w=await worker();await w.run('install');assert.equal(w.skips(),0);
  const nav=await w.run('fetch',{request:{method:'GET',mode:'navigate',url:'https://example.test/LoughdIn/'}});assert.match(await nav.text(),/LoughdIn\/index.html/);assert.equal(w.network(),0);
  const module=await w.run('fetch',{request:{method:'GET',url:'https://example.test/LoughdIn/src/config.js'}});assert.match(await module.text(),/config.js/);
  assert.equal(await w.run('fetch',{request:{method:'POST',url:'https://example.test/LoughdIn/api'}}),undefined);
  assert.equal(await w.run('fetch',{request:{method:'GET',url:'https://project.supabase.co/rest/v1/tasks'}}),undefined);
});
test('activation removes only old versions for this registration scope',async()=>{
  const w=await worker();await w.run('install');const current=[...w.stores.keys()][0];const old=current.replace(/:v1$/,':old');w.stores.set(old,new Map());w.stores.set('another-app',new Map());await w.run('activate');assert.equal(w.stores.has(old),false);assert.equal(w.stores.has(current),true);assert.equal(w.stores.has('another-app'),true);
  await w.run('message',{data:{type:'SKIP_WAITING'}});assert.equal(w.skips(),1);
});
