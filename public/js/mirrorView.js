/**
 * Mirror sizing: collapse, drag-to-resize, and a maximized overlay.
 *
 * The phone frame used to be pinned at `max-height: 380px` inside the fixed
 * 320px column, so a 1080x2400 screen painted about 171x380 — too small to read.
 * Height now comes from `--mirror-h` on the wrapper, which the drag handle
 * writes and localStorage remembers. Past roughly 580px the frame's width caps
 * the image, so MAXIMIZE lifts it out of the column entirely rather than
 * pretending the drag can keep helping.
 *
 * Tap mapping and the agent's element overlay both measure the image live
 * (`nxImageContentRect`, a ResizeObserver in agentConsole.js), so they follow
 * whatever size we set here without needing to be told.
 */
(function mirrorView() {
  const wrapper = document.getElementById('screen-mirror-wrapper');
  const frame = document.getElementById('phone-frame');
  if (!wrapper || !frame) return;

  const handle = document.getElementById('mirror-resize');
  const keybar = document.querySelector('.mirror-keybar');
  const btnCollapse = document.getElementById('btn-mirror-collapse');
  const btnExpand = document.getElementById('btn-mirror-expand');
  const img = document.getElementById('phone-screenshot');

  const MIN_H = 200;
  const FALLBACK_H = 420;
  /**
   * Floor for the automatic height, for windows too short to fit even this.
   * Below it the panel scrolls rather than shrinking the mirror into a stamp.
   */
  const MIN_FIT_H = 320;
  const KEY_H = 'nx_mirror_height';
  const KEY_COLLAPSED = 'nx_mirror_collapsed';

  const maxH = () => Math.max(MIN_H, Math.round(window.innerHeight * 0.72));
  const clamp = (h) => Math.min(maxH(), Math.max(MIN_H, Math.round(h)));

  /**
   * The tallest the frame can be without pushing the buttons under it out of
   * the panel: whatever it is now, plus the slack left between the last control
   * row and the visible bottom of the scroll container. That slack goes negative
   * once we have overflowed, so this shrinks as readily as it grows, and it
   * re-fits itself to whatever window the user is on.
   *
   * Anchored on the control row rather than the wrapper: the wrapper is a
   * `flex: 1` item, so its box is whatever flex handed it and its children
   * overflow it silently — measuring that would always read zero slack.
   */
  function fitHeight() {
    const panel = wrapper.closest('.panel-content');
    if (!panel || collapsed || isMaximized()) return heightPx;

    const frameRect = frame.getBoundingClientRect();
    const anchor = wrapper.querySelector('.mirror-controls') || wrapper.lastElementChild;
    if (!frameRect.height || !anchor) return heightPx;

    const paddingBottom = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
    const slack = panel.getBoundingClientRect().bottom - paddingBottom
      - anchor.getBoundingClientRect().bottom;

    return clamp(Math.max(MIN_FIT_H, frameRect.height + slack));
  }

  let heightPx = FALLBACK_H;
  let collapsed = false;
  let backdrop = null;
  // Where the frame and key bar live when not maximized, so they can go back.
  let homeParent = null;
  let homeNext = null;
  let keybarNext = null;

  function readStore(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch {  }
  }

  function setHeight(h, persist) {
    heightPx = clamp(h);
    wrapper.style.setProperty('--mirror-h', `${heightPx}px`);
    if (persist) writeStore(KEY_H, String(heightPx));
  }

  function setCollapsed(on, persist) {
    collapsed = on;
    wrapper.classList.toggle('is-collapsed', on);
    if (btnCollapse) {
      btnCollapse.innerHTML = on ? '&#9633;' : '&#9644;';
      btnCollapse.title = on ? 'Show the mirror' : 'Collapse the mirror';
    }
    if (persist) writeStore(KEY_COLLAPSED, on ? '1' : '0');
  }

  function isMaximized() {
    return wrapper.classList.contains('is-maximized');
  }

  function setMaximized(on) {
    // Expanding something that is hidden would show an empty overlay.
    if (on && collapsed) setCollapsed(false, true);

    wrapper.classList.toggle('is-maximized', on);
    frame.classList.toggle('is-maximized', on);
    if (keybar) keybar.classList.toggle('is-maximized', on);

    if (on) {
      // Reparent to <body>: `.hud-panel`'s backdrop-filter is the containing
      // block for fixed-position descendants, so left where they are the frame
      // and key bar stay pinned inside the 320px column no matter their
      // z-index — and the key bar would sit behind the backdrop unusable.
      if (!homeParent) {
        homeParent = frame.parentNode;
        homeNext = frame.nextSibling;
        keybarNext = keybar ? keybar.nextSibling : null;
      }
      document.body.appendChild(frame);
      if (keybar) document.body.appendChild(keybar);
    } else if (homeParent) {
      homeParent.insertBefore(frame, homeNext);
      if (keybar) homeParent.insertBefore(keybar, keybarNext);
      homeParent = null;
      homeNext = null;
      keybarNext = null;
    }

    if (on && !backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'mirror-backdrop';
      backdrop.addEventListener('click', () => setMaximized(false));
      document.body.appendChild(backdrop);
    } else if (!on && backdrop) {
      backdrop.remove();
      backdrop = null;
    }

    if (btnExpand) {
      btnExpand.title = on ? 'Shrink the mirror back into the panel' : 'Expand the mirror (Esc to close)';
    }
  }

  /** Match the frame's maximized shape to the real screen, not a guessed 9:16. */
  function syncAspect() {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    frame.style.setProperty('--mirror-aspect', `${img.naturalWidth} / ${img.naturalHeight}`);
  }

  const savedH = parseInt(readStore(KEY_H), 10);
  let userSized = Number.isFinite(savedH);
  setCollapsed(readStore(KEY_COLLAPSED) === '1', false);

  if (Number.isFinite(savedH)) {
    setHeight(savedH, false);
  } else {
    // No stored preference — open as large as the column allows. Measured after
    // a frame so the diagnostics above have laid out.
    setHeight(FALLBACK_H, false);
    requestAnimationFrame(() => setHeight(fitHeight(), false));
  }

  syncAspect();

  if (img) img.addEventListener('load', syncAspect);

  if (handle) {
    let startY = 0;
    let startH = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = heightPx;
      handle.classList.add('is-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {  }
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setHeight(startH + (e.clientY - startY), false);
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch {  }
      userSized = true;
      setHeight(heightPx, true);
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    // Double-click the handle to drop the custom height and re-fit the column.
    handle.addEventListener('dblclick', () => {
      try { localStorage.removeItem(KEY_H); } catch {  }
      userSized = false;
      setHeight(fitHeight(), false);
    });
  }

  if (btnCollapse) btnCollapse.addEventListener('click', () => setCollapsed(!collapsed, true));

  if (btnExpand) btnExpand.addEventListener('click', () => setMaximized(!isMaximized()));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMaximized()) setMaximized(false);
  });

  // Re-fit on resize while the height is still automatic; once the user has
  // dragged it, only re-clamp so a smaller window cannot strand it off-screen.
  window.addEventListener('resize', () => {
    setHeight(userSized ? heightPx : fitHeight(), false);
  });
})();
