import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { randomUUID } from 'node:crypto';
import multer from 'multer';

// Import our custom modules
import {
  ensureAdbInstalled,
  getDeviceDiagnostics,
  captureScreen,
  setLogCallback,
  syncPhoneContacts,
  enableWirelessAdb,
  disableWirelessAdb
} from './adb.js';
import { configurePipeline, runCommandText } from './pipeline.js';
import {
  listPhoneFiles,
  pullFileFromPhone,
  pushFileToPhone,
  deletePhoneFile,
  createPhoneDirectory,
  getStorageInfo
} from './fileTransfer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Setup database file paths
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Initialize files if they don't exist
if (!fs.existsSync(CONTACTS_FILE)) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify([
    { id: '1', name: 'Mom', number: '9876543210' },
    { id: '2', name: 'Dad', number: '9876543211' },
    { id: '3', name: 'Yash', number: '9876543212' },
    { id: '4', name: 'Boss', number: '9876543213' }
  ], null, 2));
}

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    unlockPin: '',
    whatsappCoords: { x: 0.91, y: 0.55 }
  }, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Global state for PC shutdown timer
let shutdownTimer = null;
let shutdownTimeLeft = 10;

// HTTP API Routes
app.get('/api/contacts', (req, res) => {
  try {
    const data = fs.readFileSync(CONTACTS_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read contacts' });
  }
});

app.post('/api/contacts', (req, res) => {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save contacts' });
  }
});

app.delete('/api/contacts', (req, res) => {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify([], null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear contacts' });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config' });
  }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

