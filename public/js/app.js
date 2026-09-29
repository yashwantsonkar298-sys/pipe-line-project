const socket = window.NexusWS;

let contactsData = [];
let configData = {};

const toastContainer = document.getElementById('toast-container');
const adbStatusDot = document.getElementById('adb-status-dot');
const adbStatusText = document.getElementById('adb-status-text');
const deviceModelText = document.getElementById('header-device-model');
const diagOs = document.getElementById('diag-os');
const diagBattery = document.getElementById('diag-battery');
const diagBatteryFill = document.getElementById('diag-battery-fill');
const diagTemp = document.getElementById('diag-temp');
const diagRes = document.getElementById('diag-res');

const phoneScreenContainer = document.getElementById('phone-screen-container');
const phoneScreenshot = document.getElementById('phone-screenshot');
const screenFallback = document.getElementById('screen-fallback');
const screenSpinner = document.getElementById('screen-spinner');
const btnRefreshScreen = document.getElementById('btn-refresh-screen');
const btnLiveFeed = document.getElementById('btn-live-feed');
const liveFeedText = document.getElementById('live-feed-text');

const consoleLogs = document.getElementById('console-logs');
const cmdTextInput = document.getElementById('cmd-text-input');
const btnSubmitCmd = document.getElementById('btn-submit-cmd');

const shutdownOverlay = document.getElementById('shutdown-overlay');
const shutdownCountdown = document.getElementById('shutdown-countdown');
const btnAbortShutdown = document.getElementById('btn-abort-shutdown');

const tabBtnContacts = document.getElementById('tab-btn-contacts');
const tabBtnSettings = document.getElementById('tab-btn-settings');
const tabContentContacts = document.getElementById('tab-content-contacts');
const tabContentSettings = document.getElementById('tab-content-settings');

const contactsListContainer = document.getElementById('contacts-list-container');
const contactNameInput = document.getElementById('contact-name');
const contactPhoneInput = document.getElementById('contact-phone');
const btnSaveContact = document.getElementById('btn-save-contact');

const cfgPinInput = document.getElementById('cfg-pin');
const cfgWxInput = document.getElementById('cfg-wx');
const cfgWyInput = document.getElementById('cfg-wy');
const btnSaveConfig = document.getElementById('btn-save-config');

let wasDisconnected = false;
socket.addEventListener('open', () => {
  if (wasDisconnected) {
    appendTerminalLine('[SYSTEM] Reconnected to server.', 'adb-success');
    showToast('RECONNECTED', 'Server connection restored.', 'success');
    wasDisconnected = false;
  } else {
    appendTerminalLine('[SYSTEM] Server WebSocket channel established.', 'system');
  }
});

socket.addEventListener('reconnecting', ({ delay, everConnected }) => {
  if (!everConnected) return;
  wasDisconnected = true;
  if (adbStatusDot) adbStatusDot.className = 'status-dot disconnected';
  if (adbStatusText) adbStatusText.textContent = 'RECONNECTING…';
  appendTerminalLine(`[SYSTEM] Connection lost - retrying in ${Math.round(delay / 1000)}s…`, 'adb-warning');
});

socket.addEventListener('message', (event) => {
  // Binary payloads are live mirror frames, handled by the stream wiring below.
  if (typeof event.data !== 'string') {
    onStreamFrame(event.data);
    return;
  }

  let data;
  try { data = JSON.parse(event.data); } catch { return; }

  switch (data.type) {
    case 'diagnostics':
      updateDiagnosticsHUD(data.data);
      break;

    case 'mirror_stream_status':
      onStreamStatus(data);
      break;

    case 'adb_log':
      appendTerminalLine(data.log.message, `adb-${data.log.type}`);
      break;

    case 'confirm_request': {
      confirmDialog(data.summary, { okText: 'Run it', cancelText: 'Cancel', danger: true }).then((approved) => {
        socket.send(JSON.stringify({ type: 'confirm_action', id: data.id, approved }));
        appendTerminalLine(`[CONFIRM] ${data.summary} -> ${approved ? 'approved' : 'declined'}`, approved ? 'adb-success' : 'adb-warning');
      });
      break;
    }

    case 'command_queued':
    case 'job_event':
      break;

    case 'pipeline_start':
      resetPipelineNodes(data.command);
      appendTerminalLine(`[PIPELINE START] Instruction: "${data.command}"`, 'adb-info');
      break;

    case 'pipeline_step':
      updatePipelineStep(data.step, data.status, data.message);
      break;

    case 'pipeline_end':
      endPipeline(data.success, data.error);
      appendTerminalLine(`[PIPELINE END] Success: ${data.success}${data.error ? ' | Error: ' + data.error : ''}`, data.success ? 'adb-success' : 'adb-error');

      if (data.success) {
        showToast('PIPELINE SUCCESS', data.ttsMessage || 'Action executed successfully.', 'success');
        if (typeof window.spawnParticlePulse === 'function') {
          setTimeout(() => window.spawnParticlePulse(window.innerWidth/2, window.innerHeight/2), 100);
          setTimeout(() => window.spawnParticlePulse(window.innerWidth/3, window.innerHeight/2), 300);
          setTimeout(() => window.spawnParticlePulse(window.innerWidth*0.66, window.innerHeight/2), 500);
        }
      } else {
        showToast('PIPELINE FAILED', data.error || 'Unknown error occurred.', 'error');
      }

      if (data.ttsMessage && typeof window.vaniSpeak === 'function') {
        window.vaniSpeak(data.ttsMessage);
      }
      break;

    case 'shutdown_timer_start':
      showShutdownOverlay(data.seconds);
      break;

    case 'shutdown_timer_tick':
      updateShutdownTimer(data.seconds);
      break;

    case 'shutdown_timer_cancelled':
      hideShutdownOverlay();
      appendTerminalLine('[SYSTEM] Shutdown sequence aborted.', 'adb-warning');
      if (typeof window.vaniSpeak === 'function') {
        window.vaniSpeak('Shutdown sequence has been aborted successfully.');
      }
      break;

    case 'shutdown_timer_complete':
      hideShutdownOverlay();
      appendTerminalLine('[SYSTEM] Shutdown sequence complete. Bye!', 'adb-error');
      break;

    case 'system_alert':
      showToast('SYSTEM ALERT', data.message, 'warning');
      appendTerminalLine(`[ALERT] ${data.message}`, 'adb-warning');
      if (data.ttsMessage && typeof window.vaniSpeak === 'function') {
        window.vaniSpeak(data.ttsMessage);
      }
      break;
  }
});

