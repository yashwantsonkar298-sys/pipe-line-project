// ==========================================================================
// Vani AI chat panel. Talks to the server over the shared WebSocket
// (`ai_chat` out; `ai_delta` / `ai_reply` / `ai_action` / `confirm_request` in).
// ==========================================================================
(function () {
  const log = document.getElementById('ai-chat-log');
  const input = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  const statusEl = document.getElementById('ai-status');
  if (!log || !input || !sendBtn) return;

  function addMsg(text, who) {
    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-' + who;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  let thinkingEl = null;
  function setThinking(on) {
    if (on && !thinkingEl) {
      thinkingEl = addMsg('Vani is thinking…', 'bot');
      thinkingEl.classList.add('ai-msg-thinking');
    } else if (!on && thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    setThinking(true);
    try {
      socket.send(JSON.stringify({ type: 'ai_chat', message: text }));
    } catch (e) {
      setThinking(false);
      addMsg('Could not reach the server.', 'bot');
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    switch (data.type) {
      case 'ai_delta':
        if (data.text) { setThinking(false); addMsg(data.text, 'bot'); setThinking(true); }
        break;
      case 'ai_action':
        addMsg('→ ' + (data.tool || data.intent), 'action');
        break;
      case 'ai_reply':
        setThinking(false);
        if (data.reply) addMsg(data.reply, 'bot');
        break;
      case 'ai_event':
        if (data.error && data.reply) { setThinking(false); addMsg(data.reply, 'bot'); }
        break;
    }
  });

  // Show whether the server has an API key configured.
  fetch('/api/ai/status')
    .then((r) => r.json())
    .then((s) => {
      if (!statusEl) return;
      statusEl.textContent = s.enabled
        ? 'Vani online · ' + s.model
        : 'Vani is disabled — set ANTHROPIC_API_KEY on the server to enable it.';
      statusEl.classList.toggle('ai-status-off', !s.enabled);
    })
    .catch(() => {});
})();