app.get('/api/diagnostics', async (req, res) => {
  try {
    const diagnostics = await getDeviceDiagnostics();
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const screenshotPath = path.join(__dirname, '../public/screen.png');
    await captureScreen(screenshotPath);
    res.json({ success: true, url: '/screen.png?t=' + Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 3: Sync contacts from connected phone
app.post('/api/sync-contacts', async (req, res) => {
  try {
    const phoneContacts = await syncPhoneContacts();
    
    // Merge with existing contacts (avoid duplicates by number)
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    } catch (e) { /* empty */ }
    
    const existingNumbers = new Set(existing.map(c => c.number));
    let addedCount = 0;
    
    for (const pc of phoneContacts) {
      if (!existingNumbers.has(pc.number)) {
        existing.push(pc);
        existingNumbers.add(pc.number);
        addedCount++;
      }
    }
    
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(existing, null, 2));
    res.json({ 
      success: true, 
      totalSynced: phoneContacts.length, 
      newAdded: addedCount,
      totalContacts: existing.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 4: Wireless ADB toggle
app.post('/api/wireless/enable', async (req, res) => {
  try {
    const result = await enableWirelessAdb();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wireless/disable', async (req, res) => {
  try {
    const result = await disableWirelessAdb();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================================================
// FILE TRANSFER SYSTEM (Phase 1)
// ==========================================================================

// Setup multer for file uploads
const uploadsDir = path.join(__dirname, '../uploads');
const downloadsDir = path.join(__dirname, '../downloads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const upload = multer({ 
  dest: uploadsDir,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// Browse phone files
app.get('/api/files/list', async (req, res) => {
  try {
    const phonePath = req.query.path || '/sdcard';
    const result = await listPhoneFiles(phonePath);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload file to phone (PC → Phone)
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const phoneDest = req.body.destination || '/sdcard/Download';
    const originalName = req.file.originalname;
    
    // Rename temp file to original name
    const renamedPath = path.join(uploadsDir, originalName);
    fs.renameSync(req.file.path, renamedPath);
    
    // Push to phone
    const result = await pushFileToPhone(renamedPath, phoneDest);
    
    // Clean up uploaded file from PC
    try { fs.unlinkSync(renamedPath); } catch (e) { /* ignore */ }
    
    // Broadcast progress to all WS clients
    broadcast({ type: 'file_transfer_complete', action: 'upload', result });
    
    res.json(result);
  } catch (error) {
    // Clean up on error
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: error.message });
  }
});

// Download file from phone (Phone → PC)
app.get('/api/files/download', async (req, res) => {
  try {
    const phonePath = req.query.path;
    if (!phonePath) {
      return res.status(400).json({ error: 'No file path specified' });
    }
    
    const result = await pullFileFromPhone(phonePath, downloadsDir);
    
    if (result.success) {
      // Send file to browser for download
      res.download(result.localPath, result.fileName, (err) => {
        // Clean up after download
        try { fs.unlinkSync(result.localPath); } catch (e) { /* ignore */ }
      });
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete file on phone
app.delete('/api/files/delete', async (req, res) => {
  try {
    const { path: filePath, isDirectory } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'No file path specified' });
    }
    
    const result = await deletePhoneFile(filePath, isDirectory);
    broadcast({ type: 'file_transfer_complete', action: 'delete', result });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create directory on phone
app.post('/api/files/mkdir', async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath) {
      return res.status(400).json({ error: 'No directory path specified' });
    }
    
    const result = await createPhoneDirectory(dirPath);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get storage info
app.get('/api/files/storage', async (req, res) => {
  try {
    const result = await getStorageInfo();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Setup server and WebSockets
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Broadcast helper
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Connect ADB logs to WebSocket clients
setLogCallback((logObj) => {
  broadcast({ type: 'adb_log', log: logObj });
});

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Per-connection session: conversational NLP memory is isolated here so it is
  // never shared across clients. `requireConfirm` is tightened in P0 auth wiring.
  ws.session = {
    id: randomUUID(),
    nlpContext: { lastContact: null, pendingAction: null },
    requireConfirm: false,
    confirm: undefined
  };

  // Send immediate ADB status update
  getDeviceDiagnostics().then(diagnostics => {
    ws.send(JSON.stringify({ type: 'diagnostics', data: diagnostics }));
  });

  ws.on('message', async (messageData) => {
    try {
      const payload = JSON.parse(messageData);

      if (payload.type === 'execute_command') {
        await runCommandText(String(payload.command || ''), ws.session);
      }

      else if (payload.type === 'cancel_shutdown') {
        cancelPcShutdown();
      }

      else if (payload.type === 'request_diagnostics') {
        const diagnostics = await getDeviceDiagnostics();
        ws.send(JSON.stringify({ type: 'diagnostics', data: diagnostics }));
      }
    } catch (err) {
      console.error('[WS ERROR]', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

/**
 * Initiates 10-second PC Shutdown sequence with abort option
 */
function startPcShutdown() {
  cancelPcShutdown(); // Cancel any existing sequence
  
  shutdownTimeLeft = 10;
  broadcast({ type: 'shutdown_timer_start', seconds: shutdownTimeLeft });
  
  shutdownTimer = setInterval(() => {
    shutdownTimeLeft--;
    broadcast({ type: 'shutdown_timer_tick', seconds: shutdownTimeLeft });
    
    if (shutdownTimeLeft <= 0) {
      clearInterval(shutdownTimer);
      shutdownTimer = null;
      broadcast({ type: 'shutdown_timer_complete' });
      
      // Trigger actual OS shutdown
      console.log('[SYSTEM] Executing Windows PC Shutdown command...');
      exec('shutdown /s /t 0', (err) => {
        if (err) console.error('Shutdown failed', err);
      });
    }
  }, 1000);
}

/**
 * Aborts a running PC shutdown sequence
 */
function cancelPcShutdown() {
  if (shutdownTimer) {
    clearInterval(shutdownTimer);
    shutdownTimer = null;
    
    // Trigger abort command just in case standard shutdown timer got scheduled elsewhere
    exec('shutdown /a', (err) => {
      // Ignore errors (usually happens if no shutdown is in progress)
    });
    
    broadcast({ type: 'shutdown_timer_cancelled' });
    console.log('[SYSTEM] PC Shutdown sequence cancelled by user.');
  }
}

// Give the command pipeline its transport + PC-shutdown trigger.
configurePipeline({ broadcast, startPcShutdown });

// ==========================================================================
// Autonomous System Health Poller
// ==========================================================================
let lastAlertTime = 0;
setInterval(async () => {
  try {
    const diagnostics = await getDeviceDiagnostics();
    if (diagnostics && diagnostics.connected) {
      const isCritical = diagnostics.batteryLevel <= 15 || (diagnostics.batteryTemp && diagnostics.batteryTemp >= 40);
      const now = Date.now();
      // Only alert once every 5 minutes maximum
      if (isCritical && (now - lastAlertTime > 5 * 60 * 1000)) {
        lastAlertTime = now;
        broadcast({ 
          type: 'system_alert', 
          message: 'Warning: Device battery is low or temperature is critical.',
          ttsMessage: 'Warning! Device temperature or battery level is critical. Please check your device.'
        });
      }
    }
  } catch (e) {
    // Ignore errors for background poller
  }
}, 30000); // Check every 30 seconds

// Boot up
server.listen(PORT, () => {
  console.log(`\n[SERVER] NexusFlow v7.5 Pro-Max Running at http://localhost:${PORT}`);
  ensureAdbInstalled().catch(console.error);
  
  // Automatically open Google Chrome to ensure Web Speech API compatibility
  exec(`start chrome http://localhost:${PORT}`, (err) => {
    if (err) {
      console.log('[SERVER] Notice: Could not auto-launch Chrome. Please open it manually if needed.');
    } else {
      console.log('[SERVER] Successfully auto-launched Google Chrome for Max-Level Voice API support.');
    }
  });
});
