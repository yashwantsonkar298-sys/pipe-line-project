// ==========================================================================
// NexusFlow Voice Processing, TTS Engine & Waveform Visualization
// ==========================================================================

// ==========================================================================
// FEATURE 2: Vani Text-to-Speech (TTS) Response Engine
// ==========================================================================

const speechSynth = window.speechSynthesis;
let vaniVoice = null;

// Load and cache best female voice for Vani
function loadVaniVoice() {
  const voices = speechSynth.getVoices();
  // Prefer Indian English female, then any English female, then default
  vaniVoice = voices.find(v => v.lang.includes('en-IN') && v.name.toLowerCase().includes('female')) ||
              voices.find(v => v.lang.includes('en-IN')) ||
              voices.find(v => v.lang.includes('en') && v.name.toLowerCase().includes('female')) ||
              voices.find(v => v.lang.includes('en-GB')) ||
              voices.find(v => v.lang.includes('en-US')) ||
              voices[0] || null;
  
  if (vaniVoice) {
    console.log(`[VANI TTS] Voice loaded: ${vaniVoice.name} (${vaniVoice.lang})`);
  }
}

// Voices load asynchronously in some browsers
if (speechSynth.onvoiceschanged !== undefined) {
  speechSynth.onvoiceschanged = loadVaniVoice;
}
loadVaniVoice();

/**
 * Vani speaks the given text aloud using browser TTS.
 * Exposed globally so app.js can call it on pipeline events.
 */
function vaniSpeak(text) {
  if (!speechSynth || !text) return;
  
  // Cancel any ongoing speech first
  speechSynth.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.1;
  utterance.volume = 1.0;
  
  if (vaniVoice) {
    utterance.voice = vaniVoice;
  }
  
  utterance.onstart = () => {
    if (typeof appendTerminalLine === 'function') {
      appendTerminalLine(`[VANI TTS] Speaking: "${text}"`, 'adb-info');
    }
  };
  
  speechSynth.speak(utterance);
}

// Expose globally for app.js to use
window.vaniSpeak = vaniSpeak;

const btnVoiceTrigger = document.getElementById('btn-voice-trigger');
const btnSttLang = document.getElementById('btn-stt-lang');
const waveformWrapper = document.getElementById('waveform-wrapper');
const voiceCanvas = document.getElementById('voice-canvas');
const cmdInput = document.getElementById('cmd-text-input');
const canvasCtx = voiceCanvas.getContext('2d');

let SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let SpeechGrammarList = window.SpeechGrammarList || window.webkitSpeechGrammarList;
let recognition = null;
let isListening = false;

// --- STT language (Hinglish default) -------------------------------------
const STT_LANGS = ['hi-IN', 'en-IN'];
function getSttLang() {
  try {
    const v = localStorage.getItem('nx_stt_lang');
    return STT_LANGS.includes(v) ? v : 'hi-IN';
  } catch { return 'hi-IN'; }
}
function setSttLang(lang) {
  try { localStorage.setItem('nx_stt_lang', lang); } catch { /* ignore */ }
  if (recognition) recognition.lang = lang;
  if (btnSttLang) btnSttLang.textContent = lang === 'hi-IN' ? 'हिं' : 'EN';
}
let sttLang = getSttLang();

// --- N-best capture + settle-before-submit ------------------------------
let lastAlternatives = [];
let settleTimer = null;
let watchdogTimer = null;
let restartPending = false;
const SETTLE_MS = 1200;      // wait for trailing words before auto-submitting
const WATCHDOG_MS = 12000;   // hard stop if no final result arrives
let autoSend = true;

