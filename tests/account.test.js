import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {build} from 'esbuild';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mounts = 0;

// The signed-out journey is all client calls, so the app is mounted over a
// stub Supabase client and the replies are set per test.
function stubClient(replies = {}) {
  const calls = [];
  const record = (name, fallback) => async (...args) => {
    calls.push({name, args});
    return (replies[name] ? await replies[name](...args) : fallback);
  };
  return {
    calls,
    auth: {
      onAuthStateChange: () => ({data: {subscription: {unsubscribe() {}}}}),
      getSession: async () => ({data: {session: null}, error: null}),
      stopAutoRefresh() {},
      signInWithPassword: record('signInWithPassword', {data: {session: {}}, error: null}),
      signUp: record('signUp', {data: {session: null, user: {}}, error: null}),
      resend: record('resend', {error: null}),
      resetPasswordForEmail: record('resetPasswordForEmail', {error: null}),
      signOut: record('signOut', {error: null}),
    },
  };
}

async function mount(client) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'),
    {url: 'https://app.example.test/LoughdIn/', pretendToBeVisual: true});
  const originals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, localStorage: dom.window.localStorage, Option: dom.window.Option,
    indexedDB: new IDBFactory(), BroadcastChannel: undefined,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  const bundle = await build({
    absWorkingDir: appRoot, entryPoints: ['src/app.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022',
    plugins: [{
      name: 'account-fixture',
      setup(builder) {
        builder.onResolve({filter: /config\.js$/}, () => ({path: 'config', namespace: 'fixture'}));
        builder.onResolve({filter: /vendor\/supabase\.js$/}, () => ({path: 'supabase', namespace: 'fixture'}));
        builder.onLoad({filter: /.*/, namespace: 'fixture'}, args => ({
          contents: args.path === 'config'
            ? "export const SUPABASE_URL='https://stub.test';export const SUPABASE_PUBLISHABLE_KEY='stub-key';"
            : 'export const createClient=()=>globalThis.__stubClient;',
          loader: 'js',
        }));
      },
    }],
  });
  globalThis.__stubClient = client;
  // Identical sources would resolve to one data: URL and Node would hand back
  // the cached module, so the second mount would never build its own DOM.
  const source = bundle.outputFiles[0].text + `\n//${mounts++}\n`;
  const app = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return {
    app,
    window: dom.window,
    async dispose() {
      await app.disposeApp();
      dom.window.close();
      delete globalThis.__stubClient;
      for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
      }
    },
  };
}

const dialogOf = () => document.querySelector('dialog[open]');
const primaryOf = () => dialogOf().querySelector('.dialog-actions .t-btn-primary');
const linkNamed = text => [...dialogOf().querySelectorAll('.auth-link')].find(b => b.textContent === text);
const fieldNamed = label => [...dialogOf().querySelectorAll('.auth-body label')]
  .find(l => l.textContent.startsWith(label)).querySelector('input');
const textOf = selector => dialogOf().querySelector(selector).textContent;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the account control sits beside settings and reports sync without being opened', async () => {
  const harness = await mount(stubClient());
  try {
    const button = document.getElementById('btn-account');
    assert.ok(button, 'the control exists');
    assert.equal(button.parentElement.className, 'brand-actions', 'it lives in the top right');
    assert.equal(button.nextElementSibling.id, 'btn-settings', 'next to settings');
    assert.ok(!document.querySelector('.account-actions #btn-account'), 'and no longer in the footer');
    assert.match(button.getAttribute('aria-label'), /Not signed in/, 'guest state is legible at a glance');

    // The sync state a signed-in person needs at a glance, without the DOM.
    const {accountSummary} = harness.app;
    const account = {email: 'aoife@example.test'};
    assert.deepEqual(accountSummary(null), {
      initial: '', tone: 'idle', badge: '',
      title: 'Not signed in. Tasks stay on this device. Open to sign in and sync across devices.',
    });
    assert.deepEqual(accountSummary(account, {state: 'synced'}), {
      initial: 'A', tone: 'ok', badge: '', title: 'aoife@example.test · All changes synced',
    });
    const pending = accountSummary(account, {state: 'pending', pending: 3});
    assert.equal(pending.badge, '3', 'unsent work is counted on the control');
    assert.equal(pending.title, 'aoife@example.test · Saved on this device · 3 changes pending');
    assert.equal(accountSummary(account, {state: 'conflict'}).badge, '!');
    assert.equal(accountSummary(account, {state: 'conflict'}).tone, 'alert');
    assert.equal(accountSummary(account, {state: 'pending', pending: 40}).badge, '9', 'the badge stays one character');
  } finally { await harness.dispose(); }
});

