import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {build} from 'esbuild';
import {createStore} from '../src/storage.js';

async function until(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Expected application state did not arrive');}

test('existing screen persists capture, focus transitions, matrix edits and calendar blocks',async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'),{url:'https://app.example.test/LoughdIn/',pretendToBeVisual:true});
  const originals=new Map();for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,location:dom.window.location,localStorage:dom.window.localStorage,Option:dom.window.Option,indexedDB:new IDBFactory(),BroadcastChannel:undefined})){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const bundle=await build({absWorkingDir:appRoot,entryPoints:['src/app.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',plugins:[{name:'offline-account-fixture',setup(builder){builder.onResolve({filter:/^\.\/config\.js$/},()=>({path:'config',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const SUPABASE_URL='';export const SUPABASE_PUBLISHABLE_KEY='';",loader:'js'}));}}]});
  let app,observer;try{
    app=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    assert.equal(app.authRedirectURL('https://padraigbros.github.io/LoughdIn/index.html?code=secret#token'),'https://padraigbros.github.io/LoughdIn/');
    assert.equal(app.recoveryPasswordError('short','short'),'Use at least 8 characters.');
    assert.equal(app.recoveryPasswordError('long-enough','different'),'Passwords do not match.');
    assert.equal(app.recoveryPasswordError('long-enough','long-enough'),'');
    observer=createStore({namespace:'guest'});await observer.open();const $=id=>document.getElementById(id);
    assert.equal(document.querySelectorAll('#scene-stack svg').length,3);
    $('task-input').value='Ship a small, useful improvement';await $('task-add-btn').onclick();
    let data=await observer.readState();assert.equal(data.tasks.work.length,1);const task=data.tasks.work[0];
    await document.querySelector('.task-text').onclick();await $('btn-start').onclick();
    data=await observer.readState();assert.equal(data.timer.status,'running');assert.equal(data.timer.task.id,task.id);
    await $('btn-start').onclick();assert.equal((await observer.readState()).timer.status,'paused');
    await $('btn-finish').onclick();data=await observer.readState();assert.equal(data.sessions.length,1);assert.equal(data.sessions[0].outcome,'partial');
    await $('btn-start').onclick();data=await observer.readState();assert.equal(data.timer.status,'running');assert.equal(data.sessions.length,1);
    await $('btn-reset').onclick();
    document.querySelector('[data-view=matrix]').onclick();const quadrant=document.querySelector('.ld-planner__move');quadrant.value='schedule';quadrant.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    await until(async()=>(await observer.readState()).tasks.work[0].quadrant==='schedule');
    document.querySelector('[data-view=plan]').onclick();let form=document.querySelector('.ld-planner__form');form.elements.date.value='2026-09-09';form.elements.time.value='09:00';form.elements.duration.value='25';form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(async()=>(await observer.readState()).blocks.length===1&&!document.querySelector('.ld-planner__form button[type=submit]').disabled);
    assert.equal(document.querySelectorAll('.ld-planner__form').length,1);
    form=document.querySelector('.ld-planner__form');form.elements.date.value='2026-09-09';form.elements.time.value='09:10';form.elements.duration.value='25';form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>document.querySelector('.ld-planner__error').textContent.includes('overlaps'));
    assert.equal((await observer.readState()).blocks.length,1);
    $('btn-zen').onclick();assert.equal($('app').classList.contains('zen'),true);$('zen-exit-btn').onclick();assert.equal($('app').classList.contains('zen'),false);
    document.querySelector('[data-view=list]').onclick();await document.querySelector('.task-del').onclick();data=await observer.readState();assert.ok(data.tasks.work[0].deletedAt);assert.ok(data.blocks[0].deletedAt);
    assert.equal(document.querySelectorAll('.task').length,0);
  }finally{await app?.disposeApp();observer?.close();dom.window.close();for(const [key,value] of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}
});
