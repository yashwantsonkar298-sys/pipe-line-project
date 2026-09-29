/**
 * Agent Console — the live view of an autonomous run.
 *
 * Owns its own WebSocket listener (the pattern aiChat.js uses) so app.js's
 * message switch stays untouched. Renders four things:
 *   1. the numbered element overlay on the live mirror, with the next target lit
 *   2. the plan the agent made before it started
 *   3. a streaming log of what it is thinking and doing
 *   4. a per-step trace rail you can click to replay
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const taskInput = $('agent-task-input');
  const btnRun = $('agent-btn-run');
  const btnStop = $('agent-btn-stop');
  const btnMic = $('agent-btn-mic');
  const dryRunToggle = $('agent-dry-run');
  const statusChip = $('agent-status-chip');
  const meterSteps = $('agent-meter-steps');
  const meterCost = $('agent-meter-cost');
  const meterFill = $('agent-meter-fill');
  const planList = $('agent-plan-list');
  const streamEl = $('agent-stream');
  const railEl = $('agent-trace-rail');
  const btnSaveMacro = $('agent-btn-save-macro');
  const btnRuns = $('agent-btn-runs');
  const statusLine = $('agent-status-line');
  const overlay = $('agent-overlay');
  const phoneImg = $('phone-screenshot');
  const phoneScreen = $('phone-screen-container');
  const btnLiveFeed = $('btn-live-feed');

  if (!taskInput || !btnRun || !overlay) return;

  let running = false;
  let currentRunId = null;
  let lastGoodRunId = null;
  let steps = [];
  let maxSteps = 25;

  // ---------------------------------------------------------------- overlay --

  let overlayElements = [];
  let highlightIndex = null;

  /** Keep the overlay aligned with the painted image, not the element box. */
  function positionOverlay() {
    if (!phoneImg || phoneImg.classList.contains('hidden') || !overlayElements.length) {
      overlay.classList.add('hidden');
      return;
    }
    const rect = window.nxImageContentRect
      ? window.nxImageContentRect(phoneImg)
      : phoneImg.getBoundingClientRect();
    const host = phoneScreen.getBoundingClientRect();
    if (!rect || !rect.width) { overlay.classList.add('hidden'); return; }

    overlay.classList.remove('hidden');
    overlay.style.left = `${rect.left - host.left}px`;
    overlay.style.top = `${rect.top - host.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function renderOverlay() {
    overlay.innerHTML = '';
    for (const el of overlayElements) {
      const box = el.box || {};
      if (typeof box.x !== 'number') continue;
      const node = document.createElement('div');
      node.className = 'agent-mark' + (el.index === highlightIndex ? ' agent-mark-target' : '');
      node.style.left = `${box.x * 100}%`;
      node.style.top = `${box.y * 100}%`;
      node.style.width = `${box.w * 100}%`;
      node.style.height = `${box.h * 100}%`;
      node.dataset.kind = el.kind || 'view';

      const tag = document.createElement('span');
      tag.className = 'agent-mark-tag';
      tag.textContent = String(el.index);
      node.appendChild(tag);

      if (el.label) node.title = `#${el.index} ${el.label}`;
      overlay.appendChild(node);
    }
    positionOverlay();
  }

  function clearOverlay() {
    overlayElements = [];
    highlightIndex = null;
    overlay.innerHTML = '';
    overlay.classList.add('hidden');
  }

  window.addEventListener('resize', positionOverlay);
  if (phoneImg) phoneImg.addEventListener('load', positionOverlay);

  /**
   * The mirror is user-resizable (drag handle, collapse, maximize), and none of
   * that fires a window resize — so watch the frame itself, or the element boxes
   * would stay pinned to the mirror's previous size.
   */
  if (window.ResizeObserver && phoneScreen) {
    new ResizeObserver(positionOverlay).observe(phoneScreen);
  }

  /** A tap landed — show where, briefly. */
  function rippleAt(nx, ny) {
    if (overlay.classList.contains('hidden')) return;
    const dot = document.createElement('div');
    dot.className = 'agent-ripple';
    dot.style.left = `${nx * 100}%`;
    dot.style.top = `${ny * 100}%`;
    overlay.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }

  // ------------------------------------------------------------ status / UI --

  const PHASE_LABEL = {
    planning: 'PLANNING',
    perceiving: 'PERCEIVING',
    thinking: 'THINKING',
    acting: 'ACTING',
    awaiting_confirm: 'AWAITING YOU'
  };

  function setStatus(label, tone = '') {
    statusChip.textContent = label;
    statusChip.className = 'agent-chip' + (tone ? ` agent-chip-${tone}` : '');
  }

  function setRunning(on) {
    running = on;
    btnRun.disabled = on;
    btnStop.disabled = !on;
    taskInput.disabled = on;
    if (dryRunToggle) dryRunToggle.disabled = on;
  }

  function compactTokens(n) {
    if (!n) return '0 tok';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
  }

  function updateMeter(budget) {
    if (!budget) return;
    maxSteps = budget.maxSteps || maxSteps;
    meterSteps.textContent = `${budget.steps}/${budget.maxSteps}`;
    // Tokens, not dollars: on the Gemini free tier the cost is zero and the
    // limit that actually bites is requests per minute.
    meterCost.textContent = compactTokens(budget.totalTokens || 0);
    const byStep = budget.steps / Math.max(1, budget.maxSteps);
    const byCost = (budget.costUsd || 0) / Math.max(0.01, budget.costCapUsd || 1);
    meterFill.style.width = `${Math.min(100, Math.max(byStep, byCost) * 100)}%`;
    meterFill.classList.toggle('agent-meter-hot', Math.max(byStep, byCost) > 0.75);
  }

  function say(text, kind = 'info') {
    const line = document.createElement('div');
    line.className = `agent-line agent-line-${kind}`;
    line.textContent = text;
    streamEl.appendChild(line);
    streamEl.scrollTop = streamEl.scrollHeight;
    while (streamEl.childElementCount > 200) streamEl.firstElementChild.remove();
  }

  function renderPlan(subgoals) {
    planList.innerHTML = '';
    if (!subgoals || !subgoals.length) {
      planList.innerHTML = '<li class="agent-plan-empty">No plan — acting directly.</li>';
      return;
    }
    for (const goal of subgoals) {
      const li = document.createElement('li');
      li.className = 'agent-plan-item';
      li.textContent = goal;
      planList.appendChild(li);
    }
  }

  function markPlanDone(ok) {
    for (const li of planList.querySelectorAll('.agent-plan-item')) {
      li.classList.add(ok ? 'agent-plan-done' : 'agent-plan-failed');
    }
  }

  // ------------------------------------------------------------- trace rail --

  /**
   * Grab the current mirror frame as a thumbnail. Free — the mirror is already
   * polling, so this costs no extra ADB round trip.
   */
  function snapshotThumb() {
    try {
      if (!phoneImg || phoneImg.classList.contains('hidden') || !phoneImg.naturalWidth) return null;
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = Math.round(120 * (phoneImg.naturalHeight / phoneImg.naturalWidth));
      canvas.getContext('2d').drawImage(phoneImg, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.6);
    } catch {
      return null;
    }
  }

  const OUTCOME_ICON = { ok: '✓', failed: '✕', blocked: '⛔', declined: '✋', dry_run: '◎' };

  function addTraceCard(entry) {
    steps.push(entry);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `agent-card agent-card-${entry.outcome}`;
    card.title = entry.thought || entry.description;

    if (entry.thumb) {
      const img = document.createElement('img');
      img.src = entry.thumb;
      img.alt = '';
      card.appendChild(img);
    } else {
      const blank = document.createElement('div');
      blank.className = 'agent-card-blank';
      blank.textContent = String(entry.step);
      card.appendChild(blank);
    }

    const label = document.createElement('span');
    label.className = 'agent-card-label';
    label.textContent = `${OUTCOME_ICON[entry.outcome] || '·'} ${entry.description}`;
    card.appendChild(label);

    card.addEventListener('click', () => showStep(entry));
    railEl.appendChild(card);
    railEl.scrollLeft = railEl.scrollWidth;
  }

  function showStep(entry) {
    for (const c of railEl.querySelectorAll('.agent-card')) c.classList.remove('agent-card-active');
    const index = steps.indexOf(entry);
    railEl.children[index]?.classList.add('agent-card-active');
    statusLine.textContent = `Step ${entry.step}: ${entry.description} — ${entry.outcome}`
      + (entry.thought ? ` · "${entry.thought}"` : '');
  }

  function resetRun() {
    steps = [];
    railEl.innerHTML = '';
    streamEl.innerHTML = '';
    planList.innerHTML = '';
    statusLine.textContent = '';
    btnSaveMacro.classList.add('hidden');
    clearOverlay();
  }

  // ------------------------------------------------------------------ start --

  function ensureMirror() {
    // The overlay is drawn on the mirror, so make sure it is streaming.
    if (btnLiveFeed && !btnLiveFeed.disabled && !phoneScreen.classList.contains('mirror-live')) {
      btnLiveFeed.click();
    }
  }

  function run() {
    const text = taskInput.value.trim();
    if (!text || running) return;
    ensureMirror();
    resetRun();
    setRunning(true);
    setStatus('STARTING', 'busy');
    socket.send(JSON.stringify({ type: 'agent_task', text, source: 'text' }));
    taskInput.value = '';
  }

  btnRun.addEventListener('click', run);
  taskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  btnStop.addEventListener('click', () => {
    socket.send(JSON.stringify({ type: 'agent_abort' }));
    setStatus('STOPPING', 'warn');
    btnStop.disabled = true;
  });

  if (btnMic) {
    btnMic.addEventListener('click', () => {
      // Reuse the existing voice pipeline: it fills the centre box and calls
      // submitCommand, which routes here while the AGENT tab is open.
      document.getElementById('btn-voice-trigger')?.click();
    });
  }

  if (dryRunToggle) {
    dryRunToggle.addEventListener('change', async () => {
      try {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentDryRun: dryRunToggle.checked })
        });
        say(dryRunToggle.checked
          ? 'Dry run ON — the agent will stop before anything irreversible.'
          : 'Dry run OFF — irreversible steps will ask you to confirm.', 'meta');
      } catch (e) {
        say(`Could not change dry run: ${e.message}`, 'error');
      }
    });
  }

  btnSaveMacro.addEventListener('click', async () => {
    if (!lastGoodRunId) return;
    const name = prompt('Name this macro:', 'Learned run');
    if (!name) return;
    btnSaveMacro.disabled = true;
    try {
      const res = await fetch(`/api/agent/traces/${encodeURIComponent(lastGoodRunId)}/save-as-macro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast('MACRO SAVED', `"${data.macro.name}" replays with no AI call.`, 'success');
        say(`Saved as macro "${data.macro.name}" — ${data.macro.primitives?.length || 0} recorded actions.`, 'good');
        if (typeof window.loadMacros === 'function') window.loadMacros();
      } else {
        showToast('SAVE FAILED', data.error?.message || data.error || 'unknown', 'error');
      }
    } catch (e) {
      showToast('SAVE FAILED', e.message, 'error');
    } finally {
      btnSaveMacro.disabled = false;
    }
  });

  if (btnRuns) {
    btnRuns.addEventListener('click', async () => {
      try {
        const { traces } = await (await fetch('/api/agent/traces')).json();
        if (!traces.length) return showToast('NO RUNS YET', 'Run a task first.', 'warning');
        const pick = prompt(
          'Load a past run:\n\n' + traces.slice(0, 10)
            .map((t, i) => `${i + 1}. ${t.result?.ok ? '✓' : '✕'} ${t.task} (${t.stepCount} steps)`)
            .join('\n'),
          '1'
        );
        const chosen = traces[Number(pick) - 1];
        if (chosen) loadTrace(chosen.runId);
      } catch (e) {
        showToast('LOAD FAILED', e.message, 'error');
      }
    });
  }

  async function loadTrace(runId) {
    const trace = await (await fetch(`/api/agent/traces/${encodeURIComponent(runId)}`)).json();
    resetRun();
    currentRunId = trace.runId;
    lastGoodRunId = trace.result?.ok ? trace.runId : null;
    renderPlan(trace.subgoals);
    say(`Replaying run: "${trace.task}"`, 'meta');
    for (const s of trace.steps || []) {
      addTraceCard({
        step: s.step,
        description: s.description,
        outcome: s.outcome,
        thought: s.thought,
        thumb: s.screenshot ? `/api/agent/traces/${encodeURIComponent(runId)}/step/${s.step}.png` : null
      });
      if (s.thought) say(`${s.step}. ${s.thought}`, 'thought');
      say(`   → ${s.description} (${s.outcome})`, s.outcome === 'ok' ? 'good' : 'warn');
    }
    if (trace.result) {
      markPlanDone(trace.result.ok);
      setStatus(trace.result.ok ? 'REPLAY · OK' : 'REPLAY · FAILED', trace.result.ok ? 'good' : 'bad');
      statusLine.textContent = trace.result.summary || '';
      if (trace.result.ok) btnSaveMacro.classList.remove('hidden');
    }
  }

  // ------------------------------------------------------------ WS handling --

  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case 'agent_trace':
        currentRunId = data.runId;
        break;

      case 'agent_start':
        setRunning(true);
        resetRun();
        currentRunId = currentRunId || null;
        maxSteps = data.maxSteps || 25;
        setStatus('PLANNING', 'busy');
        say(`Task: ${data.task}`, 'meta');
        if (data.dryRun) say('DRY RUN — will stop before anything irreversible.', 'warn');
        updateMeter({ steps: 0, maxSteps: data.maxSteps, costUsd: 0, costCapUsd: data.costCapUsd });
        break;

      case 'agent_plan':
        renderPlan(data.subgoals);
        updateMeter(data.budget);
        break;

      case 'agent_phase':
        if (PHASE_LABEL[data.phase]) {
          setStatus(PHASE_LABEL[data.phase], data.phase === 'awaiting_confirm' ? 'warn' : 'busy');
        }
        if (data.phase === 'awaiting_confirm') say(`Waiting for you: ${data.description}`, 'warn');
        break;

      case 'agent_observe':
        overlayElements = data.elements || [];
        highlightIndex = null;
        renderOverlay();
        if (data.degraded) say('Screen hierarchy unreadable — falling back to vision.', 'warn');
        break;

      case 'agent_step':
        if (data.thought) say(`${data.step}. ${data.thought}`, 'thought');
        updateMeter(data.budget);
        break;

      case 'agent_verify':
        if (data.changed === false) {
          say(`   screen unchanged${data.repeats > 1 ? ` (×${data.repeats})` : ''}`, 'warn');
        }
        break;

      case 'agent_action': {
        if (data.target && typeof data.target.index === 'number') {
          highlightIndex = data.target.index;
          renderOverlay();
          const box = data.target.box;
          if (box) rippleAt(box.x + box.w / 2, box.y + box.h / 2);
        }
        say(`   → ${data.description} (${data.outcome})`,
          data.outcome === 'ok' ? 'good' : data.outcome === 'blocked' ? 'error' : 'warn');
        if (data.reason && data.outcome !== 'ok') say(`     ${data.reason}`, 'meta');
        addTraceCard({
          step: data.step,
          description: data.description,
          outcome: data.outcome,
          thought: data.detail || '',
          thumb: snapshotThumb()
        });
        break;
      }

      case 'agent_ask':
        setStatus('NEEDS YOU', 'warn');
        say(`? ${data.question}`, 'ask');
        showToast('AGENT NEEDS YOU', data.question, 'warning');
        break;

      case 'agent_event':
        say(data.message, data.level === 'warn' ? 'warn' : 'meta');
        break;

      case 'agent_done': {
        setRunning(false);
        updateMeter(data.budget);
        markPlanDone(data.ok);
        highlightIndex = null;
        renderOverlay();

        const toneByReason = { aborted: 'warn', dry_run: 'warn', ask_user: 'warn' };
        setStatus(
          data.ok ? 'DONE' : (data.reason || 'STOPPED').toUpperCase().replace('_', ' '),
          data.ok ? 'good' : (toneByReason[data.reason] || 'bad')
        );
        say(data.summary || (data.ok ? 'Done.' : 'Stopped.'), data.ok ? 'good' : 'error');
        const tokens = data.budget?.totalTokens || 0;
        statusLine.textContent = `${data.steps} steps · ${compactTokens(tokens)} · ${data.summary || ''}`;

        if (data.ok && currentRunId && data.reason === 'finished') {
          lastGoodRunId = currentRunId;
          btnSaveMacro.classList.remove('hidden');
        }
        currentRunId = null;
        break;
      }
    }
  });

  // --------------------------------------------------------------- bootstrap --

  fetch('/api/agent/status')
    .then((r) => r.json())
    .then((s) => {
      maxSteps = s.maxSteps || 25;
      if (dryRunToggle) dryRunToggle.checked = Boolean(s.dryRun);
      updateMeter({ steps: 0, maxSteps: s.maxSteps, costUsd: 0, costCapUsd: s.costCapUsd });
      if (!s.aiEnabled) {
        setStatus('AI OFF', 'bad');
        btnRun.disabled = true;
        taskInput.disabled = true;
        taskInput.placeholder = 'Add GEMINI_API_KEY to .env and restart';
        say('Vani Autopilot needs GEMINI_API_KEY in .env — get a free key at aistudio.google.com.', 'error');
        say('No key? Run with NEXUSFLOW_AI_PROVIDER=mock to drive the phone from a scripted run.', 'meta');
      } else if (s.provider === 'mock') {
        setStatus('MOCK', 'warn');
        say('Mock provider — scripted decisions, no API calls. The phone is still driven for real.', 'warn');
      } else {
        setStatus('READY');
        say(`Autopilot ready · ${s.model} · up to ${s.maxSteps} steps, paced at ${s.requestsPerMinute}/min.`, 'meta');
      }
    })
    .catch(() => setStatus('OFFLINE', 'bad'));

  setRunning(false);
})();
