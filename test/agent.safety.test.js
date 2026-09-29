import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAction, checkAppAllowlist, describeAction, RISK } from '../server/agent/safety.js';

const screen = (labels, extra = {}) => ({
  appPackage: 'com.example.app',
  elements: labels.map((label, index) =>
    typeof label === 'string' ? { index, label } : { index, ...label }
  ),
  ...extra
});

const el = (label, extra = {}) => ({ label, ...extra });

test('non-mutating primitives are always safe', () => {
  for (const name of ['screenshot', 'wait', 'finish', 'ask_user']) {
    assert.equal(classifyAction({ name, input: {} }, screen([])).risk, RISK.SAFE, name);
  }
});

test('an ordinary tap is safe', () => {
  const verdict = classifyAction(
    { name: 'tap_element', input: { index: 0 }, target: el('Settings') },
    screen(['Settings', 'Display'])
  );
  assert.equal(verdict.risk, RISK.SAFE);
});

test('irreversible button labels require confirmation', () => {
  const labels = [
    'Place order', 'Pay now', 'Buy', 'Checkout', 'Subscribe', 'Delete',
    'Uninstall', 'Send', 'Call', 'Transfer', 'Factory reset', 'Sign out'
  ];
  for (const label of labels) {
    const verdict = classifyAction(
      { name: 'tap_element', input: { index: 0 }, target: el(label) },
      screen([label])
    );
    assert.equal(verdict.risk, RISK.CONFIRM, `"${label}" should need confirmation`);
    assert.match(verdict.reason, /irreversible/);
  }
});

test('Hinglish irreversible labels are caught too', () => {
  for (const label of ['Order karo', 'Message bhejo', 'Abhi kharido', 'Delete karo']) {
    const verdict = classifyAction(
      { name: 'tap_element', input: { index: 0 }, target: el(label) },
      screen([label])
    );
    assert.equal(verdict.risk, RISK.CONFIRM, `"${label}" should need confirmation`);
  }
});

test('a payment or checkout screen makes any tap need confirmation', () => {
  const verdict = classifyAction(
    { name: 'tap_element', input: { index: 0 }, target: el('Continue') },
    screen(['Order summary', 'Grand total ₹499', 'Continue'])
  );
  assert.equal(verdict.risk, RISK.CONFIRM);
  assert.match(verdict.reason, /payment or checkout/);
});

test('a payment app makes any tap need confirmation', () => {
  for (const pkg of ['net.one97.paytm', 'com.phonepe.app', 'com.hdfc.bank', 'com.example.banking']) {
    const verdict = classifyAction(
      { name: 'tap_element', input: { index: 0 }, target: el('Continue') },
      screen(['Continue'], { appPackage: pkg })
    );
    assert.equal(verdict.risk, RISK.CONFIRM, pkg);
  }
});

test('tapping a credential field needs confirmation', () => {
  const verdict = classifyAction(
    { name: 'tap_element', input: { index: 0 }, target: el('Enter PIN', { password: true }) },
    screen([el('Enter PIN', { password: true })])
  );
  assert.equal(verdict.risk, RISK.CONFIRM);
});

test('typing into a password field is blocked outright', () => {
  const verdict = classifyAction(
    { name: 'type_text', input: { text: 'hunter2' } },
    screen([el('Password', { password: true, focused: true })])
  );
  assert.equal(verdict.risk, RISK.BLOCK);
});

test('typing into an OTP-labelled focused field is blocked', () => {
  const verdict = classifyAction(
    { name: 'type_text', input: { text: 'anything' } },
    screen([el('Enter OTP', { focused: true })])
  );
  assert.equal(verdict.risk, RISK.BLOCK);
  assert.match(verdict.reason, /OTP\/PIN\/CVV/);
});

test('a code-shaped string is blocked on a credential screen even without focus', () => {
  const otpScreen = screen([el('One-time password'), el('Verify')]);
  assert.equal(classifyAction({ name: 'type_text', input: { text: '482913' } }, otpScreen).risk, RISK.BLOCK);
  assert.equal(classifyAction({ name: 'type_text', input: { text: '4111 1111 1111 1111' } }, otpScreen).risk, RISK.BLOCK);
});

test('a code-shaped string is fine on an ordinary screen', () => {
  const verdict = classifyAction({ name: 'type_text', input: { text: '482913' } }, screen(['Search', 'Pincode']));
  assert.equal(verdict.risk, RISK.SAFE);
});

