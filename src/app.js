import {SCENES,QUOTES} from './scenes.js';
import {createStore} from './storage.js';
import {createTimer,transition,timerDisplay,remainingMs,sessionFromTimer,nextAutomaticPhase,dailyStats,weekStats,localDateKey,createClock} from './timer.js';
import {mountPlanner,renderPlanner,validateBlock} from './planner.js';
import {createSync} from './sync.js';
import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './config.js';

const $=id=>document.getElementById(id), uuid=()=>crypto.randomUUID();
const clock=createClock();
let timerInterval,quoteInterval,authSubscription;
let store,state,unsubscribe,deviceId,account=null,sync=null,client=null,list='work',view='list',busy=false,completing=false;
let syncState={state:'local',pending:0};
const activeTasks=s=>Object.entries(s.tasks).flatMap(([list,tasks])=>tasks.filter(t=>!t.deletedAt).map(t=>({...t,list})));
const findTask=(s,id)=>Object.values(s.tasks).flat().find(t=>t.id===id&&!t.deletedAt);
const selected=s=>activeTasks(s).find(t=>t.id===s.activeTask)||null;
function element(tag,attrs={},text=''){const el=document.createElement(tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);el.textContent=text;return el;}
const SYNC_MESSAGES={local:'Saved on this device',syncing:'Saved on this device · syncing…',pending:'Saved on this device · %n changes pending',offline:'Offline · saved on this device',auth:'Saved on this device · sign in to sync',conflict:'Saved on this device · open your account to resolve changes',error:'Saved on this device · sync needs attention',synced:'All changes synced'};
const SYNC_TONES={synced:'ok',syncing:'work',pending:'work',local:'idle',offline:'idle',auth:'warn',conflict:'alert',error:'alert'};
export function syncMessage(state,pending=0){return (SYNC_MESSAGES[state]||SYNC_MESSAGES.local).replace('%n',pending);}
/**
 * What the account control in the brand row says without being opened. Guest
 * and account data are kept deliberately separate, so the signed-in address
 * has to be legible during normal use rather than only inside the dialog.
 */