test('signing in is the default view, with one primary action and recovery under the password', async () => {
  const client = stubClient();
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    assert.equal(textOf('h2'), 'Sign in');
    assert.equal(primaryOf().textContent, 'Sign in');
    assert.equal(dialogOf().querySelectorAll('.dialog-actions button').length, 2, 'Close and one primary, nothing else');
    assert.ok(!linkNamed('Create an account').closest('.dialog-actions'), 'creating an account is a link, not a peer button');

    const password = fieldNamed('Password');
    const recovery = linkNamed('Forgot your password?');
    assert.ok(password.closest('label').nextElementSibling.contains(recovery), 'recovery sits under the password field');

    fieldNamed('Email').value = 'aoife@example.test';
    password.value = 'correct-horse';
    await primaryOf().onclick();
    await settle();
    assert.deepEqual(client.calls.map(c => c.name), ['signInWithPassword']);
    assert.deepEqual(client.calls[0].args[0], {email: 'aoife@example.test', password: 'correct-horse'});
    assert.equal(document.querySelector('dialog[open]'), null, 'a session closes the dialog');
  } finally { await harness.dispose(); }
});

test('creating an account is its own view, keeps the address typed, and states its rules', async () => {
  const client = stubClient();
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'newcomer@example.test';
    linkNamed('Create an account').onclick();

    assert.equal(textOf('h2'), 'Create your account');
    assert.equal(primaryOf().textContent, 'Create account');
    assert.equal(fieldNamed('Email').value, 'newcomer@example.test', 'the address carries across');
    assert.match(textOf('.auth-hint'), /At least 8 characters/, 'the rule is stated before submitting');

    const password = fieldNamed('Password');
    const confirmation = fieldNamed('Confirm password');
    assert.ok(confirmation, 'a password never typed before is asked for twice');

    password.value = confirmation.value = 'short';
    await primaryOf().onclick();
    assert.equal(textOf('.dialog-error'), 'Use at least 8 characters.');
    assert.deepEqual(client.calls, [], 'nothing is sent until it is valid');

    password.value = 'long-enough-one';
    confirmation.value = 'long-enough-two';
    await primaryOf().onclick();
    assert.equal(textOf('.dialog-error'), 'Passwords do not match.');
    assert.deepEqual(client.calls, []);

    const reveal = dialogOf().querySelector('.auth-reveal input');
    reveal.checked = true;
    reveal.onchange();
    assert.equal(password.type, 'text', 'what is typed can be shown');
    assert.equal(confirmation.type, 'text');
  } finally { await harness.dispose(); }
});

test('a created account waits on confirmation, said calmly rather than in the error line', async () => {
  const client = stubClient();
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    linkNamed('Create an account').onclick();
    fieldNamed('Email').value = 'newcomer@example.test';
    fieldNamed('Password').value = fieldNamed('Confirm password').value = 'long-enough-one';
    await primaryOf().onclick();
    await settle();

    assert.equal(client.calls[0].name, 'signUp');
    assert.equal(client.calls[0].args[0].options.emailRedirectTo, 'https://app.example.test/LoughdIn/');
    assert.equal(textOf('h2'), 'Confirm your email');
    assert.match(dialogOf().querySelector('.auth-body p').textContent, /newcomer@example\.test/);
    assert.equal(textOf('.dialog-error'), '', 'waiting is not a failure');

    assert.equal(primaryOf().textContent, 'Resend the link');
    await primaryOf().onclick();
    await settle();
    assert.equal(client.calls[1].name, 'resend');
    assert.deepEqual(client.calls[1].args[0].type, 'signup');
    assert.match(textOf('.dialog-notice'), /another link is on its way/);
    assert.equal(textOf('.dialog-error'), '');

    linkNamed('Sign in').onclick();
    assert.equal(textOf('h2'), 'Sign in');
    assert.equal(fieldNamed('Email').value, 'newcomer@example.test');
  } finally { await harness.dispose(); }
});

test('an unconfirmed sign-in becomes the waiting state instead of a rejected password', async () => {
  const client = stubClient({
    signInWithPassword: async () => ({error: Object.assign(new Error('Email not confirmed'), {})}),
  });
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'waiting@example.test';
    fieldNamed('Password').value = 'correct-horse';
    await primaryOf().onclick();
    await settle();
    assert.equal(textOf('h2'), 'Confirm your email');
    assert.equal(textOf('.dialog-error'), '');
  } finally { await harness.dispose(); }
});

