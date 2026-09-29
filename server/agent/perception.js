/**
 * Perception layer for the phone-use agent.
 *
 * Turns the live phone screen into a compact, model-readable `ScreenState`:
 *   - `elements[]` from `uiautomator dump` (cheap, precise, every step)
 *   - an optional screenshot (vision, only when the loop asks for it)
 *
 * Every screen this produces is addressed by *element index*, so the agent taps
 * "#7 Search" rather than guessing pixel coordinates.
 */

import { runAdbArgs, assertDeviceId } from '../adb.js';
import { captureFrame } from '../screenMirror.js';

const DUMP_REMOTE_PATH = '/sdcard/nx_ui_dump.xml';
const MAX_ELEMENTS = 60;
const MAX_LABEL = 90;

/** Classes we always keep even without a label — they are the interactive bits. */
const ALWAYS_KEEP = /EditText|CheckBox|Switch|RadioButton|SeekBar|Spinner/i;

function unescapeXml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseBounds(raw) {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(raw || '').trim());
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 0 && h > 0)) return null;
  return { x: x1, y: y1, w, h, cx: Math.round(x1 + w / 2), cy: Math.round(y1 + h / 2) };
}

function shortClass(className) {
  const leaf = String(className || '').split('.').pop() || '';
  return leaf.replace(/^Android/, '') || 'View';
}

function kindOf(attrs) {
  const cls = shortClass(attrs['class']);
  if (/EditText/i.test(cls)) return 'input';
  if (/Switch|CheckBox|RadioButton|ToggleButton/i.test(cls)) return 'toggle';
  if (/Button|ImageButton/i.test(cls)) return 'button';
  if (/RecyclerView|ListView|ScrollView|ViewPager|NestedScroll/i.test(cls)) return 'scroller';
  if (/TextView/i.test(cls)) return attrs.clickable === 'true' ? 'button' : 'text';
  if (/Image/i.test(cls)) return 'image';
  return attrs.clickable === 'true' ? 'button' : 'view';
}

/** The human-visible label: what a person would call this thing. */
function labelOf(attrs) {
  const text = unescapeXml(attrs.text || '').trim();
  const desc = unescapeXml(attrs['content-desc'] || '').trim();
  return (text || desc).replace(/\s+/g, ' ').slice(0, MAX_LABEL);
}

/**
 * Fallback name from the resource id, for interactive nodes that carry no text
 * (icon buttons, mostly). Never used for plain layout containers — "content
 * parent", "nestedlayout" and friends are noise that crowds out real targets.
 */
function idLabelOf(attrs) {
  const rid = String(attrs['resource-id'] || '').split('/').pop() || '';
  return rid.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL);
}

/**
 * Parse a `uiautomator dump` XML document into interactive elements.
 * Exported separately so it can be tested against a fixture with no device.
 */