test('ordinary text entry is safe', () => {
  const verdict = classifyAction({ name: 'type_text', input: { text: 'lofi beats' } }, screen(['Search']));
  assert.equal(verdict.risk, RISK.SAFE);
});

test('typing an irreversible instruction needs confirmation', () => {
  const verdict = classifyAction({ name: 'type_text', input: { text: 'delete my account' } }, screen(['Search']));
  assert.equal(verdict.risk, RISK.CONFIRM);
});

test('navigation keys are safe but power is not', () => {
  for (const key of ['back', 'home', 'enter', 'recents']) {
    assert.equal(classifyAction({ name: 'press_key', input: { key } }, screen([])).risk, RISK.SAFE, key);
  }
  assert.equal(classifyAction({ name: 'press_key', input: { key: 'power' } }, screen([])).risk, RISK.CONFIRM);
});

test('swiping and launching apps are safe', () => {
  assert.equal(classifyAction({ name: 'swipe', input: { direction: 'up' } }, screen([])).risk, RISK.SAFE);
  assert.equal(classifyAction({ name: 'open_app', input: { appName: 'Settings' } }, screen([])).risk, RISK.SAFE);
});

test('an unrecognised action fails closed', () => {
  const verdict = classifyAction({ name: 'launch_missiles', input: {} }, screen([]));
  assert.equal(verdict.risk, RISK.CONFIRM);
  assert.match(verdict.reason, /unrecognised/);
});

test('an empty allowlist allows every app', () => {
  assert.equal(checkAppAllowlist(screen([]), []).risk, RISK.SAFE);
  assert.equal(checkAppAllowlist(screen([]), undefined).risk, RISK.SAFE);
});

test('a populated allowlist blocks apps that are not on it', () => {
  const state = screen([], { appPackage: 'com.evil.app' });
  assert.equal(checkAppAllowlist(state, ['com.android.settings']).risk, RISK.BLOCK);
  assert.equal(checkAppAllowlist(state, ['com.evil.app']).risk, RISK.SAFE);
});

test('the allowlist matches sub-packages but not prefixes of a different app', () => {
  const sub = screen([], { appPackage: 'com.android.settings.wifi' });
  assert.equal(checkAppAllowlist(sub, ['com.android.settings']).risk, RISK.SAFE);

  const lookalike = screen([], { appPackage: 'com.android.settingsevil' });
  assert.equal(checkAppAllowlist(lookalike, ['com.android.settings']).risk, RISK.BLOCK);
});

test('the allowlist gate wins over the per-action verdict', () => {
  const verdict = classifyAction(
    { name: 'tap_element', input: { index: 0 }, target: el('Settings') },
    screen(['Settings'], { appPackage: 'com.evil.app' }),
    { appAllowlist: ['com.android.settings'] }
  );
  assert.equal(verdict.risk, RISK.BLOCK);
});

test('an unknown foreground app is not blocked by the allowlist', () => {
  const state = screen([], { appPackage: null });
  assert.equal(checkAppAllowlist(state, ['com.android.settings']).risk, RISK.SAFE);
});

test('describeAction renders every primitive readably', () => {
  assert.equal(describeAction({ name: 'tap_element', input: { index: 3 } }, el('Search')), 'Tap "Search"');
  assert.equal(describeAction({ name: 'tap_element', input: { index: 3 } }, null), 'Tap element #3');
  assert.equal(describeAction({ name: 'tap_xy', input: { x: 10, y: 20 } }), 'Tap at (10, 20)');
  assert.equal(describeAction({ name: 'type_text', input: { text: 'hello' } }), 'Type "hello"');
  assert.equal(describeAction({ name: 'swipe', input: { direction: 'up' } }), 'Swipe up');
  assert.equal(describeAction({ name: 'press_key', input: { key: 'back' } }), 'Press back');
  assert.equal(describeAction({ name: 'open_app', input: { appName: 'YouTube' } }), 'Open YouTube');
  assert.equal(describeAction({ name: 'wait', input: { ms: 500 } }), 'Wait 500ms');
  assert.match(describeAction({ name: 'finish', input: { summary: 'all done' } }), /Finish: all done/);
});

test('describeAction truncates long text instead of dumping it', () => {
  const long = 'x'.repeat(300);
  assert.ok(describeAction({ name: 'type_text', input: { text: long } }).length < 80);
});