export function accountSummary(account,sync={},available=true){
  if(!account)return {initial:'',tone:'idle',badge:'',title:available
    ?'Not signed in. Tasks stay on this device. Open to sign in and sync across devices.'
    :'Not signed in. Cloud sync is unavailable, so tasks are saved on this device.'};
  const initial=(account.email||'').trim().charAt(0).toUpperCase()||'?';
  const email=account.email||'Your account';
  if(!available)return {initial,tone:'idle',badge:'',title:email+' · cloud sync is unavailable'};
  const state=sync.state||'local';
  const pending=sync.pending||0;
  return {
    initial,
    tone:SYNC_TONES[state]||'idle',
    badge:state==='conflict'||state==='error'?'!':pending>0?String(Math.min(pending,9)):'',
    title:email+' · '+syncMessage(state,pending),
  };
}
function status(text,error=false){$('save-status').textContent=text;$('save-status').dataset.error=String(error);}
function fail(error){console.error(error);status(error.message||'Unable to save. Your last saved data is preserved.',true);}
function command(kind,entityId,payload,baseRevision=0){return {protocol:1,opId:uuid(),deviceId,kind,entityId,baseRevision,payload};}
async function save(mutator,makeCommand){
  const result=await store.mutate(mutator,{command:account&&makeCommand?(result,draft)=>result?makeCommand(result,draft):null:undefined});
  state=result.state;render();status(account?'Saved on this device · sync pending':'Saved on this device');sync?.flush().catch(fail);return result.result;
}
function action(fn){return async event=>{try{await fn(event);}catch(error){fail(error);}};}
function setupShell(){
  const css=element('link',{rel:'stylesheet',href:'styles/enhancements.css'});document.head.append(css);
  $('task-input').setAttribute('aria-label','New task');$('task-input').maxLength=500;$('task-prio').setAttribute('aria-label','Task priority');$('music-vol').setAttribute('aria-label','Music volume');
  $('scene-prev').setAttribute('aria-label','Previous scene');$('scene-next').setAttribute('aria-label','Next scene');$('scene-new').setAttribute('aria-label','Shuffle scenery');$('zen-exit-btn').setAttribute('aria-label','Exit Zen mode');
  document.querySelector('.mode-tags').append(element('button',{class:'mode-tag','data-mode':'flow'},'Flow'));
  const finish=element('button',{class:'t-btn',id:'btn-finish'},'Finish');document.querySelector('.timer-actions').append(finish);
  const interrupt=element('button',{class:'t-btn t-btn-icon',id:'btn-interrupt',title:'Log an interruption','aria-label':'Log an interruption'},'↗');document.querySelector('.timer-actions').append(interrupt);
  const toolbar=element('div',{class:'view-toolbar','aria-label':'Task view'});
  for(const name of ['list','matrix','plan']){const b=element('button',{'data-view':name,'aria-pressed':String(name===view)},name[0].toUpperCase()+name.slice(1));b.onclick=()=>{view=name;render();};toolbar.append(b);}
  $('task-list').before(toolbar);$('task-list').after(element('div',{id:'planning-view',hidden:''}));
  // Who you are signed in as and whether sync is working are ambient, not
  // occasional, so the control sits beside settings and carries both at a
  // glance rather than only once a dialog is open.
  const accountBtn=element('button',{class:'brand-btn account-btn',id:'btn-account','aria-haspopup':'dialog'});
  accountBtn.append(element('span',{class:'account-glyph'}),element('span',{class:'account-dot','aria-hidden':'true'}));
  $('btn-settings').before(accountBtn);
  const footer=element('div',{class:'account-actions'});
  footer.append(element('button',{class:'subtle-btn',id:'btn-backup'},'Backup'));
  const history=element('button',{class:'subtle-btn',id:'btn-history'},'Session history');footer.append(history);
  const message=element('div',{id:'save-status',class:'save-status',role:'status','aria-live':'polite'},'Opening your tasks…');
  document.querySelector('.hero-foot').before(footer,message);
  for(const mode of ['work','short','long','goal'])$('dur-'+mode).previousElementSibling.htmlFor='dur-'+mode;
  $('settings-pop').setAttribute('aria-label','Timer settings');
  mountPlanner($('planning-view'),{onViewChange:next=>{view=next;render();},onTaskUpdate:(id,patch)=>updateTask(id,patch).catch(fail),onBlockSave:saveBlock,onBlockDelete:id=>deleteBlock(id).catch(fail),onFocusTask:id=>focusTask(id).catch(fail)});
  renderAccount();
}
const GUEST_GLYPH='<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><circle cx="12" cy="8.4" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.6 19.4a6.4 6.4 0 0 1 12.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
function renderAccount(){
  const button=$('btn-account');if(!button)return;
  const summary=accountSummary(account,syncState,!!client);
  const glyph=button.querySelector('.account-glyph');
  if(summary.initial)glyph.textContent=summary.initial;else glyph.innerHTML=GUEST_GLYPH;
  button.dataset.tone=summary.tone;button.title=summary.title;button.setAttribute('aria-label',summary.title);
  button.querySelector('.account-dot').textContent=summary.badge;
}
async function openStore(namespace){
  unsubscribe?.();store?.close();store=createStore({namespace});const opened=await store.open();
  if(opened.status==='recovery'){status('Your previous data needs recovery. Use Backup to export it before changing anything.',true);return;}
  deviceId=await store.getDeviceId();state=await store.readState();
  if(!state.timer){state=(await store.mutate(s=>{s.timer=createTimer({durations:s.settings.durations,task:selected(s)});})).state;}
  unsubscribe=store.subscribe((fresh,error)=>{if(error)return fail(error);state=fresh;render();});
  render();status(account?'Saved on this device · connecting':'Saved on this device');
}
function render(){
  if(!state)return;renderTimer();renderTasks();renderStats();
  for(const mode of ['work','short','long']){const mins=state.settings.durations[mode]/60;$('dur-'+mode).value=mins;$('dur-'+mode+'-val').textContent=mins+'m';}
  $('dur-goal').value=state.settings.goal;$('dur-goal-val').textContent=state.settings.goal;$('auto-cycle').checked=state.settings.autoCycle;
  $('task-list').hidden=view!=='list';$('planning-view').hidden=view==='list';
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  if(view!=='list')renderPlanner({state,list,view});
}
function renderTimer(){
  const t=state.timer;if(!t)return;const display=timerDisplay(t,clock.now());$('timer-display').textContent=display;
  document.title=t.status==='running'?display+" · Lough'd In":"Lough'd In";
  $('btn-start').textContent=t.status==='running'?'Ⅱ Pause':t.status==='complete'?'▶ New session':t.status==='paused'?'▶ Resume':'▶ Start';
  $('btn-interrupt').hidden=t.status!=='running';$('btn-finish').hidden=!['running','paused'].includes(t.status);$('btn-start').disabled=busy;
  document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===t.phase);b.setAttribute('aria-pressed',String(b.dataset.mode===t.phase));});
  const task=t.status==='idle'?selected(state):t.task;$('active-task-text').textContent=task?.text||'pick a task below to lock it in';
  $('active-dots').replaceChildren(...Array.from({length:Math.min(findTask(state,task?.id)?.poms||0,24)},()=>element('span',{class:'adot filled'})));
  $('session-text').textContent=t.phase==='flow'?'Flow · finish when you’re ready':`Session ${Math.min(t.cycles+1,4)} of 4`;
  [...$('session-dots').children].forEach((el,i)=>el.classList.toggle('done',i<t.cycles));
}
function renderTasks(){
  for(const category of ['work','personal'])$('count-'+category).textContent=state.tasks[category].filter(t=>!t.deletedAt&&!t.done).length;
  document.querySelectorAll('[data-list]').forEach(b=>{b.classList.toggle('active',b.dataset.list===list);b.setAttribute('aria-pressed',String(b.dataset.list===list));});
  const tasks=state.tasks[list].filter(t=>!t.deletedAt);const rows=tasks.map(t=>{
    const row=element('li',{class:`task ${t.done?'done':''} ${state.activeTask===t.id?'active':''}`,draggable:'true','data-id':t.id,'data-prio':t.priority});
    row.ondragstart=e=>{e.dataTransfer.setData('text/plain',t.id);e.dataTransfer.effectAllowed='move';};
    const check=element('input',{type:'checkbox',class:'task-check','aria-label':`Complete ${t.text}`});check.checked=t.done;check.onchange=action(()=>updateTask(t.id,{done:check.checked}));
    const text=element('button',{class:'task-text','aria-label':`Focus on ${t.text}`},t.text);text.onclick=action(()=>focusTask(t.id));
    if(t.nextAction)text.append(element('span',{class:'task-detail'},t.nextAction));
    const priority=element('span',{class:`prio-dot ${t.priority}`,title:`${t.priority} priority`});
    const edit=element('button',{class:'task-edit-btn','aria-label':`Edit ${t.text}`},'✎');edit.onclick=()=>editTask(t);
    const del=element('button',{class:'task-del','aria-label':`Delete ${t.text}`},'×');del.onclick=action(()=>deleteTask(t.id));
    row.append(check,priority,text,element('span',{class:'task-poms'},t.poms?String(t.poms):''),edit,del);return row;
  });$('task-list').replaceChildren(...(rows.length?rows:[element('li',{class:'empty-tasks'},'A little space for what matters. Add your first task.')]));
}
async function addTask(){
  const text=$('task-input').value.trim();if(!text)return;const now=new Date().toISOString();
  const task={id:uuid(),text,done:false,priority:$('task-prio').value,poms:0,quadrant:null,details:'',nextAction:'',estimateMinutes:25,createdAt:now,updatedAt:now,deletedAt:null,revision:0};const category=list;
  await save(s=>{s.tasks[category].push(task);return task;},t=>command('task.create',t.id,{text:t.text,done:false,priority:t.priority,list:category,quadrant:null,details:'',estimateMinutes:25,nextAction:''}));
  $('task-input').value='';$('task-input').focus();
}
async function updateTask(id,patch){await save(s=>{const t=findTask(s,id);if(!t)return null;const revision=t.revision||0;Object.assign(t,patch,{updatedAt:new Date().toISOString()});return {revision};},r=>command('task.update',id,patch,r.revision));}
async function deleteTask(id){await save(s=>{const t=findTask(s,id);if(!t)return null;t.deletedAt=new Date().toISOString();if(s.activeTask===id)s.activeTask=null;for(const b of s.blocks)if(b.taskId===id&&!b.deletedAt)b.deletedAt=t.deletedAt;return {revision:t.revision||0};},r=>command('task.delete',id,{},r.revision));}
async function focusTask(id){await save(s=>{if(!findTask(s,id))return;s.activeTask=id;if(s.timer.status==='idle')s.timer.task=selected(s);});if(state.timer.status!=='idle')status('Selected for your next session. The current session keeps its task.');}
// `note` carries waiting and success messages. Routing those through the error
// line is what made "check your email" read like a rejected password.
function dialog(title){const d=element('dialog');d.append(element('h2',{},title));const note=element('p',{class:'dialog-notice',role:'status'});const err=element('p',{class:'dialog-error',role:'alert'});const actions=element('div',{class:'dialog-actions'});const close=element('button',{class:'subtle-btn'},'Close');close.onclick=()=>d.close();actions.append(close);d.append(err,note,actions);document.body.append(d);d.addEventListener('close',()=>d.remove());return {d,err,note,actions,show:()=>d.showModal()};}
function field(d,label,tag='input',attrs={}){const wrap=element('label',{},label);const input=element(tag,attrs);wrap.append(input);d.insertBefore(wrap,d.querySelector('.dialog-error'));return input;}
export function authRedirectURL(href=location.href){const target=new URL('.',href);target.search='';target.hash='';return target.href;}
// Shared by account creation and password recovery: both ask for a password
// the person has never typed before, so both ask for it twice.
export function newPasswordError(password,confirmation){if(password.length<8)return 'Use at least 8 characters.';if(password!==confirmation)return 'Passwords do not match.';return '';}
function passwordRecoveryDialog(){
  const {d,err,note,actions,show}=dialog('Choose a new password');
  d.insertBefore(element('p',{},'Set a new password for the account that opened this recovery link.'),err);
  const password=field(d,'New password','input',{type:'password',autocomplete:'new-password',minlength:'8',required:''});
  const confirmation=field(d,'Confirm new password','input',{type:'password',autocomplete:'new-password',minlength:'8',required:''});
  const save=element('button',{class:'t-btn t-btn-primary'},'Update password');
  save.onclick=async()=>{const validation=newPasswordError(password.value,confirmation.value);if(validation){note.textContent='';err.textContent=validation;return;}save.disabled=true;try{const result=await client.auth.updateUser({password:password.value});if(result.error)throw result.error;err.textContent='';note.textContent='Password updated. You are signed in on this device.';password.value=confirmation.value='';}catch{note.textContent='';err.textContent='The password could not be updated. Request a new recovery link and try again.';}finally{save.disabled=false;}};
  confirmation.onkeydown=e=>{if(e.key==='Enter')save.click();};actions.append(save);show();
}
function editTask(task){const {d,err,actions,show}=dialog('A little more clarity');
  const name=field(d,'Task','input',{maxlength:'500'});name.value=task.text;
  const next=field(d,'Next small action','input',{maxlength:'500'});next.value=task.nextAction||'';
  const notes=field(d,'Notes','textarea',{maxlength:'10000'});notes.value=task.details;
  const estimate=field(d,'Estimated minutes','input',{type:'number',min:'1',max:'1440'});estimate.value=task.estimateMinutes;
  const quadrant=field(d,'Priority quadrant','select');for(const [value,label] of [['','Unsorted'],['do','Do · urgent & important'],['schedule','Schedule · important'],['delegate','Delegate · urgent'],['eliminate','Eliminate · neither']])quadrant.append(element('option',{value},label));quadrant.value=task.quadrant||'';
  const button=element('button',{class:'t-btn t-btn-primary'},'Save');button.onclick=async()=>{try{if(!name.value.trim()||!estimate.checkValidity())throw Error('Enter a task and an estimate between 1 and 1,440 minutes.');await updateTask(task.id,{text:name.value.trim(),nextAction:next.value.trim(),details:notes.value,estimateMinutes:Number(estimate.value),quadrant:quadrant.value||null});d.close();}catch(e){err.textContent=e.message;}};actions.append(button);show();
}
function recordCompletion(s,t){const session=sessionFromTimer(t);if(!session||s.sessions.some(x=>x.id===session.id))return null;s.sessions.push(session);if(session.outcome==='completed'&&session.mode==='pomodoro'){const task=findTask(s,session.taskId);if(task)task.poms++;}return session;}
function sessionCommand(session){return command('session.record',session.id,{taskId:session.taskId,mode:session.mode,startedAt:new Date(session.startedAt).toISOString(),endedAt:new Date(session.endedAt).toISOString(),focusMs:session.focusMs,interruptions:session.interruptions,outcome:session.outcome});}
async function timerAction(action,phase){
  if(busy||!state)return;busy=true;const expected=state.timer.id;
  try{await save(s=>{if(s.timer.id!==expected)return null;let t=s.timer;const now=clock.now();let session=null;
    if(action==='start'){if(t.status==='complete')t=createTimer({phase:t.phase,durations:s.settings.durations,task:selected(s),now});if(t.status==='idle')t.task=selected(s);s.timer=transition(t,'start',now);}
    else if(action==='reset'||action==='mode'){t=transition(t,'finish',now);session=recordCompletion(s,t);s.timer=createTimer({phase:phase||t.phase,durations:s.settings.durations,task:selected(s),now});}
    else {s.timer=transition(t,action,now);session=recordCompletion(s,s.timer);}
    return session;
  },sessionCommand);}finally{busy=false;renderTimer();}
}
async function tick(){
  if(!state||busy||completing)return;renderTimer();const t=state.timer;
  if(t.status!=='running'||t.durationMs===null||remainingMs(t,clock.now())>0)return;
  completing=true;try{const expected=t.id;let completed=false;
    await save(s=>{if(s.timer.id!==expected||s.timer.status!=='running')return null;
      const previous=s.timer;s.timer=transition(previous,'due',clock.now());if(s.timer.status!=='complete')return null;completed=true;
      const session=recordCompletion(s,s.timer);const next=nextAutomaticPhase(s.timer,s.settings);
      if(next){const fresh=createTimer({phase:next,durations:s.settings.durations,task:s.timer.task,cycles:s.timer.cycles+(s.timer.phase==='work'?1:0),now:clock.now()});
        // A late wake-up must never silently begin work that the user did not observe.
        s.timer=document.visibilityState==='visible'&&clock.now()-previous.deadlineAt<3000?transition(fresh,'start',clock.now()):fresh;}
      return session;
    },sessionCommand);if(completed){status('Session finished · saved');notifyComplete();}
  }catch(error){fail(error);}finally{completing=false;}
}
function notifyComplete(){if('Notification'in window&&Notification.permission==='granted'&&document.hidden)navigator.serviceWorker?.ready.then(r=>r.showNotification("Lough’d In",{body:'Your session has finished. Take a breath.',tag:'session-complete'})).catch(()=>{});}
function renderStats(){const stats=dailyStats(state.sessions);$('goal-num').textContent=`${stats.pomodoros}/${state.settings.goal}`;$('goal-ring-fg').setAttribute('stroke-dasharray',`${Math.min(1,stats.pomodoros/state.settings.goal)*169.6} 169.6`);$('stat-time').textContent=Math.floor(stats.focusMs/60000)+'m';$('stat-tasks').textContent=activeTasks(state).filter(t=>t.done).length;
  const days=new Set(state.sessions.filter(s=>s.focusMs>0).map(s=>localDateKey(s.endedAt)));let streak=0,date=new Date();date.setHours(12,0,0,0);if(!days.has(localDateKey(date)))date.setDate(date.getDate()-1);while(days.has(localDateKey(date))){streak++;date.setDate(date.getDate()-1);}$('stat-streak').textContent=streak;
  $('heat-row').replaceChildren(...weekStats(state.sessions).map(day=>element('div',{class:'heat-cell'+(day.date===localDateKey()?' today':''),'data-level':String(Math.min(4,Math.ceil(day.pomodoros/2))),title:`${day.date}: ${day.pomodoros} sessions, ${Math.floor(day.focusMs/60000)} minutes`})));
}
async function saveBlock(block){return save(s=>{if(!findTask(s,block.taskId))throw Error('This task is no longer available.');const valid=validateBlock(block,s.blocks);if(!valid.ok)throw Error(valid.error);const old=s.blocks.find(b=>b.id===block.id);if(old){const rev=old.revision||0;Object.assign(old,block);return {revision:rev,create:false};}s.blocks.push({...block,revision:0});return {revision:0,create:true};},r=>command(r.create?'block.create':'block.update',block.id,{taskId:block.taskId,startsAt:block.startAt,endsAt:block.endAt,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'},r.revision));}
async function deleteBlock(id){return save(s=>{const b=s.blocks.find(b=>b.id===id);if(!b)return null;b.deletedAt=new Date().toISOString();return {revision:b.revision||0};},r=>command('block.delete',id,{},r.revision));}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=element('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function sessionHistory(){
  const {d,err,show}=dialog('Time you made');
  if(!state.sessions.length)d.insertBefore(element('p',{},'Your completed and partial focus sessions will appear here.'),err);
  const entries=[...state.sessions].sort((a,b)=>new Date(b.endedAt)-new Date(a.endedAt)).slice(0,100);
  const list=element('div',{class:'history-list'});
  for(const session of entries){const row=element('article',{class:'sync-conflict'});const task=findTask(state,session.taskId);row.append(element('p',{},task?.text||session.taskText||'Open focus'),element('small',{},new Date(session.endedAt).toLocaleString()+' · '+Math.floor(session.focusMs/60000)+'m · '+session.mode+' · '+session.outcome+' · '+(session.interruptions||0)+' interruptions'));list.append(row);}
  d.insertBefore(list,err);
  if(state.legacy?.aggregates){const old=state.legacy.aggregates;d.insertBefore(element('p',{class:'legacy-note'},'Previous app totals retained in your backup: '+(old.pom||0)+' sessions and '+Math.floor((old.focusSeconds||0)/60)+' focus minutes on '+(old.recordedDay||'an unspecified date')+'. These totals have no individual session records.'),err);}
  show();
}
function backups(){const {d,err,actions,show}=dialog('Your data, kept with you');d.insertBefore(element('p',{},'Download a backup of this device’s data. Import merges a backup into local guest data and keeps both versions when records differ.'),err);
  const exp=element('button',{class:'subtle-btn'},'Export backup');exp.onclick=async()=>{try{download('loughdin-backup-'+localDateKey()+'.json',await store.exportJSON());}catch(e){err.textContent=e.message;}};actions.append(exp);
  const file=field(d,'Import backup','input',{type:'file',accept:'.json,application/json'});file.disabled=!!account;file.onchange=async()=>{try{const f=file.files[0];if(!f)return;if(f.size>10*1024*1024)throw Error('Backup must be smaller than 10 MB.');await store.importJSON(await f.text());state=await store.readState();render();err.textContent='Backup imported on this device.';}catch(e){err.textContent=e.message;}};
  if(account)d.insertBefore(element('p',{},'Sign out before importing into guest data.'),err);show();}
function scenery(){let index=0;const sceneEls=SCENES.map((s,i)=>{const el=element('div',{class:'scene'+(i===0?' on':'')});el.innerHTML=s.s;$('scene-stack').append(el);return el;});const set=i=>{index=(i+SCENES.length)%SCENES.length;sceneEls.forEach((el,j)=>el.classList.toggle('on',j===index));$('scene-label').textContent='Lough Guitane · '+SCENES[index].l;};$('scene-prev').onclick=()=>set(index-1);$('scene-next').onclick=()=>set(index+1);$('scene-new').onclick=()=>set(index+1+Math.floor(Math.random()*(SCENES.length-1)));set(0);
  let quote=0;const show=()=>{const q=QUOTES[quote++%QUOTES.length];for(const id of ['main-quote','zen-quote-text'])$(id).textContent=q.q;for(const id of ['main-quote-attr','zen-quote-attr'])$(id).textContent=q.a;};show();quoteInterval=setInterval(show,45000);
}
function music(){const audio=$('audio');audio.volume=.4;let current=null;document.querySelectorAll('.music-btn').forEach(b=>b.onclick=async()=>{try{if(current===b.dataset.src){audio.pause();current=null;}else{audio.src=b.dataset.src;await audio.play();current=b.dataset.src;}document.querySelectorAll('.music-btn').forEach(x=>x.classList.toggle('on',x.dataset.src===current));}catch{status('This station is unavailable. Try another station.',true);}});$('music-vol').oninput=e=>{audio.volume=Number(e.target.value)/100;};audio.addEventListener('error',()=>status('Music stream unavailable. Your timer keeps running.',true));}
function zen(on){$('app').classList.toggle('zen',on);const dock=$('music-dock');if(on)$('zen-music-dock').append(dock);
}
const musicHome=$('music-dock').parentElement;
function toggleZen(on){zen(on);if(!on)musicHome.append($('music-dock'));$(on?'zen-exit-btn':'btn-zen').focus();}
async function accountDialog(){
  const {d,err,note,actions,show}=dialog(account?'Your account':'Sign in');
  if(!client){d.insertBefore(element('p',{},'Tasks are saved on this device. Cloud sync is unavailable until the connection can open.'),err);show();return;}
  if(account){
    d.insertBefore(element('p',{},'Signed in as '+(account.email||'your account')+'. Your account data is separate from guest data.'),err);
    const importButton=element('button',{class:'subtle-btn'},'Import guest data');
    importButton.onclick=async()=>{importButton.disabled=true;let guest;try{guest=createStore({namespace:'guest'});await guest.open();const result=await sync.importGuest(await guest.readState());err.textContent='Imported '+result.tasks+' tasks, '+result.blocks+' blocks and '+result.sessions+' sessions.';await sync.flush();}catch(e){err.textContent=e.message;}finally{guest?.close();importButton.disabled=false;}};
    actions.append(importButton);
    const retry=element('button',{class:'subtle-btn'},'Sync now');retry.onclick=async()=>{try{await sync.flush();}catch(e){err.textContent=e.message;}};actions.append(retry);
    const out=element('button',{class:'subtle-btn'},'Sign out');out.onclick=async()=>{out.disabled=true;try{const result=await client.auth.signOut();if(result.error)throw result.error;d.close();}catch(e){err.textContent=e.message;out.disabled=false;}};actions.append(out);
    show();
    try{const conflicts=await sync.listConflicts();for(const conflict of conflicts){const row=element('div',{class:'sync-conflict'});row.append(element('p',{},'A change needs your choice. '+(conflict.entityType||conflict.kind||'Record')));if(conflict.reason)row.append(element('p',{class:'sync-conflict-reason'},conflict.reason));const choose=async(strategy,button)=>{button.disabled=true;try{await sync.resolveConflict(conflict.opId,{strategy});row.remove();}catch(e){err.textContent=e.message;button.disabled=false;}};const server=element('button',{class:'subtle-btn'},'Use synced version');server.onclick=()=>choose('server',server);row.append(server);const mine=element('button',{class:'subtle-btn'},'Keep mine');mine.onclick=()=>choose('local',mine);row.append(mine);d.insertBefore(row,err);}}catch(e){err.textContent=e.message;}
    return;
  }
  signedOutViews({d,err,note,actions,heading:d.querySelector('h2')});
  show();
}
/**
 * Signing in and creating an account want different things and diverge after
 * submission, so they are separate views rather than one form told apart by
 * which button was pressed. Each view owns its fields, its validation and its
 * single primary action, and waiting states use the notice line so that
 * "confirm your email" never looks like a rejected password.
 */
function signedOutViews({d,err,note,actions,heading}){
  const body=element('div',{class:'auth-body'});
  // The way across to the other view sits below the message lines, so whatever
  // the primary action just said stays next to the primary action.
  const foot=element('div',{class:'auth-foot'});
  d.insertBefore(body,err);
  d.insertBefore(foot,actions);
  const close=actions.firstElementChild;
  // The views share one error line, one notice line and one body, so a request
  // that outlives its own view would otherwise land on whichever view replaced
  // it. Each view gets a generation, and `build` receives a predicate its
  // handlers check before writing anything or switching away.
  let generation=0;
  const view=(title,build)=>{
    const mine=++generation;
    heading.textContent=title;err.textContent='';note.textContent='';
    body.replaceChildren();foot.replaceChildren();actions.replaceChildren(close);
    build(()=>mine===generation);
  };
  const say=(el,text)=>{err.textContent=el===err?text:'';note.textContent=el===note?text:'';};
  const link=(text,go)=>{const b=element('button',{class:'auth-link',type:'button'},text);b.onclick=go;return b;};
  const aside=(text,linkText,go)=>{const p=element('p',{class:'auth-aside'},text+' ');p.append(link(linkText,go));foot.append(p);};
  const authField=(label,attrs,hint)=>{
    const wrap=element('label',{},label);const input=element('input',attrs);wrap.append(input);body.append(wrap);
    if(hint)body.append(element('p',{class:'auth-hint'},hint));
    return input;
  };
  const primary=(text,run)=>{const b=element('button',{class:'t-btn t-btn-primary'},text);b.onclick=()=>run(b);actions.append(b);return b;};
  const submitOn=(input,button)=>{input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();button.click();}};};

  function signIn(prefill=''){
    view('Sign in',current=>{
      body.append(element('p',{},'Sign in to bring your tasks together across devices. Guest tasks stay here until you choose to import them.'));
      const email=authField('Email',{type:'email',autocomplete:'email',required:''});
      email.value=prefill;
      const password=authField('Password',{type:'password',autocomplete:'current-password',required:''});
      const forgot=element('p',{class:'auth-hint'});
      // Held down for the duration of the request: without it, repeated clicks
      // send repeated recovery emails and walk straight into the rate limit.
      const recovery=link('Forgot your password?',async()=>{
        if(!email.reportValidity())return;
        recovery.disabled=true;
        try{const result=await client.auth.resetPasswordForEmail(email.value.trim(),{redirectTo:authRedirectURL()});if(result.error)throw result.error;
          if(current())say(note,'If that address has an account, a recovery link is on its way.');
        }catch{if(current())say(err,'A recovery email could not be sent. Wait a moment and try again.');}
        finally{recovery.disabled=false;}
      });
      forgot.append(recovery);
      body.append(forgot);
      const go=primary('Sign in',async button=>{
        if(!email.reportValidity()||!password.reportValidity())return;
        button.disabled=true;
        try{const result=await client.auth.signInWithPassword({email:email.value.trim(),password:password.value});
          if(result.error)throw result.error;
          d.close();
        }catch(e){
          if(!current())return;
          // An unconfirmed account is a waiting state, not a bad password.
          if(/not confirmed/i.test(e.message||''))return confirmSent(email.value.trim());
          say(err,e.message);
        }finally{button.disabled=false;}
      });
      submitOn(password,go);submitOn(email,go);
      aside('New here?','Create an account',()=>signUp(email.value.trim()));
    });
  }

  function signUp(prefill=''){
    view('Create your account',current=>{
      body.append(element('p',{},'Your tasks sync across every device you sign in on. Guest tasks stay on this device until you choose to import them.'));
      const email=authField('Email',{type:'email',autocomplete:'email',required:''});
      email.value=prefill;
      const password=authField('Password',{type:'password',autocomplete:'new-password',required:''},'At least 8 characters.');
      const confirmation=authField('Confirm password',{type:'password',autocomplete:'new-password',required:''});
      const reveal=element('label',{class:'auth-reveal'});
      const box=element('input',{type:'checkbox'});
      box.onchange=()=>{for(const input of [password,confirmation])input.type=box.checked?'text':'password';};
      reveal.append(box,element('span',{},'Show what I type'));
      body.append(reveal);
      const go=primary('Create account',async button=>{
        if(!email.reportValidity())return;
        const problem=newPasswordError(password.value,confirmation.value);
        if(problem)return say(err,problem);
        button.disabled=true;
        try{const result=await client.auth.signUp({email:email.value.trim(),password:password.value,options:{emailRedirectTo:authRedirectURL()}});
          if(result.error)throw result.error;
          if(result.data.session)return d.close();
          if(current())confirmSent(email.value.trim());
        }catch(e){if(current())say(err,e.message);}finally{button.disabled=false;}
      });
      submitOn(email,go);submitOn(password,go);submitOn(confirmation,go);
      aside('Already have an account?','Sign in',()=>signIn(email.value.trim()));
    });
  }

  function confirmSent(email){
    view('Confirm your email',current=>{
      body.append(element('p',{},'A confirmation link is on its way to '+email+'. Open it, then come back here and sign in.'));
      body.append(element('p',{class:'auth-hint'},'If an account already exists for this address, the link signs you in to that one instead.'));
      // This view is reached without knowing whether the address is taken,
      // because signUp does not say. resend does: it rejects for an address
      // that is already confirmed, and rate-limits by address. Reporting
      // either outcome would give away what the view exists to keep quiet, so
      // the answer here is the same one the recovery link gives.
      primary('Resend the link',async button=>{
        button.disabled=true;
        try{await client.auth.resend({type:'signup',email,options:{emailRedirectTo:authRedirectURL()}});}catch{}
        if(current())say(note,'If that address is still waiting on confirmation, another link is on its way. It can take a minute to arrive.');
        button.disabled=false;
      });
      aside('Already confirmed?','Sign in',()=>signIn(email));
    });
  }

  signIn();
}
function syncStatus(value){
  if(typeof value==='string')return status(value);
  syncState={state:value.state,pending:value.pending||0};
  status(syncMessage(syncState.state,syncState.pending),value.state==='error'||value.state==='conflict');
  renderAccount();
}
let accountChange=Promise.resolve();
function changeAccount(user){accountChange=accountChange.then(async()=>{if(account?.id===user?.id)return;await sync?.stop();sync=null;account=user;syncState={state:user?'syncing':'local',pending:0};renderAccount();await openStore(user?'user:'+user.id:'guest');if(user){sync=createSync({store,client,onStatus:syncStatus});await sync.start();}renderAccount();});return accountChange;}
async function auth(){if(!SUPABASE_URL||!SUPABASE_PUBLISHABLE_KEY)return;const {createClient}=await import('../vendor/supabase.js');client=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});renderAccount();authSubscription=client.auth.onAuthStateChange((event,session)=>{setTimeout(()=>changeAccount(session?.user||null).then(()=>{if(event==='PASSWORD_RECOVERY')passwordRecoveryDialog();}).catch(fail),0);}).data.subscription;const {data,error}=await client.auth.getSession();if(error)throw error;if(data.session)await changeAccount(data.session.user);}
function events(){
  $('task-add-btn').onclick=action(addTask);$('task-input').onkeydown=e=>{if(e.key==='Enter')action(addTask)(e);};
  document.querySelectorAll('[data-list]').forEach(b=>b.onclick=()=>{list=b.dataset.list;render();});
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=action(()=>timerAction('mode',b.dataset.mode)));
  $('btn-start').onclick=action(()=>timerAction(state.timer.status==='running'?'pause':'start'));$('btn-reset').onclick=action(()=>timerAction('reset'));$('btn-finish').onclick=action(()=>timerAction('finish'));$('btn-interrupt').onclick=action(()=>timerAction('interrupt'));
  $('btn-settings').onclick=()=>{$('settings-pop').classList.toggle('show');$('btn-settings').setAttribute('aria-expanded',String($('settings-pop').classList.contains('show')));};
  for(const mode of ['work','short','long'])$('dur-'+mode).onchange=action(e=>save(s=>{s.settings.durations[mode]=Number(e.target.value)*60;if(s.timer.status==='idle'&&s.timer.phase===mode)s.timer=createTimer({phase:mode,durations:s.settings.durations,task:selected(s)});}));
  $('dur-goal').onchange=action(e=>save(s=>{s.settings.goal=Number(e.target.value);}));$('auto-cycle').onchange=action(e=>save(s=>{s.settings.autoCycle=e.target.checked;}));
  $('btn-zen').onclick=()=>toggleZen(true);$('zen-exit-btn').onclick=()=>toggleZen(false);document.addEventListener('keydown',e=>{if(e.key==='Escape'){toggleZen(false);$('settings-pop').classList.remove('show');}});
  $('btn-history').onclick=sessionHistory;$('btn-backup').onclick=backups;$('btn-account').onclick=accountDialog;
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){clock.resync();tick();}});window.addEventListener('pageshow',()=>{clock.resync();tick();});
}
async function serviceWorker(){if(!('serviceWorker'in navigator))return;const registration=await navigator.serviceWorker.register('sw.js');const offer=()=>{if(!registration.waiting)return;const b=element('button',{class:'subtle-btn'},'Update available · reload');b.onclick=()=>registration.waiting?.postMessage({type:'SKIP_WAITING'});document.querySelector('.account-actions').append(b);};offer();registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',offer));navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());}
setupShell();scenery();music();events();
await openStore('guest').catch(fail);await auth().catch(fail);serviceWorker().catch(()=>status('Offline installation unavailable. Your tasks are saved locally.'));
timerInterval=setInterval(tick,500);
export function disposeApp(){clearInterval(timerInterval);clearInterval(quoteInterval);sync?.stop();unsubscribe?.();store?.close();authSubscription?.unsubscribe();client?.auth.stopAutoRefresh();}