export function parseUiXml(xml) {
  const source = String(xml || '');
  const nodes = [];
  let screen = null;

  const nodeRe = /<node\b([^>]*?)\/?>/g;
  let match;
  while ((match = nodeRe.exec(source)) !== null) {
    const attrs = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(match[1])) !== null) attrs[a[1]] = a[2];

    const bounds = parseBounds(attrs.bounds);
    if (!bounds) continue;

    // The widest node is the screen itself — use it as the resolution.
    if (!screen || bounds.w * bounds.h > screen.w * screen.h) screen = bounds;

    if (attrs.enabled === 'false') continue;

    const clickable = attrs.clickable === 'true' || attrs['long-clickable'] === 'true';
    const scrollable = attrs.scrollable === 'true';
    const keepAnyway = ALWAYS_KEEP.test(String(attrs['class'] || ''));
    const interactive = clickable || scrollable || keepAnyway;

    // Keep anything a person can read, and anything they can touch. Drop the
    // rest: an unlabelled, untouchable node is a layout wrapper.
    const textLabel = labelOf(attrs);
    if (!textLabel && !interactive) continue;
    const label = textLabel || idLabelOf(attrs);

    nodes.push({
      label,
      kind: kindOf(attrs),
      className: shortClass(attrs['class']),
      resourceId: String(attrs['resource-id'] || '').split('/').pop() || '',
      clickable,
      scrollable,
      checked: attrs.checked === 'true',
      checkable: attrs.checkable === 'true',
      focused: attrs.focused === 'true',
      password: attrs.password === 'true',
      bounds
    });
  }

  const width = screen ? screen.w : 1080;
  const height = screen ? screen.h : 2400;

  const screenArea = width * height;
  const area = (n) => n.bounds.w * n.bounds.h;
  const contains = (outer, inner) =>
    inner.bounds.x >= outer.bounds.x &&
    inner.bounds.y >= outer.bounds.y &&
    inner.bounds.x + inner.bounds.w <= outer.bounds.x + outer.bounds.w &&
    inner.bounds.y + inner.bounds.h <= outer.bounds.y + outer.bounds.h;

  // Android list rows are an unlabelled clickable container wrapping a labelled
  // TextView. Neither half is usable alone, so give the label the container's
  // clickability and drop the container. Tapping the label still hits the row.
  const absorbed = new Set();
  for (const node of nodes) {
    if (!node.label || node.clickable) continue;
    let host = null;
    for (const other of nodes) {
      if (other === node || other.label || !other.clickable || other.scrollable) continue;
      if (area(other) > screenArea * 0.6 || !contains(other, node)) continue;
      if (!host || area(other) < area(host)) host = other;
    }
    if (host) {
      node.clickable = true;
      node.viaParent = true;
      absorbed.add(host);
    }
  }

  // A settings row often reports `checked` on the row *and* on the real Switch
  // nested inside it — and the row's copy can be stale, which would tell the
  // agent a toggle is off when it is on. The inner widget is the truth; the
  // outer row has the label and the tappable area. Merge them.
  for (const outer of nodes) {
    if (absorbed.has(outer) || !outer.checkable) continue;
    let widget = null;
    for (const inner of nodes) {
      if (inner === outer || absorbed.has(inner) || !inner.checkable) continue;
      if (area(inner) >= area(outer) || !contains(outer, inner)) continue;
      if (!widget || area(inner) < area(widget)) widget = inner;
    }
    if (widget) {
      outer.checked = widget.checked;
      absorbed.add(widget);
    }
  }

  // Whatever is left that overlaps almost exactly is a genuine duplicate
  // (e.g. a FrameLayout and the TextView filling it). Keep the richer one.
  const deduped = [];
  for (const node of nodes) {
    if (absorbed.has(node)) continue;
    const twin = deduped.find((other) =>
      Math.abs(other.bounds.cx - node.bounds.cx) < 12 &&
      Math.abs(other.bounds.cy - node.bounds.cy) < 12 &&
      (other.label === node.label || !other.label || !node.label)
    );
    if (!twin) {
      deduped.push(node);
      continue;
    }
    const better = (node.clickable && !twin.clickable) || (node.label && !twin.label);
    if (better) deduped[deduped.indexOf(twin)] = { ...twin, ...node, label: node.label || twin.label };
  }

  deduped.sort((a, b) => (a.bounds.cy - b.bounds.cy) || (a.bounds.cx - b.bounds.cx));

  const elements = deduped.slice(0, MAX_ELEMENTS).map((node, index) => ({
    index,
    ...node,
    // Normalized centre — what the tap primitives and the UI overlay both use.
    nx: Number((node.bounds.cx / width).toFixed(4)),
    ny: Number((node.bounds.cy / height).toFixed(4)),
    box: {
      x: Number((node.bounds.x / width).toFixed(4)),
      y: Number((node.bounds.y / height).toFixed(4)),
      w: Number((node.bounds.w / width).toFixed(4)),
      h: Number((node.bounds.h / height).toFixed(4))
    }
  }));

  return { elements, width, height, truncated: deduped.length > MAX_ELEMENTS };
}