socket.addEventListener('close', () => {
  if (adbStatusDot) adbStatusDot.className = 'status-dot disconnected';
  if (adbStatusText) adbStatusText.textContent = 'SERVER DISCONNECTED';
});


function showToast(title, message, type = 'success') {
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let iconHtml = '';
  if (type === 'success') {
    iconHtml = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-green)"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  } else if (type === 'error') {
    iconHtml = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-red)"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
  } else {
    iconHtml = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-yellow)"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  }

  toast.innerHTML = `
    <div class="toast-icon">${iconHtml}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 4500);
}

function confirmDialog(message, { okText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-message"></div>
        <div class="confirm-actions">
          <button class="hud-btn btn-secondary btn-sm" data-act="cancel"></button>
          <button class="hud-btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.confirm-message').textContent = message;
    overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
    overlay.querySelector('[data-act="ok"]').textContent = okText;

    function done(val) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') done(true);
      if (act === 'cancel') done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}


/**
 * Pipeline telemetry.
 *
 * The strip is driven entirely by events the server already sends —
 * `pipeline_start`, `pipeline_step` and `pipeline_end`. The per-stage `message`
 * used to go only to the terminal; it now also lands on the stage it describes,
 * which is what makes the strip worth looking at.
 */
const pipeContainer = document.getElementById('pipeline-container');
const pipeState = document.getElementById('pipe-state');
const pipeCmd = document.getElementById('pipe-cmd');
const pipeClock = document.getElementById('pipe-clock');

let pipeStartedAt = null;
let pipeClockTimer = null;

function setPipeState(state, label) {
  if (!pipeState) return;
  pipeState.dataset.state = state;
  pipeState.textContent = label;
  if (pipeContainer) pipeContainer.classList.toggle('is-running', state === 'run');
}

function stopPipeClock() {
  clearInterval(pipeClockTimer);
  pipeClockTimer = null;
}

function startPipeClock() {
  stopPipeClock();
  pipeStartedAt = Date.now();
  const tick = () => {
    if (!pipeClock || pipeStartedAt === null) return;
    const s = (Date.now() - pipeStartedAt) / 1000;
    pipeClock.textContent = `${s.toFixed(1)}s`;
  };
  tick();
  pipeClockTimer = setInterval(tick, 100);
}

function resetPipelineNodes(command) {
  document.querySelectorAll('.pipeline-node').forEach((node) => {
    node.className = 'pipeline-node';
  });
  document.querySelectorAll('.node-msg').forEach((el) => { el.textContent = ''; });
  document.querySelectorAll('.glow-connector-path').forEach((path) => {
    path.classList.add('hidden');
  });

  setPipeState('run', 'EXECUTING');
  if (pipeCmd) pipeCmd.textContent = command ? `» ${command}` : 'running…';
  startPipeClock();
}

function endPipeline(success, error) {
  stopPipeClock();
  setPipeState(success ? 'ok' : 'fail', success ? 'COMPLETE' : 'FAILED');
  if (pipeCmd && !success && error) pipeCmd.textContent = `» ${error}`;
}

function updatePipelineStep(stepIndex, status, logMessage) {
  const node = document.getElementById(`node-${stepIndex}`);
  if (!node) return;

  node.className = 'pipeline-node';

  if (status === 'pending') {
    node.classList.add('active');
  } else if (status === 'success') {
    node.classList.add('success');
    // Light the wire out of this stage: packets flow toward the next one.
    document.getElementById(`glow-path-${stepIndex}`)?.classList.remove('hidden');
  } else if (status === 'failed') {
    node.classList.add('failed');
  }

  const readout = document.getElementById(`node-msg-${stepIndex}`);
  if (readout) readout.textContent = String(logMessage || '');

  appendTerminalLine(`[PIPELINE STAGE ${stepIndex}] ${logMessage}`, status === 'success' ? 'adb-success' : (status === 'failed' ? 'adb-error' : 'system'));
}

function drawConnectorPaths() {
  const svg = document.getElementById('pipeline-svg');
  if (!svg) return;

  const nodes = document.querySelectorAll('.pipeline-node');
  const svgRect = svg.getBoundingClientRect();

  for (let i = 0; i < nodes.length - 1; i++) {
    const nodeA = nodes[i].querySelector('.node-circle').getBoundingClientRect();
    const nodeB = nodes[i+1].querySelector('.node-circle').getBoundingClientRect();

    const x1 = nodeA.left - svgRect.left + nodeA.width / 2;
    const y1 = nodeA.top - svgRect.top + nodeA.height / 2;
    const x2 = nodeB.left - svgRect.left + nodeB.width / 2;
    const y2 = nodeB.top - svgRect.top + nodeB.height / 2;

    const path = document.getElementById(`path-${i}`);
    const glowPath = document.getElementById(`glow-path-${i}`);

    if (path && glowPath) {
      const d = `M ${x1} ${y1} L ${x2} ${y2}`;
      path.setAttribute('d', d);
      glowPath.setAttribute('d', d);
    }
  }
}

window.addEventListener('resize', drawConnectorPaths);
setTimeout(drawConnectorPaths, 500);


/**
 * The device poller runs the same handful of `getprop` / `dumpsys` calls every
 * few seconds. Printed in full they bury everything that actually happened, so
 * a repeat of the previous line becomes a counter on that line instead.
 */
let lastLine = null;

function trimAdbNoise(text) {
  return String(text)
    // The device serial is in the header already; on every line it is padding.
    .replace(/^adb\s+-s\s+\S+\s+/, 'adb ')
    // The absolute path to adb.exe, if any older caller still emits it.
    .replace(/"[^"]*adb\.exe"\s*/g, 'adb ');
}

function appendTerminalLine(text, type = 'system') {
  const clean = trimAdbNoise(text);

  if (lastLine && lastLine.text === clean && lastLine.type === type) {
    lastLine.count += 1;
    lastLine.el.dataset.repeat = `×${lastLine.count}`;
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
    return;
  }

  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  line.textContent = clean;
  consoleLogs.appendChild(line);

  // Keep the feed bounded — an all-day session should not grow without limit.
  while (consoleLogs.childElementCount > 300) consoleLogs.removeChild(consoleLogs.firstChild);

  lastLine = { text: clean, type, el: line, count: 1 };
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}


function updateDiagnosticsHUD(data) {
  if (!data || !data.connected) {
    adbStatusDot.className = 'status-dot disconnected';
    adbStatusText.textContent = 'ADB DISCONNECTED';
    deviceModelText.textContent = 'NO DEVICE DETECTED';
    diagOs.textContent = 'N/A';
    diagBattery.textContent = 'N/A';
    diagBatteryFill.style.width = '0%';
    diagTemp.textContent = 'N/A';
    diagRes.textContent = 'N/A';

    btnRefreshScreen.disabled = true;
    btnLiveFeed.disabled = true;
    setMirrorKeysEnabled(false);
    phoneScreenshot.classList.add('hidden');
    screenFallback.classList.remove('hidden');
    return;
  }

  adbStatusDot.className = 'status-dot connected';
  adbStatusText.textContent = 'ADB CONNECTED';
  deviceModelText.textContent = `${data.brand} ${data.model}`.toUpperCase();

  diagOs.textContent = `ANDROID ${data.androidVersion}`;
  diagBattery.textContent = `${data.batteryLevel}% (${data.batteryStatus})`;
  diagBatteryFill.style.width = `${data.batteryLevel}%`;

  if (data.batteryTemp) {
    diagTemp.textContent = `${data.batteryTemp} °C`;
  } else {
    diagTemp.textContent = 'N/A';
  }

  diagRes.textContent = data.resolution;
  btnRefreshScreen.disabled = false;
  btnLiveFeed.disabled = false;
  setMirrorKeysEnabled(true);
}

btnRefreshScreen.addEventListener('click', async () => {
  screenSpinner.classList.remove('hidden');
  appendTerminalLine('[DIAGNOSTICS] Requesting system screencap...', 'system');
  await fetchScreenshot();
});

let liveFeedInterval = null;
/** Poller handle. Null while the WebSocket stream is carrying the picture. */
let mirrorTimer = null;
/**
 * Whether the mirror is on at all, regardless of which transport is feeding
 * it. The input handlers gate on this: they used to test `mirrorTimer`, which
 * silently disabled tapping the moment the stream took over from the poller.
 */
let mirrorLive = false;
let mirrorBusy = false;
let mirrorObjectUrl = null;
const MIRROR_INTERVAL_MS = 300;

async function pullMirrorFrame() {
  if (mirrorBusy) return;
  mirrorBusy = true;
  try {
    const res = await fetch('/api/mirror/frame?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    phoneScreenshot.src = url;
    phoneScreenshot.classList.remove('hidden');
    screenFallback.classList.add('hidden');
    if (mirrorObjectUrl) URL.revokeObjectURL(mirrorObjectUrl);
    mirrorObjectUrl = url;
  } catch (e) {
    appendTerminalLine(`[MIRROR] Frame failed: ${e.message}`, 'adb-warning');
  } finally {
    mirrorBusy = false;
  }
}

/**
 * Paint one frame of the WebSocket video stream.
 *
 * The first frame to arrive retires the poller: both write the same <img>, so
 * running them together would just fight over it at two different rates.
 */
function onStreamFrame(buffer) {
  if (!mirrorLive) return;

  if (mirrorTimer) {
    clearInterval(mirrorTimer);
    mirrorTimer = null;
    // No fixed rate quoted: the device only encodes when the screen changes,
    // so this runs ~30 fps while things move and near zero while they do not.
    appendTerminalLine('[MIRROR] Live video stream connected.', 'adb-info');
  }

  const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
  phoneScreenshot.src = url;
  phoneScreenshot.classList.remove('hidden');
  screenFallback.classList.add('hidden');
  if (mirrorObjectUrl) URL.revokeObjectURL(mirrorObjectUrl);
  mirrorObjectUrl = url;
}

/** The server telling us whether the video stream is actually up. */
function onStreamStatus(status) {
  if (!mirrorLive || status.streaming) return;

  // Stream unavailable or dropped — make sure the poller is carrying things.
  if (!mirrorTimer) {
    pullMirrorFrame();
    mirrorTimer = setInterval(pullMirrorFrame, MIRROR_INTERVAL_MS);
  }
  if (status.reason) {
    appendTerminalLine(`[MIRROR] Video stream unavailable (${status.reason}) — using the frame poller.`, 'adb-warning');
  }
}

/**
 * Start with the poller so there is a picture immediately, and ask for the
 * video stream in parallel; if it comes up it takes over, and if it never does
 * the poller is already running.
 */
function startMirror() {
  mirrorLive = true;
  liveFeedText.textContent = 'STOP MIRROR';
  btnLiveFeed.classList.add('active', 'btn-primary');
  btnLiveFeed.classList.remove('btn-secondary');
  phoneScreenContainer.classList.add('mirror-live');
  appendTerminalLine('[MIRROR] Live mirror ON. Click to tap, drag to swipe, hold to long-press, right-click for back.', 'adb-info');
  pullMirrorFrame();
  mirrorTimer = setInterval(pullMirrorFrame, MIRROR_INTERVAL_MS);
  socket.send({ type: 'mirror_stream_start' });
}

function stopMirror() {
  mirrorLive = false;
  clearInterval(mirrorTimer);
  mirrorTimer = null;
  socket.send({ type: 'mirror_stream_stop' });
  liveFeedText.textContent = 'LIVE MIRROR';
  btnLiveFeed.classList.remove('active', 'btn-primary');
  btnLiveFeed.classList.add('btn-secondary');
  phoneScreenContainer.classList.remove('mirror-live');
  appendTerminalLine('[MIRROR] Live mirror stopped.', 'system');
}

btnLiveFeed.addEventListener('click', () => (mirrorLive ? stopMirror() : startMirror()));
if (liveFeedText) liveFeedText.textContent = 'LIVE MIRROR';

/**
 * Where the mirror image actually paints inside its element.
 *
 * The live mirror uses `object-fit: contain`, so a 9:16 frame showing a taller
 * 1080x2400 screen letterboxes it. Mapping a click against the element box
 * instead of the painted box skews every tap horizontally — and would put the
 * agent's element overlay in the wrong place too. Both use this.
 */
function nxImageContentRect(img) {
  const r = img.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!r.width || !r.height) return null;
  if (!nw || !nh) return { left: r.left, top: r.top, width: r.width, height: r.height };

  const contained = getComputedStyle(img).objectFit === 'contain';
  const scale = contained
    ? Math.min(r.width / nw, r.height / nh)
    : Math.max(r.width / nw, r.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  return {
    left: r.left + (r.width - width) / 2,
    top: r.top + (r.height - height) / 2,
    width,
    height
  };
}
window.nxImageContentRect = nxImageContentRect;

/** Hold this long without moving and the tap becomes a long press. */
const LONG_PRESS_MS = 450;

const mirrorKeyButtons = Array.from(document.querySelectorAll('.mirror-key'));

function setMirrorKeysEnabled(on) {
  for (const btn of mirrorKeyButtons) btn.disabled = !on;
}

/**
 * Press a hardware key. The server validates the name against its own
 * allowlist, so an unknown one fails there rather than reaching the device.
 */
async function sendMirrorKey(key) {
  try {
    const res = await fetch('/api/mirror/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    if (mirrorTimer) setTimeout(pullMirrorFrame, 150);
  } catch (err) {
    appendTerminalLine(`[MIRROR] Key "${key}" failed: ${err.message}`, 'adb-error');
  }
}

setMirrorKeysEnabled(false);
for (const btn of mirrorKeyButtons) {
  btn.addEventListener('click', () => sendMirrorKey(btn.dataset.key));
}

(function wireMirrorInput() {
  let down = null;

  function norm(e) {
    const r = nxImageContentRect(phoneScreenshot);
    if (!r || !r.width || !r.height) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    };
  }

  async function sendSwipe(x1, y1, x2, y2, duration) {
    await fetch('/api/mirror/swipe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x1, y1, x2, y2, duration })
    });
    if (mirrorTimer) setTimeout(pullMirrorFrame, 100);
  }

  phoneScreenshot.setAttribute('draggable', 'false');
  phoneScreenshot.addEventListener('dragstart', (e) => e.preventDefault());

  phoneScreenshot.addEventListener('pointerdown', (e) => {
    // Only the primary button drags. Middle and right have their own meanings
    // below, and without this they would also register as taps on release.
    if (!mirrorLive || e.button !== 0) return;
    e.preventDefault();
    try { phoneScreenshot.setPointerCapture(e.pointerId); } catch {  }
    down = { pt: norm(e), t: Date.now() };
  });

  phoneScreenshot.addEventListener('pointerup', async (e) => {
    if (!mirrorLive || e.button !== 0 || !down || !down.pt) { down = null; return; }
    try { phoneScreenshot.releasePointerCapture(e.pointerId); } catch {  }
    const up = norm(e);
    const dist = up ? Math.hypot(up.x - down.pt.x, up.y - down.pt.y) : 0;
    const held = Date.now() - down.t;
    try {
      if (dist > 0.03) {
        await sendSwipe(down.pt.x, down.pt.y, up.x, up.y, Math.max(80, Math.min(500, held)));
      } else if (held >= LONG_PRESS_MS) {
        // A swipe that never moves is how `input` expresses a long press.
        await sendSwipe(down.pt.x, down.pt.y, down.pt.x, down.pt.y, Math.min(1500, held));
      } else {
        await fetch('/api/mirror/tap', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: down.pt.x, y: down.pt.y })
        });
        if (mirrorTimer) setTimeout(pullMirrorFrame, 120);
      }
    } catch (err) {
      appendTerminalLine(`[MIRROR] Input failed: ${err.message}`, 'adb-error');
    }
    down = null;
  });

  // scrcpy's conventions: right-click goes back, middle-click goes home.
  phoneScreenshot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (mirrorLive) sendMirrorKey('back');
  });

  phoneScreenshot.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || !mirrorLive) return;
    e.preventDefault();
    sendMirrorKey('home');
  });

  // A static frame is a snapshot of where the screen *was*; tapping it would
  // land wherever the phone has moved on to since. Start the mirror instead.
  phoneScreenshot.addEventListener('click', () => {
    if (mirrorLive || btnLiveFeed.disabled) return;
    appendTerminalLine('[MIRROR] Starting live mirror — a static frame is not safe to tap.', 'adb-info');
    startMirror();
  });

  let wheelLock = false;
  let wheelAccum = 0;
  phoneScreenshot.addEventListener('wheel', (e) => {
    if (!mirrorLive) return;
    e.preventDefault();
    wheelAccum += e.deltaY;
    if (wheelLock) return;
    wheelLock = true;

    const dir = wheelAccum > 0 ? 1 : -1;
    wheelAccum = 0;
    const cx = 0.5;
    const y1 = dir > 0 ? 0.68 : 0.32;
    const y2 = dir > 0 ? 0.32 : 0.68;
    sendSwipe(cx, y1, cx, y2, 140).catch((err) => {
      appendTerminalLine(`[MIRROR] Scroll failed: ${err.message}`, 'adb-error');
    });
    setTimeout(() => { wheelLock = false; }, 170);
  }, { passive: false });
})();

/**
 * PC keyboard passthrough.
 *
 * Focus the phone frame (click it) and your keystrokes go to the phone instead
 * of the browser; Esc gives the keyboard back. Printable characters are
 * buffered and sent as one `input text` call — a round trip per character runs
 * ~200ms each and typing would fall hopelessly behind.
 *
 * Everything goes through one promise chain, so a buffered word is always
 * flushed before the Backspace or Enter that follows it.
 */
(function wireKeyboardPassthrough() {
  const frame = document.getElementById('phone-frame');
  const screen = document.getElementById('phone-screen-container');
  if (!frame) return;

  const NAMED_KEYS = {
    Backspace: 'delete',
    Enter: 'enter',
    Tab: 'tab',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right'
  };

  const FLUSH_DELAY_MS = 120;

  let buffer = '';
  let flushTimer = null;
  let queue = Promise.resolve();
  let hint = null;

  const enqueue = (fn) => { queue = queue.then(fn).catch(() => {  }); return queue; };

  async function flushNow() {
    const text = buffer;
    buffer = '';
    if (!text) return;
    try {
      const res = await fetch('/api/mirror/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }
      if (mirrorTimer) setTimeout(pullMirrorFrame, 150);
    } catch (err) {
      appendTerminalLine(`[MIRROR] Typing failed: ${err.message}`, 'adb-error');
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; enqueue(flushNow); }, FLUSH_DELAY_MS);
  }

  function flushPending() {
    clearTimeout(flushTimer);
    flushTimer = null;
    enqueue(flushNow);
  }

  function showHint(on) {
    if (on && !hint && screen) {
      hint = document.createElement('div');
      hint.className = 'kbd-hint';
      hint.textContent = 'KEYBOARD → PHONE · ESC TO RELEASE';
      screen.appendChild(hint);
    } else if (!on && hint) {
      hint.remove();
      hint = null;
    }
  }

  frame.addEventListener('focus', () => {
    frame.classList.add('kbd-active');
    showHint(true);
  });

  frame.addEventListener('blur', () => {
    flushPending();
    frame.classList.remove('kbd-active');
    showHint(false);
  });

  frame.addEventListener('keydown', (e) => {
    // Leave browser shortcuts (copy, reload, devtools) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      frame.blur();
      return;
    }

    const named = NAMED_KEYS[e.key];
    if (named) {
      e.preventDefault();
      flushPending();
      enqueue(() => sendMirrorKey(named));
      return;
    }

    if (e.key.length === 1) {
      e.preventDefault();
      buffer += e.key;
      scheduleFlush();
    }
  });
})();

const btnRecord = document.getElementById('btn-record');
const recordText = document.getElementById('record-text');
let recordingActive = false;
if (btnRecord) {
  btnRecord.addEventListener('click', async () => {
    btnRecord.disabled = true;
    try {
      if (!recordingActive) {
        const r = await (await fetch('/api/record/start', { method: 'POST' })).json();
        if (r.success) {
          recordingActive = true;
          recordText.textContent = '■ STOP REC';
          btnRecord.classList.add('btn-primary');
          appendTerminalLine('[RECORD] Screen recording started (max 180s).', 'adb-info');
        } else { showToast('RECORD FAILED', r.error || 'could not start', 'error'); }
      } else {
        appendTerminalLine('[RECORD] Stopping + pulling video…', 'system');
        const r = await (await fetch('/api/record/stop', { method: 'POST' })).json();
        recordingActive = false;
        recordText.textContent = '● REC';
        btnRecord.classList.remove('btn-primary');
        if (r.success) {
          const a = document.createElement('a');
          a.href = r.url; a.download = r.fileName;
          document.body.appendChild(a); a.click(); a.remove();
          showToast('RECORDING SAVED', `${r.fileName} (${Math.round(r.size / 1024)} KB)`, 'success');
        } else { showToast('RECORD FAILED', r.error || 'could not stop', 'error'); }
      }
    } catch (e) {
      recordingActive = false; recordText.textContent = '● REC'; btnRecord.classList.remove('btn-primary');
      showToast('RECORD ERROR', e.message, 'error');
    } finally {
      btnRecord.disabled = false;
    }
  });
}

const btnInstallApk = document.getElementById('btn-install-apk');
const apkFileInput = document.getElementById('apk-file-input');
if (btnInstallApk && apkFileInput) {
  btnInstallApk.addEventListener('click', () => apkFileInput.click());
  apkFileInput.addEventListener('change', async () => {
    const file = apkFileInput.files && apkFileInput.files[0];
    if (!file) return;
    btnInstallApk.disabled = true;
    btnInstallApk.textContent = '📦 INSTALLING…';
    appendTerminalLine(`[APK] Installing ${file.name}…`, 'adb-info');
    try {
      const fd = new FormData();
      fd.append('apk', file);
      const r = await (await fetch('/api/apps/install', { method: 'POST', body: fd })).json();
      if (r.success) {
        showToast('APK INSTALLED', file.name, 'success');
        appendTerminalLine(`[APK] ${file.name} installed.`, 'adb-success');
      } else {
        showToast('INSTALL FAILED', r.error?.message || r.error || 'unknown', 'error');
      }
    } catch (e) {
      showToast('INSTALL FAILED', e.message, 'error');
    } finally {
      btnInstallApk.disabled = false;
      btnInstallApk.textContent = '📦 INSTALL APK ON PHONE';
      apkFileInput.value = '';
    }
  });
}

async function fetchScreenshot() {
  try {
    const res = await fetch('/api/screenshot');
    const data = await res.json();

    if (data.success) {
      phoneScreenshot.src = data.url;
      phoneScreenshot.classList.remove('hidden');
      screenFallback.classList.add('hidden');
      if (!liveFeedInterval) appendTerminalLine('[DIAGNOSTICS] Screencap successful.', 'adb-success');
    } else {
      appendTerminalLine(`[ERROR] Screencap failed: ${data.error}`, 'adb-error');
    }
  } catch (error) {
    appendTerminalLine(`[ERROR] Screencap fetch failed: ${error.message}`, 'adb-error');
  } finally {
    screenSpinner.classList.add('hidden');
  }
}


function submitCommand(opts = {}) {
  const text = cmdTextInput.value.trim();
  if (!text) return;

  // While the AGENT tab is open, the command box (and therefore voice, which
  // calls straight into here) drives the autonomous agent instead of the
  // single-shot NLP pipeline.
  if (window.nxAgentActive) {
    appendTerminalLine(`[AGENT] Task: "${text}"`, 'adb-info');
    socket.send(JSON.stringify({
      type: 'agent_task',
      text,
      source: opts.source === 'voice' ? 'voice' : 'text'
    }));
    cmdTextInput.value = '';
    return;
  }

  appendTerminalLine(`[INPUT] Sent Command: "${text}"`, 'system');
  const payload = { type: 'execute_command', command: text };
  if (Array.isArray(opts.alternatives) && opts.alternatives.length > 1) {
    payload.alternatives = opts.alternatives.slice(0, 5);
  }
  if (opts.source === 'voice') payload.source = 'voice';
  socket.send(JSON.stringify(payload));

  cmdTextInput.value = '';
}

btnSubmitCmd.addEventListener('click', submitCommand);
cmdTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCommand();
});


function showShutdownOverlay(seconds) {
  shutdownOverlay.classList.remove('hidden');
  shutdownCountdown.textContent = seconds;
}

function updateShutdownTimer(seconds) {
  shutdownCountdown.textContent = seconds;
}

function hideShutdownOverlay() {
  shutdownOverlay.classList.add('hidden');
}

btnAbortShutdown.addEventListener('click', () => {
  socket.send(JSON.stringify({ type: 'cancel_shutdown' }));
});


let editingContactId = null;

async function fetchContacts() {
  try {
    const res = await fetch('/api/contacts');
    const data = await res.json();
    contactsData = Array.isArray(data) ? data : [];
    renderContacts();
  } catch (err) {
    appendTerminalLine('[SYSTEM] Failed to load contacts.', 'adb-error');
  }
}

function renderContacts() {
  contactsListContainer.innerHTML = '';
  contactsData.forEach(contact => {
    const card = document.createElement('div');
    card.className = 'contact-card' + (contact.id === editingContactId ? ' editing' : '');

    card.innerHTML = `
      <div class="contact-info">
        <span class="contact-name"></span>
        <span class="contact-number"></span>
      </div>
      <div class="contact-actions">
        <button class="btn-icon btn-edit-contact" title="Edit">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button class="btn-icon btn-delete-contact" title="Delete">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </div>
    `;
    card.querySelector('.contact-name').textContent = contact.name;
    card.querySelector('.contact-number').textContent = '+' + contact.number;
    card.querySelector('.btn-edit-contact').addEventListener('click', () => startEditContact(contact));
    card.querySelector('.btn-delete-contact').addEventListener('click', () => deleteContact(contact.id));
    contactsListContainer.appendChild(card);
  });

  if (btnSaveContact) btnSaveContact.textContent = editingContactId ? 'UPDATE CONTACT' : 'SAVE CONTACT';
  drawConnectorPaths();
}

function startEditContact(contact) {
  editingContactId = contact.id;
  contactNameInput.value = contact.name;
  contactPhoneInput.value = contact.number;
  contactNameInput.focus();
  renderContacts();
}

function cancelEditContact() {
  editingContactId = null;
  contactNameInput.value = '';
  contactPhoneInput.value = '';
  renderContacts();
}

async function persistContacts(successMsg) {
  try {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contactsData)
    });
    if (res.ok) {
      appendTerminalLine(`[SYSTEM] ${successMsg}`, 'adb-success');
      return true;
    }
    const err = await res.json().catch(() => ({}));
    showToast('CONTACT SAVE FAILED', err.error?.message || `HTTP ${res.status}`, 'error');
  } catch (err) {
    showToast('CONTACT SAVE FAILED', err.message, 'error');
  }
  return false;
}

async function saveContact() {
  const name = contactNameInput.value.trim();
  const phone = contactPhoneInput.value.trim().replace(/[^0-9+]/g, '');

  if (!name || !/^\+?[0-9]{6,15}$/.test(phone)) {
    showToast('INVALID CONTACT', 'Enter a name and a 6-15 digit phone number.', 'warning');
    return;
  }

  const snapshot = JSON.parse(JSON.stringify(contactsData));
  if (editingContactId) {
    const c = contactsData.find(x => x.id === editingContactId);
    if (c) { c.name = name; c.number = phone; }
  } else {
    contactsData.push({ id: Date.now().toString(), name, number: phone });
  }

  const ok = await persistContacts(editingContactId ? `Updated contact: ${name}` : `Saved contact: ${name}`);
  if (!ok) { contactsData = snapshot; renderContacts(); return; }

  editingContactId = null;
  contactNameInput.value = '';
  contactPhoneInput.value = '';
  renderContacts();
}

async function deleteContact(id) {
  const target = contactsData.find(c => c.id === id);
  if (!(await confirmDialog(`Delete "${target?.name || 'this contact'}"?`, { okText: 'Delete', danger: true }))) return;
  const snapshot = JSON.parse(JSON.stringify(contactsData));
  contactsData = contactsData.filter(c => c.id !== id);
  if (editingContactId === id) cancelEditContact();
  const ok = await persistContacts('Contact deleted.');
  if (!ok) { contactsData = snapshot; }
  renderContacts();
}

btnSaveContact.addEventListener('click', saveContact);
contactPhoneInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveContact(); });


const cfgAutoUnlock = document.getElementById('cfg-auto-unlock');

async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    configData = await res.json();

    cfgPinInput.value = '';
    cfgPinInput.placeholder = configData.hasUnlockPin ? 'PIN saved — type to change' : 'Enter device unlock PIN code';
    if (cfgAutoUnlock) cfgAutoUnlock.checked = Boolean(configData.autoUnlock);
    cfgWxInput.value = configData.whatsappCoords ? configData.whatsappCoords.x : 0.91;
    cfgWyInput.value = configData.whatsappCoords ? configData.whatsappCoords.y : 0.55;
  } catch (err) {
    appendTerminalLine('[SYSTEM] Failed to load config settings.', 'adb-error');
  }
}

async function saveConfig() {
  const body = {
    whatsappCoords: {
      x: parseFloat(cfgWxInput.value) || 0.91,
      y: parseFloat(cfgWyInput.value) || 0.55
    }
  };
  const pin = cfgPinInput.value.trim();
  if (pin) body.unlockPin = pin;
  if (cfgAutoUnlock) body.autoUnlock = cfgAutoUnlock.checked;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      appendTerminalLine('[SYSTEM] System configuration applied.', 'adb-success');
      cfgPinInput.value = '';
      await fetchConfig();
      showToast('SETTINGS SAVED', 'System configuration applied.', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showToast('SAVE FAILED', err.error?.message || `HTTP ${res.status}`, 'error');
    }
  } catch (err) {
    showToast('SAVE FAILED', err.message, 'error');
  }
}

btnSaveConfig.addEventListener('click', saveConfig);

const btnTestUnlock = document.getElementById('btn-test-unlock');
if (btnTestUnlock) {
  btnTestUnlock.addEventListener('click', async () => {
    btnTestUnlock.disabled = true;
    appendTerminalLine('[UNLOCK] Testing phone unlock...', 'system');
    try {
      const res = await fetch('/api/unlock', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        appendTerminalLine(
          data.alreadyUnlocked ? '[UNLOCK] Phone was already unlocked.' : '[UNLOCK] Phone unlocked successfully.',
          'adb-success'
        );
      } else {
        appendTerminalLine(`[UNLOCK] Failed: ${data.error?.message || data.error || res.status}`, 'adb-error');
      }
    } catch (e) {
      appendTerminalLine(`[UNLOCK] Failed: ${e.message}`, 'adb-error');
    } finally {
      btnTestUnlock.disabled = false;
    }
  });
}


const tabMap = {
  'tab-btn-agent': 'tab-content-agent',
  'tab-btn-contacts': 'tab-content-contacts',
  'tab-btn-files': 'tab-content-files',
  'tab-btn-macros': 'tab-content-macros',
  'tab-btn-ai': 'tab-content-ai',
  'tab-btn-settings': 'tab-content-settings'
};

Object.keys(tabMap).forEach(btnId => {
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.addEventListener('click', () => {
      Object.keys(tabMap).forEach(id => {
        const tabBtn = document.getElementById(id);
        const tabContent = document.getElementById(tabMap[id]);
        if (tabBtn) tabBtn.classList.remove('active');
        if (tabContent) tabContent.classList.add('hidden');
      });
      btn.classList.add('active');
      const content = document.getElementById(tabMap[btnId]);
      if (content) content.classList.remove('hidden');
      window.nxAgentActive = btnId === 'tab-btn-agent';
      cmdTextInput.placeholder = window.nxAgentActive
        ? "Describe a task… (e.g. 'airplane mode on kar do')"
        : "Give a command (e.g. 'Yash ko call karo' or 'Shutdown PC')...";
      drawConnectorPaths();
    });
  }
});


fetchContacts();
fetchConfig();

setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'request_diagnostics' }));
  }
}, 5000);


const btnSyncContacts = document.getElementById('btn-sync-contacts');
if (btnSyncContacts) {
  btnSyncContacts.addEventListener('click', async () => {
    btnSyncContacts.disabled = true;
    btnSyncContacts.textContent = 'SYNCING...';
    appendTerminalLine('[CONTACTS] Initiating phone contacts sync via ADB...', 'system');

    try {
      const res = await fetch('/api/sync-contacts', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        appendTerminalLine(`[CONTACTS] Sync complete! ${data.totalSynced} found on device, ${data.newAdded} new contacts added. Total: ${data.totalContacts}`, 'adb-success');
        if (typeof window.vaniSpeak === 'function') {
          window.vaniSpeak(`Contacts synced. ${data.newAdded} new contacts imported from your phone.`);
        }
        await fetchContacts();
      } else {
        throw new Error(data.error || 'Sync failed');
      }
    } catch (err) {
      appendTerminalLine(`[CONTACTS] Sync failed: ${err.message}`, 'adb-error');
      if (typeof window.vaniSpeak === 'function') {
        window.vaniSpeak('Contact sync failed. Please check device connection.');
      }
    } finally {
      btnSyncContacts.disabled = false;
      btnSyncContacts.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> SYNC PHONE CONTACTS`;
    }
  });
}

