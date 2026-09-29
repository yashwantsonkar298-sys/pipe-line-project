import assert from 'node:assert/strict';
import test from 'node:test';

import { assertHostPort, assertPairingCode } from '../server/adb.js';

test('assertHostPort accepts the addresses Android shows on the Wireless debugging screen', () => {
  assert.equal(assertHostPort('192.168.1.7:37123'), '192.168.1.7:37123');
  assert.equal(assertHostPort('10.0.0.5:5555'), '10.0.0.5:5555');
  assert.equal(assertHostPort('phone.local:41235'), 'phone.local:41235');
  assert.equal(assertHostPort('[fe80::1]:37123'), '[fe80::1]:37123');
  // typed by hand, so surrounding whitespace is expected and trimmed
  assert.equal(assertHostPort('  192.168.1.7:37123  '), '192.168.1.7:37123');
});

test('assertHostPort rejects anything that could become extra adb arguments', () => {
  for (const bad of [
    '192.168.1.7 5555',        // a space is a second argument
    '192.168.1.7:5555; reboot',
    '$(whoami):5555',
    '192.168.1.7:5555 --foo',
    '-a:5555 && calc.exe',
    '192.168.1.7|nc:5555'
  ]) {
    assert.throws(() => assertHostPort(bad), /Invalid address/, `should reject ${bad}`);
  }
});

test('assertHostPort requires a port, because Android randomises it per session', () => {
  // Bare hosts would silently mean 5555 to adb, which is never the pairing port.
  for (const bad of ['192.168.1.7', 'phone.local', '192.168.1.7:', ':5555', '']) {
    assert.throws(() => assertHostPort(bad), /Invalid address/, `should reject ${bad}`);
  }
});

test('assertHostPort rejects out-of-range ports', () => {
  assert.equal(assertHostPort('192.168.1.7:65535'), '192.168.1.7:65535');
  assert.throws(() => assertHostPort('192.168.1.7:0'), /Invalid address/);
  assert.throws(() => assertHostPort('192.168.1.7:65536'), /Invalid address/);
  assert.throws(() => assertHostPort('192.168.1.7:999999'), /Invalid address/);
});

test('assertHostPort rejects non-string input', () => {
  for (const bad of [null, undefined, 42, {}, ['192.168.1.7:5555']]) {
    assert.throws(() => assertHostPort(bad), /Invalid address/);
  }
});

test('assertPairingCode accepts exactly the six digits the phone displays', () => {
  assert.equal(assertPairingCode('123456'), '123456');
  assert.equal(assertPairingCode('000000'), '000000');
  assert.equal(assertPairingCode(' 654321 '), '654321');
});

test('assertPairingCode rejects wrong lengths and non-digits', () => {
  for (const bad of ['12345', '1234567', '12 456', 'abcdef', '12345a', '', null, 123456]) {
    assert.throws(() => assertPairingCode(bad), /Invalid pairing code/, `should reject ${bad}`);
  }
});