/** Run `uiautomator dump` on the device and return the parsed elements. */
export async function dumpUi(deviceId) {
  const id = deviceId ? assertDeviceId(deviceId) : null;
  const prefix = id ? ['-s', id] : [];
  await runAdbArgs([...prefix, 'shell', 'uiautomator', 'dump', DUMP_REMOTE_PATH], { timeout: 15000 });
  const xml = await runAdbArgs([...prefix, 'exec-out', 'cat', DUMP_REMOTE_PATH], {
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!xml || !xml.includes('<node')) throw new Error('uiautomator returned an empty hierarchy');
  return parseUiXml(xml);
}

/** Foreground package/activity, used for the app allowlist and for context. */
export async function getForegroundApp(deviceId) {
  const prefix = deviceId ? ['-s', assertDeviceId(deviceId)] : [];
  const probes = [
    'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"',
    'dumpsys activity activities | grep -E "mResumedActivity"'
  ];
  for (const probe of probes) {
    try {
      const out = await runAdbArgs([...prefix, 'shell', probe], { timeout: 8000 });
      const m = /([A-Za-z][\w.]+)\/([\w.$]+)/.exec(out || '');
      if (m) return { appPackage: m[1], activity: m[2] };
    } catch {  }
  }
  return { appPackage: null, activity: null };
}

/**
 * One full observation of the phone.
 * Never throws: on failure it returns a `degraded` state so the agent can fall
 * back to coordinate taps on the screenshot instead of giving up.
 */
export async function captureState({ deviceId, withImage = false } = {}) {
  const state = {
    elements: [],
    width: 1080,
    height: 2400,
    appPackage: null,
    activity: null,
    imageB64: null,
    degraded: false,
    error: null
  };

  // These three ADB calls are independent, and perception runs before every
  // single action — doing them in sequence adds seconds to every step. Start
  // them together and sort the results out afterwards.
  const [ui, app, frame] = await Promise.all([
    dumpUi(deviceId).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    getForegroundApp(deviceId).catch(() => ({ appPackage: null, activity: null })),
    withImage ? captureFrame(deviceId).catch(() => ({ success: false })) : Promise.resolve(null)
  ]);

  state.appPackage = app.appPackage;
  state.activity = app.activity;

  if (ui.ok) {
    state.elements = ui.value.elements;
    state.width = ui.value.width;
    state.height = ui.value.height;
    state.truncated = ui.value.truncated;
  } else {
    // Animations, secure screens and some launchers refuse to dump. Fall back
    // to vision-only.
    state.degraded = true;
    state.error = ui.error.message;
  }

  if (frame?.success) {
    state.imageB64 = frame.buffer.toString('base64');
  } else if (state.degraded) {
    // The caller did not ask for an image, but without a hierarchy it is the
    // only thing the agent can work from — so it is worth a second round trip.
    const fallback = frame || await captureFrame(deviceId).catch(() => ({ success: false }));
    if (fallback.success) state.imageB64 = fallback.buffer.toString('base64');
    else state.error = `${state.error || 'dump failed'}; screenshot also failed`;
  }

  return state;
}

/** Compact text rendering of a state — this is what the model reads each step. */
export function serializeForModel(state) {
  const lines = [];
  lines.push(`Screen ${state.width}x${state.height}${state.appPackage ? ` · app: ${state.appPackage}` : ''}`);

  if (state.degraded) {
    lines.push('WARNING: the UI hierarchy could not be read on this screen.');
    lines.push('Use the screenshot and tap_xy with normalized coordinates instead of tap_element.');
    return lines.join('\n');
  }

  if (!state.elements.length) {
    lines.push('No interactive elements found. Try swipe, press_key, or tap_xy.');
    return lines.join('\n');
  }

  lines.push('Elements (index, kind, label, normalized centre):');
  for (const el of state.elements) {
    const flags = [
      el.clickable ? 'clickable' : '',
      el.scrollable ? 'scrollable' : '',
      el.checkable ? (el.checked ? 'checked' : 'unchecked') : '',
      el.focused ? 'focused' : '',
      el.password ? 'PASSWORD-FIELD' : ''
    ].filter(Boolean).join(',');
    const label = el.label ? `"${el.label}"` : '(no label)';
    lines.push(`#${el.index} [${el.kind}] ${label} (${el.nx},${el.ny})${flags ? ` {${flags}}` : ''}`);
  }
  if (state.truncated) lines.push(`(list truncated to ${MAX_ELEMENTS} elements)`);
  return lines.join('\n');
}

/**
 * Stable fingerprint of a screen, used to detect "nothing changed" / stuck loops.
 */
export function screenSignature(state) {
  if (!state) return 'none';
  if (state.degraded) return `degraded:${state.appPackage || '?'}`;
  const labels = state.elements.map((e) => `${e.kind}:${e.label}`).join('|');
  let hash = 5381;
  for (let i = 0; i < labels.length; i++) hash = ((hash * 33) ^ labels.charCodeAt(i)) >>> 0;
  return `${state.appPackage || '?'}:${state.elements.length}:${hash.toString(36)}`;
}

/** Elements as the browser overlay needs them: index, label and a normalized box. */
export function overlayElements(state) {
  return (state?.elements || []).map((el) => ({
    index: el.index,
    label: el.label,
    kind: el.kind,
    box: el.box
  }));
}