const btnClearContacts = document.getElementById('btn-clear-contacts');
if (btnClearContacts) {
  btnClearContacts.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete ALL contacts? This cannot be undone.', { okText: 'Delete all', danger: true }))) return;

    btnClearContacts.disabled = true;
    try {
      const res = await fetch('/api/contacts', { method: 'DELETE' });
      if (res.ok) {
        contactsData = [];
        renderContacts();
        appendTerminalLine('[SYSTEM] All contacts cleared successfully.', 'adb-success');
        if (typeof window.vaniSpeak === 'function') {
          window.vaniSpeak('All contacts have been deleted successfully.');
        }
      }
    } catch (err) {
      showToast('CLEAR FAILED', err.message, 'error');
    } finally {
      btnClearContacts.disabled = false;
    }
  });
}


const btnWireless = document.getElementById('btn-wireless-toggle');
const wirelessStatus = document.getElementById('wireless-status');
let isWirelessActive = false;

if (btnWireless) {
  btnWireless.addEventListener('click', async () => {
    btnWireless.disabled = true;

    if (!isWirelessActive) {
      btnWireless.textContent = 'ENABLING...';
      appendTerminalLine('[WIRELESS] Enabling wireless ADB mode...', 'system');

      try {
        const res = await fetch('/api/wireless/enable', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          isWirelessActive = true;
          appendTerminalLine(`[WIRELESS] Wireless ADB active at ${data.ip}:${data.port}. You can remove the USB cable now!`, 'adb-success');
          if (wirelessStatus) {
            wirelessStatus.textContent = `ACTIVE (${data.ip}:${data.port})`;
            wirelessStatus.className = 'wireless-status active';
          }
          btnWireless.textContent = 'DISABLE WIRELESS';
          btnWireless.classList.add('wireless-on');
          if (typeof window.vaniSpeak === 'function') {
            window.vaniSpeak(`Wireless mode activated. You can now remove the USB cable. Device IP is ${data.ip}.`);
          }
        } else {
          throw new Error(data.error || 'Failed');
        }
      } catch (err) {
        appendTerminalLine(`[WIRELESS] Enable failed: ${err.message}`, 'adb-error');
        if (typeof window.vaniSpeak === 'function') {
          window.vaniSpeak('Wireless mode activation failed.');
        }
      }
    } else {
      btnWireless.textContent = 'DISABLING...';
      appendTerminalLine('[WIRELESS] Disabling wireless ADB...', 'system');

      try {
        const res = await fetch('/api/wireless/disable', { method: 'POST' });
        const data = await res.json();

        isWirelessActive = false;
        if (wirelessStatus) {
          wirelessStatus.textContent = 'INACTIVE (USB ONLY)';
          wirelessStatus.className = 'wireless-status';
        }
        btnWireless.textContent = 'ENABLE WIRELESS';
        btnWireless.classList.remove('wireless-on');
        appendTerminalLine('[WIRELESS] Reverted to USB transport.', 'adb-success');
      } catch (err) {
        appendTerminalLine(`[WIRELESS] Disable failed: ${err.message}`, 'adb-error');
      }
    }

    btnWireless.disabled = false;
  });
}


