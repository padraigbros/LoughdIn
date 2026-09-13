// Real Chromium checks against the production artifact at the Pages subpath.
// Run `npx playwright install chromium` once, then `npm run test:browser`.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

const port = 4176;
const base = `http://127.0.0.1:${port}/LoughdIn/`;
const out = process.env.UX_SCREENSHOTS || 'test-results/immersive';
await mkdir(out, {recursive:true});
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  env:{...process.env, PORT:String(port), SERVE_ROOT:'dist'}, stdio:'pipe', windowsHide:true,
});
let browser;
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Preview did not start')),10000);
    server.once('exit',code=>{clearTimeout(timer);reject(Error(`Preview exited ${code}`));});
    server.stdout.on('data',data=>{if(String(data).includes(String(port))){clearTimeout(timer);resolve();}});
  });
  browser = await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('Saved'));
  await page.waitForFunction(()=>document.querySelector('#lake-background').complete&&document.querySelector('#lake-background').naturalWidth>0);
  assert.equal(await page.locator('#main-quote').textContent(),"Do what you can't.");
  await page.locator('#task-input').fill('Draft the project proposal');
  await page.locator('#task-add-btn').click();
  await page.locator('.task-focus-btn').click();
  await page.waitForFunction(()=>document.querySelector('#active-task-text').textContent==='Draft the project proposal');
  for(const title of ['Prepare meeting notes','Clear the inbox']){
    await page.locator('#task-input').fill(title);await page.locator('#task-add-btn').click();
    await page.waitForFunction(text=>Array.from(document.querySelectorAll('.task-text')).some(el=>el.textContent===text),title);
  }
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:`${out}/desktop.png`,fullPage:true});
  async function noOverflow(label){
    const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<-1);}).map(el=>({tag:el.tagName,id:el.id,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})).slice(0,20));
    if(overflow.length)console.log(label,overflow);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${label}: horizontal overflow`);
    const quote=await page.locator('.quote-carousel').boundingBox();
    const timer=await page.locator('.timer-block').boundingBox();
    if(timer)assert.ok(quote.y+quote.height<=timer.y+1,`${label}: quote overlaps timer`);
  }
  await noOverflow('desktop');
  for(const [label,width,height] of [['mobile',390,844],['narrow',320,740],['landscape',844,390]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:`${out}/${label}.png`,fullPage:true});
    await noOverflow(label);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#btn-start').click();
  await page.waitForFunction(()=>document.querySelector('#btn-start').textContent.includes('Pause'));
  await page.locator('#btn-start').click();
  await page.waitForFunction(()=>document.querySelector('#btn-start').textContent.includes('Resume'));
  await page.locator('#task-list .task-text').nth(1).click();
  await page.waitForFunction(()=>document.querySelector('#queued-task').textContent.includes('Prepare meeting notes'));
  assert.equal(await page.locator('#active-task-text').textContent(),'Draft the project proposal');
  await page.locator('button[data-section=plan]').click();
  await page.locator('.ld-planner__form').waitFor({state:'visible'});
  assert.ok(await page.locator('.timer-block').isHidden());
  await page.screenshot({path:`${out}/mobile-plan.png`,fullPage:true});
  await page.locator('button[data-section=progress]').click();
  await page.locator('#progress-panel').waitFor({state:'visible'});
  await page.locator('button[data-section=focus]').click();
  await page.locator('#btn-zen').click();
  assert.ok(await page.locator('.quote-carousel').isVisible());
  assert.ok(await page.locator('#tasks-panel').isHidden());
  await page.locator('#zen-exit-btn').click();
  // Offline navigation must retain the real photograph, icon and new CSS.
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#lake-background').naturalWidth>0);
  assert.equal(await page.locator('.task').count(),3);
  assert.equal(await page.locator('#btn-start').textContent(),'▶ Resume');
  for(const asset of ['assets/lough-guitane.png','icons/keyhole.svg','styles/immersive.css']){
    assert.equal(await page.evaluate(async url=>(await fetch(url)).ok,asset),true,`${asset} missing offline`);
  }
  assert.deepEqual(errors,[]);
  console.log(`Browser checks passed: desktop, mobile, narrow, landscape, navigation, timer, Zen and offline. Screenshots: ${out}`);
} finally {
  await browser?.close();
  server.kill();
}
