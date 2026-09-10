import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addLocalDays,
  blocksForRange,
  dateFromKey,
  fromLocalInputs,
  intervalsOverlap,
  localDateKey,
  rangeForDate,
  snapMinutes,
  toLocalInputParts,
  validateBlock,
} from '../src/planner.js';

test('snapMinutes rounds to a five-minute grid and stays inside a day', () => {
  assert.equal(snapMinutes(2), 0);
  assert.equal(snapMinutes(3), 5);
  assert.equal(snapMinutes(62), 60);
  assert.equal(snapMinutes(1439), 1440);
  assert.equal(snapMinutes(-10), 0);
});

test('half-open intervals allow adjacent blocks and reject real overlap', () => {
  const first = { startAt: '2026-09-08T09:00:00.000Z', endAt: '2026-09-08T09:30:00.000Z' };
  const adjacent = { startAt: '2026-09-08T09:30:00.000Z', endAt: '2026-09-08T10:00:00.000Z' };
  const overlapping = { startAt: '2026-09-08T09:29:59.000Z', endAt: '2026-09-08T10:00:00.000Z' };
  assert.equal(intervalsOverlap(first, adjacent), false);
  assert.equal(intervalsOverlap(first, overlapping), true);
});

test('validateBlock checks task linkage, duration and existing reservations', () => {
  const existing = { id: 'old', taskId: 'task-a', startAt: '2026-09-08T09:00:00.000Z', endAt: '2026-09-08T09:30:00.000Z' };
  assert.equal(validateBlock({ id: 'new', taskId: 'task-b', startAt: '2026-09-08T09:30:00.000Z', endAt: '2026-09-08T10:00:00.000Z' }, [existing]).ok, true);
  assert.equal(validateBlock({ id: 'new', taskId: 'task-b', startAt: '2026-09-08T09:15:00.000Z', endAt: '2026-09-08T10:00:00.000Z' }, [existing]).error, 'That time overlaps another block.');
  assert.equal(validateBlock({ id: 'new', taskId: '', startAt: '2026-09-08T11:00:00.000Z', endAt: '2026-09-08T11:05:00.000Z' }).ok, false);
});

test('local day and week ranges use calendar days', () => {
  const date = dateFromKey('2026-09-09');
  assert.equal(localDateKey(date), '2026-09-09');
  assert.equal(localDateKey(addLocalDays(date, 1)), '2026-09-10');
  const day = rangeForDate(date, 'day');
  assert.equal(localDateKey(day.start), '2026-09-09');
  assert.equal(localDateKey(day.end), '2026-09-10');
  const week = rangeForDate(date, 'week');
  assert.equal(localDateKey(week.start), '2026-09-07');
  assert.equal(localDateKey(week.end), '2026-09-14');
});

test('blocksForRange includes blocks crossing the window start', () => {
  const blocks = [
    { id: 'crossing', startAt: '2026-09-07T23:50:00.000Z', endAt: '2026-09-08T00:20:00.000Z' },
    { id: 'after', startAt: '2026-09-08T01:00:00.000Z', endAt: '2026-09-08T01:30:00.000Z' },
    { id: 'before', startAt: '2026-09-07T22:00:00.000Z', endAt: '2026-09-07T23:00:00.000Z' },
  ];
  const visible = blocksForRange(blocks, '2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  assert.deepEqual(visible.map(block => block.id), ['crossing', 'after']);
});

test('local input parts round-trip a valid wall time', () => {
  const value = fromLocalInputs('2026-09-08', '09:05');
  assert.deepEqual(toLocalInputParts(value), { date: '2026-09-08', time: '09:05' });
  assert.throws(() => fromLocalInputs('2026-02-30', '09:00'), /Invalid local date/);
});
