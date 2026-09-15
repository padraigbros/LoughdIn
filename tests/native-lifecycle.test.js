/**
 * The Android app's session alarm and resume handling.
 *
 * Android can freeze the WebView mid-session, so the JS timer alone cannot
 * tell anyone a session has ended. The OS alarm has to follow the saved timer,
 * the permission prompt has to come from something the person pressed, and a
 * resumed app has to catch up with whatever was saved while it was away. None
 * of that may reach the website, which never downloads the native bundle.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createStore} from '../src/storage.js';
import {mount, stubClient, stubNative, settle} from './helpers/mount-app.mjs';

const $ = id => document.getElementById(id);

async function until(check, message = 'Expected state did not arrive') {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(message);
}

/** Mounted as the Android app, with a second handle on the same saved state. */
async function androidApp(options) {
  const native = stubNative(options);
  const harness = await mount(stubClient(), {native});
  await until(() => native.named('registerNativeLifecycle').length === 1, 'the resume listener is registered');
  const observer = createStore({namespace: 'guest'});
  await observer.open();
  /** The most recent schedule or cancel, which is what the OS is left holding. */
  const alarm = () => native.calls.filter(call => call.name.endsWith('SessionNotification')).at(-1);
  return {
    native, harness, observer, alarm,
    async dispose() { observer.close(); await harness.dispose(); },
  };
}

const scheduledFor = (app, deadlineAt) => () =>
  app.alarm()?.name === 'scheduleSessionNotification' && app.alarm().args[0] === deadlineAt;
const cleared = app => () => app.alarm()?.name === 'cancelSessionNotification';

test('launching the Android app listens for resume but never prompts for notifications', async () => {
  const app = await androidApp();
  try {
    await settle();
    assert.equal(app.native.named('requestLocalNotificationPermission').length, 0);
    assert.equal(app.native.named('scheduleSessionNotification').length, 0, 'an idle timer has nothing to announce');
  } finally { await app.dispose(); }
});

test('starting a session asks for permission from that press and schedules its end', async () => {
  const app = await androidApp();
  try {
    await $('btn-start').onclick();
    const {timer} = await app.observer.readState();
    assert.equal(timer.status, 'running');
    assert.equal(app.native.named('requestLocalNotificationPermission').length, 1);
    await until(scheduledFor(app, timer.deadlineAt), 'the alarm is set for the deadline');

    await $('btn-start').onclick();
    await $('btn-start').onclick();
    const resumed = (await app.observer.readState()).timer;
    assert.equal(resumed.status, 'running');
    await until(scheduledFor(app, resumed.deadlineAt), 'resuming sets the alarm for the new deadline');
    assert.equal(app.native.named('requestLocalNotificationPermission').length, 1, 'asked once per launch');
  } finally { await app.dispose(); }
});

test('pausing, finishing or resetting a session clears its alarm', async () => {
  const app = await androidApp();
  try {
    await $('btn-start').onclick();
    await until(() => app.alarm()?.name === 'scheduleSessionNotification');
    await $('btn-start').onclick();
    assert.equal((await app.observer.readState()).timer.status, 'paused');
    await until(cleared(app), 'pause clears the alarm');

    await $('btn-start').onclick();
    await until(() => app.alarm()?.name === 'scheduleSessionNotification');
    await $('btn-finish').onclick();
    assert.equal((await app.observer.readState()).timer.status, 'complete');
    await until(cleared(app), 'finish clears the alarm');

    await $('btn-start').onclick();
    await until(() => app.alarm()?.name === 'scheduleSessionNotification');
    await $('btn-reset').onclick();
    assert.equal((await app.observer.readState()).timer.status, 'idle');
    await until(cleared(app), 'reset clears the alarm');
  } finally { await app.dispose(); }
});

test('returning to the app re-reads the saved state and redraws the timer', async () => {
  const app = await androidApp();
  try {
    // Saved behind the app's back, as a frozen WebView would leave it.
    await app.observer.mutate(s => {
      s.settings.durations.work = 7 * 60;
      s.timer = {...s.timer, durationMs: 7 * 60000, remainingMs: 7 * 60000};
    });
    assert.notEqual($('timer-display').textContent, '07:00');

    await app.native.resume();
    assert.equal($('timer-display').textContent, '07:00');
    assert.equal($('dur-work').value, '7');
  } finally { await app.dispose(); }
});

test('a session that ended while the app was away completes on resume and clears its alarm', async () => {
  const app = await androidApp();
  try {
    await $('btn-start').onclick();
    await until(() => app.alarm()?.name === 'scheduleSessionNotification');
    await app.observer.mutate(s => { s.timer = {...s.timer, deadlineAt: Date.now() - 5000}; });

    await app.native.resume();
    await until(async () => (await app.observer.readState()).sessions.length === 1, 'the session is recorded');
    assert.equal((await app.observer.readState()).sessions[0].outcome, 'completed');
    await until(cleared(app), 'completion clears the alarm');
  } finally { await app.dispose(); }
});

test('the website never loads or calls the native bundle', async () => {
  const native = stubNative();
  const harness = await mount(stubClient(), {native, nativePlatform: false});
  try {
    await settle();
    await $('btn-start').onclick();
    await $('btn-start').onclick();
    await $('btn-finish').onclick();
    harness.hide(true);
    harness.hide(false);
    await settle();
    assert.deepEqual(native.calls, []);
  } finally { await harness.dispose(); }
});
