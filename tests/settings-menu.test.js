import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mount, stubClient} from './helpers/mount-app.mjs';

const settings = () => document.getElementById('settings-pop');
const dialogOf = () => document.querySelector('dialog[open]');

test('the header ends with settings and then the account', async () => {
  const harness = await mount(stubClient());
  try {
    const ids = [...document.querySelector('.brand-actions').children].map(el => el.id);
    assert.deepEqual(ids, ['btn-zen', 'btn-settings', 'btn-account']);
  } finally { await harness.dispose(); }
});

test('the page has no footer label and no data buttons below the workspace', async () => {
  const harness = await mount(stubClient());
  try {
    assert.equal(document.querySelector('.hero-foot'), null);
    assert.equal(document.getElementById('scene-label'), null);
    const bottom = document.querySelector('#content > .account-actions');
    assert.ok(bottom, 'the update row still exists for update offers');
    assert.equal(bottom.children.length, 0, 'it is empty until an update is ready');
    for (const id of ['btn-history', 'btn-backup', 'link-privacy']) {
      assert.ok(settings().contains(document.getElementById(id)), `${id} lives in settings`);
    }
  } finally { await harness.dispose(); }
});

test('settings holds Session history, Backup and Privacy', async () => {
  const harness = await mount(stubClient());
  try {
    const section = settings().querySelector('.set-section');
    assert.deepEqual([...section.querySelectorAll('.set-link')].map(el => el.textContent), ['Session history', 'Backup', 'Privacy']);
    assert.equal(document.getElementById('link-privacy').getAttribute('href'), 'privacy.html');
    assert.equal(settings().getAttribute('aria-label'), 'Settings');
  } finally { await harness.dispose(); }
});

for (const [id, heading] of [['btn-history', /^Time you made$/], ['btn-backup', /^Your data, kept with you$/]]) {
  test(`choosing ${id} closes settings and opens its dialog`, async () => {
    const harness = await mount(stubClient());
    try {
      document.getElementById('btn-settings').onclick();
      assert.equal(settings().classList.contains('show'), true);
      await document.getElementById(id).onclick();
      assert.equal(settings().classList.contains('show'), false, 'settings closes');
      assert.equal(document.getElementById('btn-settings').getAttribute('aria-expanded'), 'false');
      assert.ok(dialogOf(), 'a dialog opens');
      assert.match(dialogOf().querySelector('h2').textContent, heading);
    } finally { await harness.dispose(); }
  });
}
