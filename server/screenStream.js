/**
 * Live screen streaming at video frame rates.
 *
 * The original mirror polled `screencap -p` over HTTP, which costs ~300ms per
 * frame on-device and caps out around 3 fps. This pipes the phone's hardware
 * H.264 encoder straight out instead:
 *
 *   adb exec-out screenrecord --output-format=h264 -   →   ffmpeg   →   MJPEG
 *
 * and pushes each JPEG to the browser over the existing WebSocket, where it
 * lands in the same <img> the polling mirror used. Keeping the <img> is the
 * point: tap mapping, long-press, the agent's element overlay and screenshot
 * capture all measure that element (see nxImageContentRect), and a <video>
 * would have meant rewriting every one of them. MJPEG also sidesteps
 * MediaSource's exact-codec-string negotiation, which varies per device
 * encoder.
 *
 * Costs of this choice, honestly: JPEG is fatter on the wire than H.264 (fine
 * on localhost/LAN, which is all this server allows) and the PC spends CPU
 * re-encoding. Latency lands around 250ms versus the poller's ~1s.
 *
 * `screenrecord` caps itself at 180s, so the pipeline is expected to die
 * periodically and is simply restarted; the same path covers crashes.
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Below the device's own 180s ceiling, so we restart on our terms. */
const SEGMENT_SECONDS = 170;
/**
 * A hint to ffmpeg's `-r`, not a hard ceiling: screenrecord's timestamps are
 * irregular enough that measured output runs ~33 fps under motion. Left loose
 * deliberately — the `fps` filter would cap it properly but pads a still screen
 * up to the target, and a static screen should cost nothing. screenrecord only
 * encodes on change, so an idle phone streams near-zero frames by itself.
 */
const TARGET_FPS = 20;
const TARGET_WIDTH = 540;
/**
 * ffmpeg's -q:v, where lower is better quality. Measured on a 1080x2408 device
 * screen: q5 ≈ 69 KB/frame, q7 ≈ 54, q10 ≈ 41, q16 ≈ 29. q10 keeps status-bar
 * text and app labels legible at 540px while costing ~820 KB/s at 20 fps.
 */
const JPEG_QUALITY = 10;

/** A pipeline that dies faster than this is failing, not rotating. */
const MIN_HEALTHY_MS = 3000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESTART_DELAY_MS = 400;

function adbPath() {
  const local = path.join(__dirname, 'bin', 'platform-tools', 'adb.exe');
  return fs.existsSync(local) ? local : 'adb';
}

function deviceArgs(deviceId) {
  if (deviceId && !/^[A-Za-z0-9.:_-]+$/.test(deviceId)) throw new Error('Invalid device id');
  return deviceId ? ['-s', deviceId] : [];
}

let ffmpegChecked = false;
let ffmpegOk = false;

/** Probed once — the stream is optional and the poller covers its absence. */
export async function isFfmpegAvailable() {
  if (ffmpegChecked) return ffmpegOk;
  ffmpegChecked = true;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Split concatenated JPEGs out of the MJPEG byte stream.
 *
 * Inside entropy-coded data every 0xff is byte-stuffed as 0xff00, so a bare
 * 0xffd9 is always a real end-of-image. ffmpeg's mjpeg muxer writes no EXIF
 * thumbnail, which is the one case that would embed a second one.
 */
export function createFrameSplitter(onFrame) {
  let buf = Buffer.alloc(0);

  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      const start = buf.indexOf(SOI);
      if (start < 0) {
        // No image started yet; keep only a trailing byte in case a marker
        // straddles the chunk boundary.
        if (buf.length > 1) buf = buf.subarray(buf.length - 1);
        return;
      }
      const end = buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) buf = buf.subarray(start);
        return;
      }
      onFrame(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
  };
}

let state = null;

export function isStreaming() {
  return !!state && !state.stopping;
}

export function streamStatus() {
  return {
    streaming: isStreaming(),
    fpsHint: TARGET_FPS,
    width: TARGET_WIDTH
  };
}

