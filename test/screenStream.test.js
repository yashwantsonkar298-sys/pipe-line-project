import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameSplitter } from '../server/screenStream.js';

const jpeg = (...body) => Buffer.from([0xff, 0xd8, ...body, 0xff, 0xd9]);

function collect() {
  const frames = [];
  return { frames, push: createFrameSplitter((f) => frames.push(Buffer.from(f))) };
}

test('splits a single whole frame', () => {
  const { frames, push } = collect();
  push(jpeg(1, 2, 3));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg(1, 2, 3));
});

test('splits several frames arriving in one chunk', () => {
  const { frames, push } = collect();
  push(Buffer.concat([jpeg(1), jpeg(2), jpeg(3)]));
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[1], jpeg(2));
});

test('reassembles a frame split across chunk boundaries', () => {
  const { frames, push } = collect();
  const whole = jpeg(9, 8, 7, 6);
  for (const byte of whole) push(Buffer.from([byte]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], whole);
});

test('emits nothing until the end marker arrives', () => {
  const { frames, push } = collect();
  push(Buffer.from([0xff, 0xd8, 0x11, 0x22]));
  assert.equal(frames.length, 0);
  push(Buffer.from([0xff, 0xd9]));
  assert.equal(frames.length, 1);
});

test('skips leading bytes that precede the first start marker', () => {
  const { frames, push } = collect();
  push(Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), jpeg(5)]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg(5));
});

test('a start marker straddling two chunks is not lost', () => {
  const { frames, push } = collect();
  push(Buffer.from([0x00, 0xff]));
  push(Buffer.from([0xd8, 0x42, 0xff, 0xd9]));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], jpeg(0x42));
});

test('does not grow its buffer without bound on pure garbage', () => {
  const { frames, push } = collect();
  for (let i = 0; i < 100; i++) push(Buffer.alloc(1024, 0x00));
  assert.equal(frames.length, 0);
  // Still recognises a real frame afterwards.
  push(jpeg(7));
  assert.equal(frames.length, 1);
});
