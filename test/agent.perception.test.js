import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseUiXml,
  serializeForModel,
  screenSignature,
  overlayElements
} from '../server/agent/perception.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'uiautomator-settings.xml'), 'utf8');

test('parseUiXml derives the screen size from the root node bounds', () => {
  const { width, height } = parseUiXml(XML);
  assert.equal(width, 1080);
  assert.equal(height, 2400);
});

test('parseUiXml keeps labelled and interactive nodes', () => {
  const { elements } = parseUiXml(XML);
  const labels = elements.map((e) => e.label);
  assert.ok(labels.includes('Settings'));
  assert.ok(labels.includes('Search settings'), 'content-desc is used when text is empty');
  assert.ok(labels.includes('Network & internet'), 'XML entities are unescaped');
  assert.ok(labels.includes('Airplane mode'));
});

test('parseUiXml drops disabled nodes and unlabelled decoration', () => {
  const { elements } = parseUiXml(XML);
  assert.ok(!elements.some((e) => e.label === 'Disabled option'), 'enabled="false" is skipped');
  assert.ok(!elements.some((e) => e.className === 'ImageView' && !e.label), 'plain images are skipped');
});

test('parseUiXml drops layout containers that only have a resource id', () => {
  // Real Vivo/Samsung dumps are full of these — "content parent", "nestedlayout",
  // "bbk zonelist bottom". They are untouchable, unreadable, and crowd out real
  // targets, so a resource id is only a label for something interactive.
  const { elements } = parseUiXml(XML);
  assert.ok(!elements.some((e) => /content parent/i.test(e.label)),
    'a non-clickable FrameLayout with only an id is not an element');
  assert.ok(elements.some((e) => e.scrollable && /main content/i.test(e.label)),
    'but an interactive node may still be named by its id');
});

test('a stale row toggle takes its checked state from the real switch inside it', () => {
  // Observed on a Vivo V2437: the row reports checked=false while the nested
  // Switch reports checked=true. Believing the row tells the agent a setting is
  // off when it is on, and it "fixes" something that was never broken.
  const { elements } = parseUiXml(XML);
  const usb = elements.filter((e) => e.label === 'USB debugging');
  assert.equal(usb.length, 1, 'the row and its inner switch collapse to one element');
  assert.equal(usb[0].checked, true, 'the inner widget wins on state');
  assert.equal(usb[0].clickable, true, 'the outer row keeps the tappable area');
  assert.equal(usb[0].kind, 'toggle');
});

test('an independent toggle is not merged into an unrelated one', () => {
  const { elements } = parseUiXml(XML);
  const airplane = elements.find((e) => e.label === 'Airplane mode' && e.kind === 'toggle');
  assert.ok(airplane, 'the standalone Airplane mode switch survives');
  assert.equal(airplane.checked, false, 'its own state is untouched');
});

test('parseUiXml classifies kinds and flags', () => {
  const { elements } = parseUiXml(XML);
  const airplaneSwitch = elements.find((e) => e.kind === 'toggle');
  assert.ok(airplaneSwitch, 'the Switch is kept as a toggle');
  assert.equal(airplaneSwitch.checkable, true);
  assert.equal(airplaneSwitch.checked, false);

  const input = elements.find((e) => e.kind === 'input');
  assert.ok(input, 'an unlabelled EditText is kept because it is interactive');
  assert.equal(input.password, true);

  const scroller = elements.find((e) => e.scrollable);
  assert.ok(scroller, 'the RecyclerView is kept as scrollable');
});

test('bounds map to normalized centres and boxes', () => {
  const { elements } = parseUiXml(XML);
  const title = elements.find((e) => e.label === 'Settings');
  // bounds [60,180][400,260] -> centre (230, 220) on a 1080x2400 screen
  assert.equal(title.bounds.cx, 230);
  assert.equal(title.bounds.cy, 220);
  assert.ok(Math.abs(title.nx - 230 / 1080) < 1e-3);
  assert.ok(Math.abs(title.ny - 220 / 2400) < 1e-3);
  assert.ok(Math.abs(title.box.w - 340 / 1080) < 1e-3);
});

test('elements are indexed in reading order', () => {
  const { elements } = parseUiXml(XML);
  elements.forEach((el, i) => assert.equal(el.index, i));
  for (let i = 1; i < elements.length; i++) {
    assert.ok(elements[i].bounds.cy >= elements[i - 1].bounds.cy, 'sorted top to bottom');
  }
});

test('a clickable row and its text child collapse into one element', () => {
  const { elements } = parseUiXml(XML);
  const airplaneRows = elements.filter((e) => e.label === 'Airplane mode' && e.kind !== 'toggle');
  assert.equal(airplaneRows.length, 1, 'the row and its title are not listed twice');
  assert.equal(airplaneRows[0].clickable, true, 'the surviving element is the tappable one');
});

test('serializeForModel renders a compact numbered list', () => {
  const state = { ...parseUiXml(XML), appPackage: 'com.android.settings', degraded: false };
  const text = serializeForModel(state);
  assert.match(text, /Screen 1080x2400 · app: com\.android\.settings/);
  assert.match(text, /#\d+ \[toggle\] "Airplane mode" \([\d.]+,[\d.]+\) \{clickable,unchecked\}/);
  assert.match(text, /PASSWORD-FIELD/);
  assert.ok(text.length < 4000, 'stays small enough to send every step');
});

test('serializeForModel tells the model to fall back to coordinates when degraded', () => {
  const text = serializeForModel({ degraded: true, width: 1080, height: 2400, elements: [] });
  assert.match(text, /tap_xy/);
  assert.doesNotMatch(text, /#0/);
});

test('serializeForModel handles a screen with no elements', () => {
  const text = serializeForModel({ degraded: false, width: 1080, height: 2400, elements: [] });
  assert.match(text, /No interactive elements/);
});

test('screenSignature is stable for the same screen and differs across screens', () => {
  const a = { ...parseUiXml(XML), appPackage: 'com.android.settings' };
  const b = { ...parseUiXml(XML), appPackage: 'com.android.settings' };
  assert.equal(screenSignature(a), screenSignature(b));

  const changed = { ...a, elements: a.elements.slice(1) };
  assert.notEqual(screenSignature(a), screenSignature(changed));
  assert.notEqual(screenSignature(a), screenSignature({ ...a, appPackage: 'com.other' }));
});

test('overlayElements exposes only what the browser overlay needs', () => {
  const state = parseUiXml(XML);
  const overlay = overlayElements(state);
  assert.equal(overlay.length, state.elements.length);
  assert.deepEqual(Object.keys(overlay[0]).sort(), ['box', 'index', 'kind', 'label']);
  assert.equal(overlayElements(null).length, 0);
});

test('parseUiXml survives garbage input', () => {
  const { elements, width, height } = parseUiXml('not xml at all');
  assert.equal(elements.length, 0);
  assert.equal(width, 1080);
  assert.equal(height, 2400);
});
