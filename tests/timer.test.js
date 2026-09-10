import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimer,transition,remainingMs,elapsedMs,sessionFromTimer,nextAutomaticPhase,createClock,weekStats,dailyStats} from '../src/timer.js';
const make=()=>createTimer({id:'session-one',now:1000,task:{id:'task-one',list:'work'},durations:{work:1200,short:300,long:900}});
test('reload reconstructs remaining time without counting callbacks',()=>{
  const started=transition(make(),'start',1000);
  const restored=JSON.parse(JSON.stringify(started));
  assert.equal(remainingMs(restored,601000),600000);
  assert.equal(elapsedMs(restored,601000),600000);
});
test('pause excludes time spent paused and resumes the remaining interval',()=>{
  let t=transition(make(),'start',1000);t=transition(t,'pause',301000);
  assert.equal(remainingMs(t,901000),900000);
  t=transition(t,'start',901000);assert.equal(t.deadlineAt,1801000);
  t=transition(t,'due',1801000);assert.equal(t.elapsedMs,1200000);
});
test('completion is idempotent; Start cannot award another completed interval',()=>{
  const t=transition(transition(make(),'start',1000),'due',1201000);
  assert.equal(transition(t,'due',1300000),t);
  assert.equal(transition(t,'start',1300000),t);
  assert.equal(sessionFromTimer(t).id,'session-one');
  assert.equal(t.remainingMs,0);
});
test('late wakeup caps credited work at intended interval and original boundary',()=>{
  const t=transition(transition(make(),'start',1000),'due',99999999);
  assert.equal(t.elapsedMs,1200000);assert.equal(t.endedAt,1201000);
});
test('reset/finish produces partial session instead of false completion',()=>{
  const t=transition(transition(make(),'start',1000),'finish',301000);
  assert.equal(sessionFromTimer(t).outcome,'partial');assert.equal(sessionFromTimer(t).focusMs,300000);
  assert.equal(nextAutomaticPhase(t,{autoCycle:true}),null);
});
test('Flow logs elapsed segments; interrupt pauses and counts once',()=>{
  let t=createTimer({phase:'flow',id:'flow',now:1000});t=transition(t,'start',1000);
  t=transition(t,'interrupt',61000);t=transition(t,'interrupt',62000);
  assert.equal(t.interruptions,1);t=transition(t,'start',121000);t=transition(t,'finish',181000);
  assert.equal(sessionFromTimer(t).focusMs,120000);assert.equal(sessionFromTimer(t).mode,'flow');
});
test('auto cycle is explicit and bounded, with every fourth focus a long break',()=>{
  let t=transition(transition(make(),'start',1000),'due',1201000);
  assert.equal(nextAutomaticPhase(t),null);assert.equal(nextAutomaticPhase(t,{autoCycle:true}),'short');
  assert.equal(nextAutomaticPhase({...t,cycles:3},{autoCycle:true}),'long');
  assert.equal(nextAutomaticPhase({...t,phase:'long',cycles:4},{autoCycle:true}),null);
});
test('monotonic clock ignores wall-clock edits while process remains active',()=>{
  let wall=1000,mono=0;const clock=createClock(()=>wall,()=>mono);
  wall+=600000;mono=1000;assert.equal(clock.now(),2000);
  clock.resync();assert.equal(clock.now(),601000);
});
test('weekly stats use dates, deduplicate IDs, and do not move Tuesday to Sunday',()=>{
  const now=new Date(2026,8,8,12).getTime();
  const s={id:'one',endedAt:now,focusMs:1200000,mode:'pomodoro',outcome:'completed'};
  const week=weekStats([s,s],now);
  assert.equal(week[1].date,'2026-09-08');assert.equal(week[1].pomodoros,1);assert.equal(week[6].pomodoros,0);
  assert.equal(dailyStats([s],new Date(2026,8,9,12).getTime()).pomodoros,0);
});
