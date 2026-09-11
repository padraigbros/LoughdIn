import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mount, stubClient, settle} from './helpers/mount-app.mjs';


const dialogOf = () => document.querySelector('dialog[open]');
const primaryOf = () => dialogOf().querySelector('.dialog-actions .t-btn-primary');
const linkNamed = text => [...dialogOf().querySelectorAll('.auth-link')].find(b => b.textContent === text);
const fieldNamed = label => [...dialogOf().querySelectorAll('.auth-body label')]
  .find(l => l.textContent.startsWith(label)).querySelector('input');
const textOf = selector => dialogOf().querySelector(selector).textContent;

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
      initial: '', tone: 'idle', badge: '', dot: false,
      title: 'Not signed in. Tasks stay on this device. Open to sign in and sync across devices.',
    });
    assert.deepEqual(accountSummary(account, {state: 'synced'}), {
      initial: 'A', tone: 'ok', badge: '', dot: true, title: 'aoife@example.test · All changes synced',
    });
    // The dot is the sync state, so it says nothing when there is no sync to
    // report, where a grey dot carrying nothing would read as an unread count.
    assert.equal(document.querySelector('.account-dot').hidden, true, 'signed out shows no dot');
    assert.equal(accountSummary(account, {state: 'local'}, false).dot, false, 'nor does sync being unavailable');
    const pending = accountSummary(account, {state: 'pending', pending: 3});
    assert.equal(pending.badge, '3', 'unsent work is counted on the control');
    assert.equal(pending.title, 'aoife@example.test · Saved on this device · 3 changes pending');
    assert.equal(accountSummary(account, {state: 'pending', pending: 1}).title,
      'aoife@example.test · Saved on this device · 1 change pending', 'one change is not 1 changes');
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

const ACCOUNT = {id: '44444444-0000-4000-8000-000000000001', email: 'aoife@example.test'};
const GUEST_TASK = '55555555-0000-4000-8000-000000000001';
const buttonNamed = text => [...dialogOf().querySelectorAll('.dialog-actions button')]
  .find(b => b.textContent.startsWith(text));

test('importing guest data says what it will bring, then brings it', async () => {
  const harness = await mount(stubClient({}, {user: ACCOUNT}));
  try {
    await settle();
    // The guest namespace as someone who tried the app would leave it.
    const {createStore} = await import('../src/storage.js');
    const guest = createStore({namespace: 'guest', BroadcastChannel: null});
    await guest.open();
    await guest.mutate(draft => {
      draft.tasks.work.push({
        id: GUEST_TASK, text: 'Something I made as a guest', done: false, priority: 'med',
        poms: 0, quadrant: null, details: '', nextAction: '', estimateMinutes: 25,
        createdAt: '2026-09-10T09:00:00.000Z', updatedAt: '2026-09-10T09:00:00.000Z',
        deletedAt: null, revision: 0,
      });
    });
    guest.close();

    await document.getElementById('btn-account').onclick();
    assert.equal(textOf('h2'), 'Your account');
    const button = buttonNamed('Import guest data');
    assert.ok(button, 'the import control is there');

    await button.onclick();
    assert.equal(button.textContent, 'Bring across 1 task', 'the first press counts, it does not commit');
    assert.equal(textOf('.dialog-error'), '', 'and says nothing in the error line');

    await button.onclick();
    await settle();
    assert.equal(textOf('.dialog-error'), '');
    assert.match(textOf('.dialog-notice'), /^Imported 1 task\./);
    assert.equal(button.textContent, 'Import guest data', 'the control goes back to offering an import');
  } finally { await harness.dispose(); }
});

test('an empty guest namespace is reported rather than imported', async () => {
  const harness = await mount(stubClient({}, {user: ACCOUNT}));
  try {
    await settle();
    await document.getElementById('btn-account').onclick();
    const button = buttonNamed('Import guest data');
    await button.onclick();
    assert.equal(textOf('.dialog-notice'), 'Nothing on this device is waiting to be imported.');
    assert.equal(button.textContent, 'Import guest data', 'nothing to confirm');
  } finally { await harness.dispose(); }
});
