// Pure timer transitions. Redraws never change or persist elapsed time.
export const DEFAULT_DURATIONS = Object.freeze({work:1200,short:300,long:900});
export function createTimer({phase='work',durations=DEFAULT_DURATIONS,task=null,id=crypto.randomUUID(),now=Date.now(),cycles=0}={}) {
  const flow=phase==='flow';
  return {id,phase,status:'idle',durationMs:flow?null:durations[phase]*1000,
    remainingMs:flow?null:durations[phase]*1000,deadlineAt:null,segmentStartedAt:null,
    elapsedMs:0,startedAt:null,endedAt:null,task:task?{...task}:null,cycles,
    interruptions:0,revision:0,updatedAt:now};
}
export function elapsedMs(timer,now=Date.now()) {
  if(!timer)return 0;
  const segment=timer.status==='running'?Math.max(0,now-timer.segmentStartedAt):0;
  const elapsed=timer.elapsedMs+segment;
  return timer.durationMs===null?elapsed:Math.min(timer.durationMs,elapsed);
}
export function remainingMs(timer,now=Date.now()) {
  if(!timer)return 0;
  if(timer.durationMs===null)return null;
  return timer.status==='running'?Math.max(0,timer.deadlineAt-now):Math.max(0,timer.remainingMs);
}
export function timerDisplay(timer,now=Date.now()) {
  const seconds=timer?.phase==='flow'?Math.floor(elapsedMs(timer,now)/1000):Math.ceil(remainingMs(timer,now)/1000);
  return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
}
export function transition(timer,action,now=Date.now()) {
  if(!timer)throw new Error('Timer is not initialized');
  const t={...timer};
  if(action==='start') {
    if(t.status==='running'||t.status==='complete')return timer;
    t.status='running';t.startedAt??=now;t.segmentStartedAt=now;
    t.deadlineAt=t.durationMs===null?null:now+t.remainingMs;
  } else if(action==='pause'||action==='interrupt') {
    if(t.status!=='running')return timer;
    t.elapsedMs=elapsedMs(t,now);t.remainingMs=remainingMs(t,now);
    t.status='paused';t.segmentStartedAt=null;t.deadlineAt=null;
    if(action==='interrupt')t.interruptions++;
  } else if(action==='finish'||action==='due') {
    if(t.status==='complete'||t.status==='idle')return timer;
    if(action==='due'&&(t.status!=='running'||t.durationMs===null||remainingMs(t,now)>0))return timer;
    t.elapsedMs=elapsedMs(t,now);t.remainingMs=remainingMs(t,now);
    t.endedAt=action==='due'?t.deadlineAt:now;
    t.status='complete';t.segmentStartedAt=null;t.deadlineAt=null;
  } else throw new Error('Unknown timer action');
  t.revision++;t.updatedAt=now;return t;
}
export function sessionFromTimer(timer) {
  if(!timer||timer.status!=='complete'||!timer.startedAt||!['work','flow'].includes(timer.phase))return null;
  return {id:timer.id,taskId:timer.task?.id??null,list:timer.task?.list??null,
    taskText:timer.task?.text??'',mode:timer.phase==='flow'?'flow':'pomodoro',
    startedAt:timer.startedAt,endedAt:timer.endedAt,focusMs:timer.elapsedMs,
    interruptions:timer.interruptions,
    outcome:timer.phase==='flow'||timer.remainingMs===0?'completed':'partial'};
}
export function nextAutomaticPhase(timer,{autoCycle=false,maxCycles=4}={}) {
  if(!autoCycle||timer.status!=='complete'||timer.phase==='flow')return null;
  if(timer.phase==='work'&&timer.remainingMs===0)return (timer.cycles+1)%4===0?'long':'short';
  if(['short','long'].includes(timer.phase)&&timer.remainingMs===0&&timer.cycles<maxCycles)return 'work';
  return null;
}
export function localDateKey(instant=Date.now()) {
  const d=new Date(instant);
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
export function dailyStats(sessions,now=Date.now()) {
  const today=localDateKey(now);const unique=new Map(sessions.map(s=>[s.id,s]));
  const entries=[...unique.values()].filter(s=>localDateKey(s.endedAt)===today);
  return {pomodoros:entries.filter(s=>s.mode==='pomodoro'&&s.outcome==='completed').length,
    focusMs:entries.reduce((sum,s)=>sum+Math.max(0,s.focusMs||0),0)};
}
export function weekStats(sessions,now=Date.now()) {
  const day=new Date(now);day.setHours(12,0,0,0);day.setDate(day.getDate()-((day.getDay()+6)%7));
  return Array.from({length:7},(_,i)=>{const date=new Date(day);date.setDate(date.getDate()+i);
    return {date:localDateKey(date),...dailyStats(sessions,date.getTime())};});
}
export function createClock(wallNow=()=>Date.now(),monotonicNow=()=>performance.now()) {
  let wall=wallNow(),mono=monotonicNow();
  return {now:()=>wall+Math.max(0,monotonicNow()-mono),resync(){wall=wallNow();mono=monotonicNow();}};
}
