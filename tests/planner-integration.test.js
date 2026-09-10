import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rangeForDate,dateFromKey,validateBlock,blocksForRange,fromLocalInputs} from '../src/planner.js';

test('the planning day starts at midnight and includes morning blocks',()=>{
  const {start,end}=rangeForDate(dateFromKey('2026-09-09'),'day');
  assert.equal(start.getHours(),0);assert.equal(end.getHours(),0);
  const morning={id:'a',taskId:'t',startAt:new Date(2026,8,9,9).toISOString(),endAt:new Date(2026,8,9,10).toISOString()};
  assert.equal(blocksForRange([morning],start,end).length,1);
});
test('deleted and cancelled blocks do not reserve or display time',()=>{
  const block={id:'a',taskId:'t',startAt:'2026-09-09T09:00Z',endAt:'2026-09-09T09:30Z'};
  const removed={...block,id:'b',deletedAt:'2026-09-08T10:00Z'};
  assert.equal(validateBlock(block,[removed]).ok,true);
  assert.deepEqual(blocksForRange([removed], '2026-09-09T00:00Z','2026-09-10T00:00Z'),[]);
});
test('local inputs reject a daylight-saving time that does not exist',()=>{
  const prior=process.env.TZ;process.env.TZ='Europe/Dublin';
  try{assert.throws(()=>fromLocalInputs('2026-03-29','01:30'),/Invalid local date/);}
  finally{if(prior===undefined)delete process.env.TZ;else process.env.TZ=prior;}
});