function clearTimers() {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

function submitSettled() {
  clearTimers();
  const text = cmdInput.value.trim();
  if (!text) return;
  if (typeof submitCommand === 'function') {
    submitCommand({ alternatives: lastAlternatives.slice(0, 5), source: 'voice', lang: sttLang });
  }
  lastAlternatives = [];
  forceStop = true;
  try { recognition.stop(); } catch { /* ignore */ }
  setTimeout(() => stopListeningState(), 400);
}

// Audio Visualizer states
let audioCtx = null;
let analyser = null;
let microphone = null;
let javascriptNode = null;
let animationFrameId = null;
let isMicAccessGranted = false;
let wavePhase = 0; // Phase for fallback animation

// Advanced Pro-Max Speech Engine States
let forceStop = false;

// Initialize Speech Recognition if supported
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;      // keep the mic open across pauses
  recognition.interimResults = true;  // live transcription
  recognition.maxAlternatives = 5;    // N-best: the server picks the best one
  recognition.lang = sttLang;

  // Best-effort grammar bias toward contact names + command verbs. Chrome
  // desktop mostly ignores JSGF, but it is harmless where unsupported.
  try {
    if (SpeechGrammarList) {
      const names = (window.contactsData || []).map((c) => (c.name || '').toLowerCase()).filter(Boolean);
      const verbs = ['vani', 'call', 'whatsapp', 'message', 'flashlight', 'torch', 'volume', 'brightness',
        'photo', 'unlock', 'shutdown', 'open', 'play', 'pause', 'next', 'previous', 'home', 'back', 'screenshot'];
      const terms = [...new Set([...verbs, ...names])].join(' | ');
      if (terms) {
        const gl = new SpeechGrammarList();
        gl.addFromString(`#JSGF V1.0; grammar cmd; public <cmd> = ${terms} ;`, 1);
        recognition.grammars = gl;
      }
    }
  } catch { /* ignore grammar failures */ }

  recognition.onstart = () => {
    isListening = true;
    forceStop = false;
    restartPending = false;
    btnVoiceTrigger.classList.add('active');
    waveformWrapper.classList.remove('hidden');
    startAudioVisualizer();
    clearTimers();
    watchdogTimer = setTimeout(() => {
      if (typeof appendTerminalLine === 'function') appendTerminalLine('[SPEECH] No speech detected - stopped listening.', 'adb-debug');
      forceStop = true;
      try { recognition.stop(); } catch { /* ignore */ }
    }, WATCHDOG_MS);
    if (typeof appendTerminalLine === 'function') {
      appendTerminalLine(`[SPEECH] Listening (${sttLang}). Speak your command...`, 'system');
    }
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) {
        // Capture EVERY alternative for this final segment, best first.
        const alts = [];
        for (let j = 0; j < result.length; j++) {
          const t = (result[j].transcript || '').trim();
          if (t) alts.push(t);
        }
        if (alts.length) {
          lastAlternatives = alts;
          cmdInput.value = alts[0];
          if (typeof appendTerminalLine === 'function') {
            const extra = alts.length > 1 ? ` (+${alts.length - 1} alt)` : '';
            appendTerminalLine(`[SPEECH] Heard: "${alts[0]}"${extra}`, 'adb-success');
          }
          // Restart the settle timer on every final segment so trailing
          // words ("... aur flashlight on karo") are not cut off.
          if (autoSend) {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(submitSettled, SETTLE_MS);
          }
        }
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    if (interimTranscript) {
      cmdInput.value = interimTranscript;
      // A new interim after a final means the user is still talking - hold off.
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = setTimeout(submitSettled, SETTLE_MS); }
    }
  };

  recognition.onerror = (event) => {
    // no-speech / aborted are normal during continuous listening - stay quiet.
    if (event.error === 'no-speech' || event.error === 'aborted') {
      if (typeof appendTerminalLine === 'function') appendTerminalLine(`[SPEECH] ${event.error}`, 'adb-debug');
      return;
    }
    if (typeof appendTerminalLine === 'function') {
      appendTerminalLine(`[SPEECH ERROR] ${event.error}`, 'warning');
    }
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'network') {
      forceStop = true;
      clearTimers();
      stopListeningState();
    }
  };

  recognition.onend = () => {
    // If a settle timer is pending we already have a transcript - let it fire.
    if (!forceStop && isListening && !settleTimer && !restartPending) {
      restartPending = true;
      setTimeout(() => {
        restartPending = false;
        if (!forceStop && isListening) {
          try { recognition.start(); } catch { stopListeningState(); }
        }
      }, 250);
    } else if (forceStop || !isListening) {
      stopListeningState();
    }
  };
} else {
  btnVoiceTrigger.style.display = 'none';
  if (btnSttLang) btnSttLang.style.display = 'none';
  console.warn('SpeechRecognition is not supported in this browser.');
}

// Language toggle (हिं / EN)
if (btnSttLang) {
  btnSttLang.textContent = sttLang === 'hi-IN' ? 'हिं' : 'EN';
  btnSttLang.addEventListener('click', () => {
    sttLang = sttLang === 'hi-IN' ? 'en-IN' : 'hi-IN';
    setSttLang(sttLang);
    if (isListening) {
      forceStop = true;
      try { recognition.stop(); } catch { /* ignore */ }
      setTimeout(() => { forceStop = false; try { recognition.start(); } catch { /* ignore */ } }, 300);
    }
    if (typeof appendTerminalLine === 'function') {
      appendTerminalLine(`[SPEECH] Recognition language -> ${sttLang}`, 'system');
    }
  });
}