function killPipeline(s) {
  for (const child of [s.recorder, s.encoder]) {
    if (!child || child.killed) continue;
    try { child.kill('SIGKILL'); } catch {  }
  }
}

/**
 * Start streaming. `onFrame(buffer)` gets one JPEG per frame; `onStatus` is
 * told when the stream stops for good, with a reason to show the user.
 */
export async function startStream({ deviceId, onFrame, onStatus } = {}) {
  if (state) return { started: true, alreadyRunning: true };

  if (!(await isFfmpegAvailable())) {
    return { started: false, reason: 'ffmpeg is not installed — falling back to the frame poller' };
  }

  state = {
    deviceId,
    onFrame,
    onStatus,
    recorder: null,
    encoder: null,
    stopping: false,
    failures: 0,
    restartTimer: null
  };

  spawnPipeline(state);
  return { started: true };
}

function spawnPipeline(s) {
  if (s.stopping) return;

  const startedAt = Date.now();
  s.startedAt = startedAt;

  let recorder;
  let encoder;
  try {
    recorder = spawn(adbPath(), [
      ...deviceArgs(s.deviceId),
      'exec-out', 'screenrecord',
      '--output-format=h264',
      '--time-limit', String(SEGMENT_SECONDS),
      '--bit-rate', '8000000',
      '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    encoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      // Start decoding almost immediately instead of probing the stream first.
      // NOT `-fflags nobuffer`: on ffmpeg 9 that silently yields zero output
      // here — exit code 0, no frames, no error message.
      '-flags', 'low_delay',
      '-analyzeduration', '0', '-probesize', '32768',
      '-f', 'h264', '-i', 'pipe:0',
      '-an',
      '-vf', `scale=${TARGET_WIDTH}:-2`,
      '-r', String(TARGET_FPS),
      // mjpeg only encodes full-range YUV; without this it refuses to open
      // the encoder at all.
      '-pix_fmt', 'yuvj420p',
      '-q:v', String(JPEG_QUALITY),
      '-f', 'mjpeg', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    finish(s, `could not start the stream: ${err.message}`);
    return;
  }

  s.recorder = recorder;
  s.encoder = encoder;

  recorder.stdout.pipe(encoder.stdin);
  // The recorder outliving the encoder would otherwise raise EPIPE.
  encoder.stdin.on('error', () => {  });

  const split = createFrameSplitter((frame) => {
    if (!s.stopping && typeof s.onFrame === 'function') s.onFrame(frame);
  });
  encoder.stdout.on('data', split);

  let lastRecorderError = '';
  recorder.stderr.on('data', (d) => { lastRecorderError = String(d).trim().slice(0, 300); });
  encoder.stderr.on('data', (d) => { lastRecorderError = String(d).trim().slice(0, 300) || lastRecorderError; });

  let restarted = false;
  const onExit = () => {
    if (restarted || s.stopping || s !== state) return;
    restarted = true;
    killPipeline(s);

    const lived = Date.now() - startedAt;
    if (lived < MIN_HEALTHY_MS) {
      s.failures += 1;
      if (s.failures >= MAX_CONSECUTIVE_FAILURES) {
        finish(s, lastRecorderError || 'the screen recorder kept exiting immediately');
        return;
      }
    } else {
      // Lived a full segment: this is the 180s rotation, not a failure.
      s.failures = 0;
    }

    s.restartTimer = setTimeout(() => spawnPipeline(s), RESTART_DELAY_MS);
  };

  recorder.on('exit', onExit);
  recorder.on('error', onExit);
  encoder.on('exit', onExit);
  encoder.on('error', onExit);
}

function finish(s, reason) {
  if (s !== state) return;
  stopStream();
  if (typeof s.onStatus === 'function') s.onStatus({ streaming: false, reason });
}

export function stopStream() {
  const s = state;
  state = null;
  if (!s) return;
  s.stopping = true;
  clearTimeout(s.restartTimer);
  killPipeline(s);
}
