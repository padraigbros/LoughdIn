/**
 * How a shipped release reaches someone already running an older one.
 *
 * The worker never calls skipWaiting on itself, so a new one parks in the
 * waiting state while the old one keeps serving the shell from its own cache.
 * Reloading does not dislodge it, which is what turned a shipped feature into
 * one the person could not see at any number of refreshes. Taking an update
 * costs a reload, so these cases pin down what that reload is allowed to
 * interrupt.
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mount, stubClient, stubServiceWorker, settle} from './helpers/mount-app.mjs';

const SKIP_WAITING = {type: 'SKIP_WAITING'};
const updateOffers = () => [...document.querySelectorAll('.account-actions button')]
  .filter(b => b.textContent.startsWith('Update ready'));

/** Mounted, settled, and controlled by an older worker unless told otherwise. */
async function app({waiting = false, controlled = true} = {}) {
  const worker = stubServiceWorker({waiting, controlled});
  const harness = await mount(stubClient(), {serviceWorker: worker.container});
  await settle();
  return {worker, harness};
}

test('an update downloaded before the page opened is taken without being asked', async () => {
  const {worker, harness} = await app({waiting: true});
  try {
    assert.deepEqual(worker.posted, [SKIP_WAITING], 'the waiting worker is told to take over');
    assert.deepEqual(updateOffers(), [], 'nothing to ask, so nothing is put in front of anyone');

    worker.claim();
    assert.equal(harness.reloads.length, 1, 'and the page reloads onto it');
  } finally { await harness.dispose(); }
});

test('an update landing seconds after a page opens interrupts nothing, so it is taken', async () => {
  const {worker, harness} = await app();
  try {
    // The ordinary case: the check that register() starts finishes just after
    // the page has drawn. Treating that as mid-session is what left a reload
    // unable to deliver a release.
    worker.installUpdate();
    assert.deepEqual(worker.posted, [SKIP_WAITING]);
    assert.deepEqual(updateOffers(), []);
  } finally { await harness.dispose(); }
});

test('a first install claims the page without reloading it', async () => {
  const {worker, harness} = await app({controlled: false});
  try {
    assert.deepEqual(worker.posted, [], 'there is no older worker to replace');

    // activate() calls clients.claim(), which fires controllerchange on a page
    // that had no controller. Reloading there would refresh a page already
    // showing the only version there is.
    worker.claim();
    assert.equal(harness.reloads.length, 0, 'a fresh install is not a reason to reload');
  } finally { await harness.dispose(); }
});

test('someone already using the page is asked rather than interrupted', async () => {
  const {worker, harness} = await app();
  try {
    harness.touch();
    worker.installUpdate();

    assert.deepEqual(worker.posted, [], 'the page is not pulled out from under them');
    assert.equal(updateOffers().length, 1, 'it is offered instead');

    updateOffers()[0].onclick();
    assert.deepEqual(worker.posted, [SKIP_WAITING], 'and taken when asked for');
  } finally { await harness.dispose(); }
});

test('an offered update takes itself once the page is switched away from', async () => {
  const {worker, harness} = await app();
  try {
    harness.touch();
    worker.installUpdate();
    assert.deepEqual(worker.posted, []);

    harness.hide();
    assert.deepEqual(worker.posted, [SKIP_WAITING], 'switching away is a moment a reload costs nothing');
  } finally { await harness.dispose(); }
});

test('a task half typed is not thrown away by an update taking itself', async () => {
  const {worker, harness} = await app();
  try {
    // Everything else the app holds is durable. Text in the task box is the one
    // thing a reload destroys outright, so it holds an update off even unseen.
    document.getElementById('task-input').value = 'Ring the dentist';
    worker.installUpdate();
    assert.deepEqual(worker.posted, [], 'not while it is still being written');

    harness.hide();
    assert.deepEqual(worker.posted, [], 'and not behind their back either');

    document.getElementById('task-input').value = '';
    harness.hide();
    assert.deepEqual(worker.posted, [SKIP_WAITING], 'the update lands once it is gone');
  } finally { await harness.dispose(); }
});

test('an open dialog is a place to lose, so it holds an update off while watched', async () => {
  const {worker, harness} = await app();
  try {
    await document.getElementById('btn-account').onclick();
    worker.installUpdate();
    assert.deepEqual(worker.posted, [], 'not out from under an open dialog');

    // Switching away is different: nothing is being read, and nothing typed
    // here is lost, so the update goes ahead.
    harness.hide();
    assert.deepEqual(worker.posted, [SKIP_WAITING]);
  } finally { await harness.dispose(); }
});

test('a session under way is not interrupted by an update, but survives one', async () => {
  const {worker, harness} = await app();
  try {
    await document.getElementById('btn-start').onclick();
    await settle();
    assert.equal(document.getElementById('btn-start').textContent, 'Ⅱ Pause', 'the session is running');

    worker.installUpdate();
    assert.deepEqual(worker.posted, [], 'nobody deep in a session wants the page to blink');
    assert.equal(updateOffers().length, 1, 'it waits to be asked for');

    // A session is durable and resumes from the clock, so switching away makes
    // the reload free even with one under way.
    harness.hide();
    assert.deepEqual(worker.posted, [SKIP_WAITING]);
  } finally { await harness.dispose(); }
});

test('the offer is made once however many times the worker changes state', async () => {
  const {worker, harness} = await app();
  try {
    harness.touch();
    worker.installUpdate();
    worker.installUpdate();
    assert.equal(updateOffers().length, 1, 'one update is one offer');
  } finally { await harness.dispose(); }
});

test('the waiting worker is told once however often the moment is reconsidered', async () => {
  const {worker, harness} = await app();
  try {
    harness.touch();
    worker.installUpdate();
    harness.hide();
    harness.hide(false);
    harness.hide();
    assert.deepEqual(worker.posted, [SKIP_WAITING], 'one update is one message');
  } finally { await harness.dispose(); }
});

test('the page reloads once even if the worker changes hands more than once', async () => {
  const {worker, harness} = await app({waiting: true});
  try {
    worker.claim();
    worker.claim();
    assert.equal(harness.reloads.length, 1, 'a reload loop would be worse than a stale page');
  } finally { await harness.dispose(); }
});
