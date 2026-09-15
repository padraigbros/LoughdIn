import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createGoogleNonce} from '../src/google-nonce.js';
import {mount, stubClient} from './helpers/mount-app.mjs';

const dialogOf = () => document.querySelector('dialog[open]');
const googleButton = () => dialogOf().querySelector('.t-btn-google');
const callsNamed = (client, name) => client.calls.filter(call => call.name === name);

test('the nonce sent to Google is the SHA-256 hex of the one sent to Supabase', async () => {
  const first = await createGoogleNonce();
  const second = await createGoogleNonce();
  assert.equal(first.hashed, createHash('sha256').update(first.raw).digest('hex'));
  assert.equal(Buffer.from(first.raw, 'base64').length, 32);
  assert.notEqual(first.raw, second.raw, 'every sign-in gets a fresh nonce');
});

test('the Android app signs in with a Google ID token instead of redirecting', async () => {
  const requests = [];
  const native = {signInWithGoogleNative: async options => { requests.push(options); return {idToken: 'google-id-token', nonce: 'raw-nonce'}; }};
  const client = stubClient();
  const harness = await mount(client, {native});
  try {
    await document.getElementById('btn-account').onclick();
    await googleButton().onclick();
    assert.deepEqual(requests, [{webClientId: 'stub-web-client.apps.googleusercontent.com'}]);
    assert.deepEqual(callsNamed(client, 'signInWithIdToken').map(call => call.args[0]),
      [{provider: 'google', token: 'google-id-token', nonce: 'raw-nonce'}]);
    assert.equal(callsNamed(client, 'signInWithOAuth').length, 0, 'no browser redirect inside the app');
    assert.equal(dialogOf(), null, 'the dialog closes once Supabase accepts the token');
  } finally { await harness.dispose(); }
});

test('a cancelled Android account sheet leaves the dialog open and the button usable', async () => {
  const native = {signInWithGoogleNative: async () => { throw new Error('User cancelled the sign-in flow.'); }};
  const client = stubClient();
  const harness = await mount(client, {native});
  try {
    await document.getElementById('btn-account').onclick();
    const button = googleButton();
    await button.onclick();
    assert.ok(dialogOf(), 'the dialog stays open');
    assert.match(dialogOf().textContent, /User cancelled the sign-in flow\./);
    assert.equal(button.disabled, false);
    assert.equal(callsNamed(client, 'signInWithIdToken').length, 0);
  } finally { await harness.dispose(); }
});

test('the website keeps the Google redirect and never loads the native bridge', async () => {
  const client = stubClient();
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    await googleButton().onclick();
    const [redirect] = callsNamed(client, 'signInWithOAuth').map(call => call.args[0]);
    assert.equal(redirect.provider, 'google');
    assert.equal(redirect.options.redirectTo, 'https://app.example.test/LoughdIn/');
    assert.equal(callsNamed(client, 'signInWithIdToken').length, 0);
  } finally { await harness.dispose(); }
});