// Typing in the box cancels the pending voice auto-submit (user is correcting).
cmdInput.addEventListener('input', () => {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
});

// Voice Trigger Click
btnVoiceTrigger.addEventListener('click', () => {
  if (!recognition) return;

  if (isListening) {
    // Manual stop: submit whatever we have if a transcript is waiting.
    forceStop = true;
    clearTimeout(settleTimer); settleTimer = null;
    if (autoSend && cmdInput.value.trim() && lastAlternatives.length) {
      submitSettled();
    } else {
      try { recognition.stop(); } catch { /* ignore */ }
    }
  } else {
    forceStop = false;
    lastAlternatives = [];
    try {
      recognition.start();
    } catch (e) {
      console.error(e);
      stopListeningState();
    }
  }
});

function stopListeningState() {
  isListening = false;
  forceStop = true;
  clearTimers();
  btnVoiceTrigger.classList.remove('active');
  waveformWrapper.classList.add('hidden');
  stopAudioVisualizer();
  if (cmdInput.value && !cmdInput.value.includes('vani')) {
    // optional clear if aborted halfway
  }
}

// ==========================================================================
// Canvas Waveform Visualizer Logic
// ==========================================================================

async function startAudioVisualizer() {
  // If analyser not yet initialized, request mic
  if (!audioCtx) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      isMicAccessGranted = true;
      
      // Setup Web Audio API
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      
      microphone = audioCtx.createMediaStreamSource(stream);
      microphone.connect(analyser);
    } catch (err) {
      console.warn('Microphone stream access denied. Falling back to synthetic visualizer wave.', err);
      isMicAccessGranted = false;
    }
  }

  // Resume context if suspended (browser security autoplay policies)
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Launch render loop
  drawWaveform();
}

function stopAudioVisualizer() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function drawWaveform() {
  animationFrameId = requestAnimationFrame(drawWaveform);

  const width = voiceCanvas.width;
  const height = voiceCanvas.height;

  // Clear canvas with dark glass gradient overlay
  canvasCtx.fillStyle = 'rgba(5, 8, 20, 0.2)';
  canvasCtx.fillRect(0, 0, width, height);

  if (isMicAccessGranted && analyser) {
    // 1. Draw Real Mic input wave
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgba(0, 240, 255, 0.8)';
    canvasCtx.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0; // scale value
      const y = (v * height) / 2;

      // Make it symmetric and centered
      const centerOff = height / 2;
      const waveVal = y - centerOff;

      if (i === 0) {
        canvasCtx.moveTo(x, centerOff + waveVal);
      } else {
        canvasCtx.lineTo(x, centerOff + waveVal);
      }

      x += sliceWidth;
    }

    canvasCtx.lineTo(width, height / 2);
    canvasCtx.stroke();

    // Draw secondary symmetric wave for visual punch (purple)
    canvasCtx.strokeStyle = 'rgba(189, 0, 255, 0.4)';
    canvasCtx.beginPath();
    x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * height) / 2;
      const centerOff = height / 2;
      const waveVal = y - centerOff;

      if (i === 0) {
        canvasCtx.moveTo(x, centerOff - waveVal);
      } else {
        canvasCtx.lineTo(x, centerOff - waveVal);
      }
      x += sliceWidth;
    }
    canvasCtx.lineTo(width, height / 2);
    canvasCtx.stroke();

  } else {
    // 2. Draw Synthetic Cyber Wave (Mock fallback)
    canvasCtx.lineWidth = 1.5;
    
    // Wave 1: Cyan
    canvasCtx.strokeStyle = 'rgba(0, 240, 255, 0.85)';
    canvasCtx.beginPath();
    wavePhase += 0.15;
    
    for (let x = 0; x < width; x++) {
      const angle = (x / width) * Math.PI * 6 + wavePhase;
      // Fade amplitude near edges
      const edgeScale = Math.sin((x / width) * Math.PI);
      const y = (height / 2) + Math.sin(angle) * 15 * edgeScale;
      
      if (x === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }
    }
    canvasCtx.stroke();

    // Wave 2: Purple (Slightly slower and out of phase)
    canvasCtx.strokeStyle = 'rgba(189, 0, 255, 0.6)';
    canvasCtx.beginPath();
    for (let x = 0; x < width; x++) {
      const angle = (x / width) * Math.PI * 4 - wavePhase * 0.8;
      const edgeScale = Math.sin((x / width) * Math.PI);
      const y = (height / 2) + Math.sin(angle) * 10 * edgeScale;
      
      if (x === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }
    }
    canvasCtx.stroke();
  }
}