test('resending says the same thing whether or not the address is already taken', async () => {
  // resend, unlike signUp, rejects for an address that is already confirmed.
  const outcomes = [];
  for (const reply of [async () => ({error: null}),
    async () => ({error: new Error('A user with this email address has already been registered')}),
    async () => { throw new Error('For security purposes, you can only request this after 54 seconds'); }]) {
    const harness = await mount(stubClient({resend: reply}));
    try {
      await document.getElementById('btn-account').onclick();
      linkNamed('Create an account').onclick();
      fieldNamed('Email').value = 'taken@example.test';
      fieldNamed('Password').value = fieldNamed('Confirm password').value = 'long-enough-one';
      await primaryOf().onclick();
      await settle();
      await primaryOf().onclick();
      await settle();
      outcomes.push({notice: textOf('.dialog-notice'), error: textOf('.dialog-error')});
    } finally { await harness.dispose(); }
  }
  assert.equal(outcomes[0].error, '', 'nothing the provider said reaches the person');
  assert.deepEqual(outcomes[1], outcomes[0], 'an address already registered looks identical');
  assert.deepEqual(outcomes[2], outcomes[0], 'so does being rate limited');
});

test('the recovery link is held down while its request is in flight', async () => {
  let release;
  const client = stubClient({
    resetPasswordForEmail: () => new Promise(resolve => { release = () => resolve({error: null}); }),
  });
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'aoife@example.test';
    const recovery = linkNamed('Forgot your password?');
    const pending = recovery.onclick();
    await settle();
    assert.equal(recovery.disabled, true, 'a second click cannot send a second email');
    release();
    await pending;
    assert.equal(recovery.disabled, false);
    assert.equal(client.calls.filter(c => c.name === 'resetPasswordForEmail').length, 1);
  } finally { await harness.dispose(); }
});

test('a reply that arrives after the view has moved on is not shown on the new view', async () => {
  let reject;
  const client = stubClient({
    signInWithPassword: () => new Promise((resolve, r) => { reject = () => r(new Error('Invalid login credentials')); }),
  });
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'aoife@example.test';
    fieldNamed('Password').value = 'wrong';
    const pending = primaryOf().onclick();
    await settle();
    linkNamed('Create an account').onclick();          // switch away mid-request
    fieldNamed('Password').value = 'half-typed';
    reject();
    await pending;
    assert.equal(textOf('h2'), 'Create your account', 'the view the person is on is left alone');
    assert.equal(textOf('.dialog-error'), '', 'and the stale error is dropped');
    assert.equal(fieldNamed('Password').value, 'half-typed', 'what they had typed survives');
  } finally { await harness.dispose(); }
});

test('an unconfirmed sign-in does not replace a view the person has since left', async () => {
  let reject;
  const client = stubClient({
    signInWithPassword: () => new Promise((resolve, r) => { reject = () => r(new Error('Email not confirmed')); }),
  });
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'waiting@example.test';
    fieldNamed('Password').value = 'correct-horse';
    const pending = primaryOf().onclick();
    await settle();
    linkNamed('Create an account').onclick();
    reject();
    await pending;
    assert.equal(textOf('h2'), 'Create your account', 'the sign-up form is not torn down underneath them');
  } finally { await harness.dispose(); }
});

test('Enter submits from every field on both forms', async () => {
  const client = stubClient();
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    for (const label of ['Email', 'Password']) assert.ok(fieldNamed(label).onkeydown, 'sign in: ' + label);
    linkNamed('Create an account').onclick();
    for (const label of ['Email', 'Password', 'Confirm password']) {
      assert.ok(fieldNamed(label).onkeydown, 'sign up: ' + label);
    }
  } finally { await harness.dispose(); }
});

test('a genuinely wrong password still reports as an error', async () => {
  const client = stubClient({
    signInWithPassword: async () => ({error: new Error('Invalid login credentials')}),
  });
  const harness = await mount(client);
  try {
    await document.getElementById('btn-account').onclick();
    fieldNamed('Email').value = 'aoife@example.test';
    fieldNamed('Password').value = 'wrong';
    await primaryOf().onclick();
    await settle();
    assert.equal(textOf('h2'), 'Sign in');
    assert.equal(textOf('.dialog-error'), 'Invalid login credentials');
    assert.equal(textOf('.dialog-notice'), '');
  } finally { await harness.dispose(); }
});