// --- Cable-free pairing (Android 11+ Wireless debugging) --------------------
const btnPair = document.getElementById('btn-wireless-pair');
const btnConnect = document.getElementById('btn-wireless-connect');
const pairAddress = document.getElementById('wl-pair-address');
const pairCode = document.getElementById('wl-pair-code');
const connectAddress = document.getElementById('wl-connect-address');
const pairStatus = document.getElementById('wl-pair-status');

function setPairStatus(text, ok) {
  if (!pairStatus) return;
  pairStatus.textContent = text;
  pairStatus.className = ok ? 'wireless-status active' : 'wireless-status';
}

// The server does the real validation; this only keeps an obviously incomplete
// entry from costing the user a round trip and a 21s adb timeout.
function looksLikeHostPort(value) {
  return /^[A-Za-z0-9.\-[\]:]+:\d{1,5}$/.test(String(value || '').trim());
}

async function postWireless(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

if (btnPair) {
  btnPair.addEventListener('click', async () => {
    const address = (pairAddress?.value || '').trim();
    const code = (pairCode?.value || '').trim();

    if (!looksLikeHostPort(address)) {
      appendTerminalLine('[PAIR] Enter the pairing address as host:port, e.g. 192.168.1.7:37123', 'adb-error');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      appendTerminalLine('[PAIR] Enter the 6-digit code shown on the phone.', 'adb-error');
      return;
    }

    btnPair.disabled = true;
    btnPair.textContent = 'PAIRING...';
    setPairStatus('PAIRING...', false);
    appendTerminalLine(`[PAIR] Pairing with ${address}...`, 'system');

    try {
      await postWireless('/api/wireless/pair', { address, code });
      setPairStatus('PAIRED — NOW CONNECT', true);
      appendTerminalLine('[PAIR] Paired. Now enter the IP & Port from the Wireless debugging screen and hit CONNECT.', 'adb-success');
      if (pairCode) pairCode.value = '';
      // The connect host is the same phone; only the port differs, so prefill
      // the host and leave the port for the user to read off the screen.
      if (connectAddress && !connectAddress.value) {
        connectAddress.value = `${address.slice(0, address.lastIndexOf(':'))}:`;
      }
      connectAddress?.focus();
    } catch (err) {
      setPairStatus('PAIRING FAILED', false);
      appendTerminalLine(`[PAIR] ${err.message}`, 'adb-error');
    }

    btnPair.textContent = 'PAIR DEVICE';
    btnPair.disabled = false;
  });
}

if (btnConnect) {
  btnConnect.addEventListener('click', async () => {
    const address = (connectAddress?.value || '').trim();

    if (!looksLikeHostPort(address)) {
      appendTerminalLine('[PAIR] Enter the connect address as host:port, e.g. 192.168.1.7:41235', 'adb-error');
      return;
    }

    btnConnect.disabled = true;
    btnConnect.textContent = 'CONNECTING...';
    setPairStatus('CONNECTING...', false);
    appendTerminalLine(`[PAIR] Connecting to ${address}...`, 'system');

    try {
      await postWireless('/api/wireless/connect', { address });
      setPairStatus(`CONNECTED (${address})`, true);
      appendTerminalLine(`[PAIR] Connected wirelessly to ${address}. No cable needed.`, 'adb-success');
      if (typeof window.vaniSpeak === 'function') {
        window.vaniSpeak('Wireless device connected.');
      }
    } catch (err) {
      setPairStatus('CONNECT FAILED', false);
      appendTerminalLine(`[PAIR] ${err.message}`, 'adb-error');
    }

    btnConnect.textContent = 'CONNECT';
    btnConnect.disabled = false;
  });
}
