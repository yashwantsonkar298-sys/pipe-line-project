import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, 'bin');
const LOCAL_ADB_DIR = path.join(BIN_DIR, 'platform-tools');
const LOCAL_ADB_PATH = path.join(LOCAL_ADB_DIR, 'adb.exe');

let adbPath = 'adb';
let isAdbReady = false;

let logStreamCallback = null;
export function setLogCallback(callback) {
  logStreamCallback = callback;
}

function log(message, type = 'info') {
  console.log(`[ADB] [${type.toUpperCase()}] ${message}`);
  if (logStreamCallback) {
    logStreamCallback({ message, type, timestamp: new Date().toISOString() });
  }
}

export async function ensureAdbInstalled() {
  log('Checking ADB environment...', 'info');

  try {
    const { stdout } = await execAsync('adb version');
    log(`System ADB detected: ${stdout.trim().split('\n')[0]}`, 'success');
    adbPath = 'adb';
    isAdbReady = true;
    return true;
  } catch (err) {
    log('System ADB not found in PATH. Checking local installation...', 'info');
  }

  if (fs.existsSync(LOCAL_ADB_PATH)) {
    log(`Local ADB detected at: ${LOCAL_ADB_PATH}`, 'success');
    adbPath = LOCAL_ADB_PATH;
    isAdbReady = true;
    return true;
  }

  log('Local ADB not found. Starting automatic download from Google servers...', 'info');
  const adbUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
  const zipPath = path.join(BIN_DIR, 'platform-tools.zip');

  try {
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    log('Downloading Platform Tools zip...', 'info');
    const response = await fetch(adbUrl);
    if (!response.ok) {
      throw new Error(`Failed to download platform-tools: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(buffer));
    log('Download completed. Extracting archive...', 'info');

    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive', '-Path', zipPath, '-DestinationPath', BIN_DIR, '-Force'
    ]);
    log('Archive extracted successfully.', 'success');

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    if (fs.existsSync(LOCAL_ADB_PATH)) {
      adbPath = LOCAL_ADB_PATH;
      isAdbReady = true;
      log('Local ADB is now set up and ready to use.', 'success');
      return true;
    } else {
      throw new Error('ADB executable not found in extracted directory.');
    }
  } catch (error) {
    log(`ADB setup failed: ${error.message}. Please connect manual ADB.`, 'error');
    isAdbReady = false;
    return false;
  }
}

export async function runAdb(argsString) {
  if (!isAdbReady) {
    await ensureAdbInstalled();
  }

  const cmd = `"${adbPath}" ${argsString}`;
  // Log the command, not the 90-character absolute path in front of it. The
  // feed is read by a person watching what the phone is being asked to do, and
  // repeating where adb.exe lives on every line buried that entirely.
  log(`adb ${argsString}`, 'debug');
  try {
    const { stdout, stderr } = await execAsync(cmd);
    if (stderr && stderr.trim() && !stderr.includes('daemon started successfully')) {
      log(`ADB stderr warning: ${stderr.trim()}`, 'warning');
    }
    return stdout.trim();
  } catch (error) {
    log(`Command failed: ${cmd}. Error: ${error.message}`, 'error');
    throw error;
  }
}

export async function runAdbArgs(args, opts = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('runAdbArgs expects an array of string arguments');
  }
  if (!isAdbReady) {
    await ensureAdbInstalled();
  }
  const { timeout = 20000, maxBuffer = 8 * 1024 * 1024 } = opts;
  log(`adb ${args.join(' ')}`, 'debug');
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, { timeout, maxBuffer });
    if (stderr && stderr.trim() && !stderr.includes('daemon started successfully')) {
      log(`ADB stderr warning: ${stderr.trim()}`, 'warning');
    }
    return String(stdout).trim();
  } catch (error) {
    log(`Command failed: adb ${args.join(' ')}. Error: ${error.message}`, 'error');
    throw error;
  }
}

export function assertDeviceId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9.:_-]+$/.test(id)) {
    throw new Error(`Invalid device id: ${JSON.stringify(id)}`);
  }
  return id;
}

export function assertPackageName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(name)) {
    throw new Error(`Invalid package name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function assertComponent(component) {
  if (typeof component !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+\/[A-Za-z0-9_.]+$/.test(component)) {
    throw new Error(`Invalid component: ${JSON.stringify(component)}`);
  }
  return component;
}

export function deviceShellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validates an `host:port` pair typed by a human off the phone's Wireless
 * debugging screen. Both `pair` and `connect` addresses go through here before
 * they are handed to adb, so a pasted string can never become extra arguments.
 * The port is mandatory: Android randomises it per session, and a missing one
 * silently means 5555, which is the wrong port for the pairing flow.
 */
export function assertHostPort(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^([A-Za-z0-9.-]{1,255}|\[[0-9A-Fa-f:]{2,45}\]):([0-9]{1,5})$/.exec(text);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) {
    throw new Error(`Invalid address: ${JSON.stringify(value)}. Expected host:port, e.g. 192.168.1.7:37123`);
  }
  return text;
}

/** The 6-digit code Android shows in the "Pair device with pairing code" dialog. */
export function assertPairingCode(code) {
  const text = typeof code === 'string' ? code.trim() : '';
  if (!/^[0-9]{6}$/.test(text)) {
    throw new Error('Invalid pairing code: expected the 6 digits shown on the phone.');
  }
  return text;
}

export async function getDevices() {
  try {
    const output = await runAdb('devices');
    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    const devices = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length >= 2) {
        devices.push({
          id: parts[0],
          status: parts[1]
        });
      }
    }
    return devices;
  } catch (error) {
    return [];
  }
}

export async function getDeviceDiagnostics() {
  const devices = await getDevices();
  if (devices.length === 0) {
    return { connected: false, message: 'No devices connected. Connect via USB.' };
  }

  const deviceId = devices[0].id;
  try {
    const brand = await runAdb(`-s ${deviceId} shell getprop ro.product.brand`);
    const model = await runAdb(`-s ${deviceId} shell getprop ro.product.model`);
    const release = await runAdb(`-s ${deviceId} shell getprop ro.build.version.release`);

    const batteryDump = await runAdb(`-s ${deviceId} shell dumpsys battery`);
    const batteryLevelMatch = batteryDump.match(/level:\s+(\d+)/);
    const batteryTempMatch = batteryDump.match(/temperature:\s+(\d+)/);
    const batteryStatusMatch = batteryDump.match(/status:\s+(\d+)/);

    const batteryLevel = batteryLevelMatch ? parseInt(batteryLevelMatch[1]) : null;
    const batteryTemp = batteryTempMatch ? parseFloat(batteryTempMatch[1]) / 10 : null;

    const statusCodes = { 1: 'Unknown', 2: 'Charging', 3: 'Discharging', 4: 'Not Charging', 5: 'Full' };
    const batteryStatus = batteryStatusMatch ? statusCodes[batteryStatusMatch[1]] || 'Unknown' : 'Unknown';

    const sizeOutput = await runAdb(`-s ${deviceId} shell wm size`);
    const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+x\d+)/);
    const resolution = sizeMatch ? sizeMatch[1] : 'Unknown';

    return {
      connected: true,
      deviceId,
      brand: brand.toUpperCase(),
      model,
      androidVersion: release,
      batteryLevel,
      batteryTemp,
      batteryStatus,
      resolution
    };
  } catch (error) {
    return {
      connected: true,
      deviceId,
      error: error.message
    };
  }
}

export async function captureScreen(outputPath) {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected');
  }
  const deviceId = devices[0].id;

  log('Taking screenshot of mobile screen...', 'info');
  const tempPhonePath = '/sdcard/nexus_temp.png';

  await runAdb(`-s ${deviceId} shell screencap -p ${tempPhonePath}`);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await runAdb(`-s ${deviceId} pull ${tempPhonePath} "${outputPath}"`);
  await runAdb(`-s ${deviceId} shell rm ${tempPhonePath}`);
  log('Screenshot successfully transferred to PC dashboard.', 'success');
  return true;
}

export async function isScreenOn(deviceId) {
  try {
    const output = await runAdb(`-s ${deviceId} shell dumpsys power`);
    const isInteractive = output.includes('mInteractive=true') || output.includes('Display Power: state=ON') || output.includes('mScreenOn=true');
    return isInteractive;
  } catch (e) {
    return false;
  }
}

export async function isPhoneLocked(deviceId) {
  try {
    const output = await runAdb(`-s ${deviceId} shell dumpsys window`);
    const isShowing = output.includes('mDreamingLockscreen=true') ||
                      output.includes('mShowingLockscreen=true') ||
                      output.includes('isStatusBarKeyguard=true') ||
                      output.includes('showing=true');

    try {
      const kgOutput = await runAdb(`-s ${deviceId} shell dumpsys trust`);
      const deviceLocked = kgOutput.includes('deviceLocked=true');
      return isShowing || deviceLocked;
    } catch (e) {
      return isShowing;
    }
  } catch (e) {
    return true;
  }
}

export async function unlockPhone(pin) {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected');
  }
  const deviceId = devices[0].id;

  log('Executing Phone Unlock pipeline...', 'info');

  const screenActive = await isScreenOn(deviceId);
  if (!screenActive) {
    log('Screen is currently OFF. Sending WAKEUP key...', 'info');
    await runAdb(`-s ${deviceId} shell input keyevent KEYCODE_WAKEUP`);
    await new Promise(resolve => setTimeout(resolve, 800));
  } else {
    log('Screen is already ON.', 'info');
  }

  const locked = await isPhoneLocked(deviceId);
  if (!locked) {
    log('Phone is already UNLOCKED! No action needed. Skipping unlock sequence.', 'success');
    return { alreadyUnlocked: true };
  }
  log('Keyguard lockscreen is ACTIVE. Proceeding with unlock...', 'info');

  log('Dismissing keyguard lockscreen (swipe up)...', 'info');
  const sizeOutput = await runAdb(`-s ${deviceId} shell wm size`);
  const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);
  let startX = 500, startY = 1600, endX = 500, endY = 400;

  if (sizeMatch) {
    const width = parseInt(sizeMatch[1]);
    const height = parseInt(sizeMatch[2]);
    startX = Math.floor(width / 2);
    startY = Math.floor(height * 0.8);
    endX = Math.floor(width / 2);
    endY = Math.floor(height * 0.2);
  }

  await runAdb(`-s ${deviceId} shell input swipe ${startX} ${startY} ${endX} ${endY} 250`);
  await new Promise(resolve => setTimeout(resolve, 700));

  if (pin) {
    if (!/^[0-9]{3,16}$/.test(String(pin))) {
      throw new Error('Configured unlock PIN must be 3-16 digits.');
    }
    log('Typing security PIN...', 'info');
    await runAdbArgs(['-s', assertDeviceId(deviceId), 'shell', 'input', 'text', String(pin)]);
    await new Promise(resolve => setTimeout(resolve, 300));
    log('Submitting PIN...', 'info');
    await runAdbArgs(['-s', assertDeviceId(deviceId), 'shell', 'input', 'keyevent', '66']);
  } else {
    log('Unlock swipe completed (No PIN configured).', 'success');
  }

  log('Phone unlock process completed.', 'success');
  return { alreadyUnlocked: false };
}

export async function makeCall(phoneNumber) {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected');
  }
  const deviceId = devices[0].id;

  log(`Initiating call pipeline to: ${phoneNumber}`, 'info');

  const cleanNumber = phoneNumber.replace(/[^0-9+]/g, '');

  try {
    log(`Sending DIRECT_CALL intent...`, 'info');
    await runAdb(`-s ${deviceId} shell am start -a android.intent.action.CALL -d tel:${cleanNumber}`);
    log(`Direct call intent triggered successfully. Check phone screen.`, 'success');
  } catch (error) {
    log(`Direct call intent failed or blocked. Retrying with DIAL intent...`, 'warning');
    await runAdb(`-s ${deviceId} shell am start -a android.intent.action.DIAL -d tel:${cleanNumber}`);

    await new Promise(resolve => setTimeout(resolve, 1000));
    log(`Sending KEYCODE_CALL input event to dial number...`, 'info');
    await runAdb(`-s ${deviceId} shell input keyevent KEYCODE_CALL`);
    log(`Dialer command executed.`, 'success');
  }
  return true;
}

export async function sendWhatsAppMessage(phoneNumber, message, coords) {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected');
  }
  const deviceId = devices[0].id;

  log(`Executing WhatsApp messaging pipeline for ${phoneNumber}...`, 'info');

  let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
  if (formattedNumber.length === 10) {
    formattedNumber = '91' + formattedNumber;
    log(`No country code specified. Defaulted to India (+91): ${formattedNumber}`, 'warning');
  }

  const screenActive = await isScreenOn(deviceId);
  if (!screenActive) {
    log('Screen is OFF. Waking up device...', 'info');
    await runAdb(`-s ${deviceId} shell input keyevent KEYCODE_WAKEUP`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  log('Launching WhatsApp conversation window...', 'info');
  const encodedText = encodeURIComponent(message);
  const whatsappUrl = `whatsapp://send?phone=${formattedNumber}&text=${encodedText}`;

  await runAdb(`-s ${deviceId} shell am start -a android.intent.action.VIEW -d "${whatsappUrl}"`);

  log('Waiting for WhatsApp layout to render (3 seconds)...', 'info');
  await new Promise(resolve => setTimeout(resolve, 3000));

  const sizeOutput = await runAdb(`-s ${deviceId} shell wm size`);
  const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);

  let sendX = 990;
  let sendY = 1250;

  if (sizeMatch) {
    const width = parseInt(sizeMatch[1]);
    const height = parseInt(sizeMatch[2]);

    if (coords && coords.x && coords.y) {
      sendX = coords.x <= 1 ? Math.floor(width * coords.x) : coords.x;
      sendY = coords.y <= 1 ? Math.floor(height * coords.y) : coords.y;
      log(`Using user-calibrated click coordinates: X=${sendX}, Y=${sendY}`, 'info');
    } else {
      sendX = Math.floor(width * 0.91);
      sendY = Math.floor(height * 0.55);
      log(`Guessed send button coordinates: X=${sendX}, Y=${sendY} (based on ${width}x${height} screen)`, 'info');
    }
  }

  log(`Simulating click on Send button at (${sendX}, ${sendY})...`, 'info');
  await runAdb(`-s ${deviceId} shell input tap ${sendX} ${sendY}`);

  await new Promise(resolve => setTimeout(resolve, 500));
  await runAdb(`-s ${deviceId} shell input tap ${sendX} ${sendY}`);

  await new Promise(resolve => setTimeout(resolve, 400));
  log('Sending KEYCODE_ENTER as intelligent fallback to ensure delivery...', 'info');
  await runAdb(`-s ${deviceId} shell input keyevent 66`);

  log('WhatsApp message command pipeline executed with multi-fallback.', 'success');
  return true;
}

export async function syncPhoneContacts() {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected');
  }
  const deviceId = devices[0].id;

  log('Starting phone contacts sync via ADB content provider...', 'info');

  try {
    const output = await runAdb(
      `-s ${deviceId} shell content query --uri content://com.android.contacts/data/phones --projection display_name:data1`
    );

    if (!output || output.includes('No result found')) {
      log('No contacts found on the device.', 'warning');
      return [];
    }

    const lines = output.split('\n').filter(line => line.trim().startsWith('Row:'));
    const contacts = [];
    const seen = new Set();

    for (const line of lines) {
      const nameMatch = line.match(/display_name=([^,]+)/);
      const numberMatch = line.match(/data1=([^,\s]+)/);

      if (nameMatch && numberMatch) {
        const name = nameMatch[1].trim();
        let number = numberMatch[1].trim().replace(/[^0-9+]/g, '');

        if (!name || !number || name === 'NULL' || number === 'NULL') continue;

        if (number.startsWith('+')) {
          number = number.substring(1);
        }
        if (number.startsWith('91') && number.length === 12) {
          number = number.substring(2);
        }

        const key = `${name.toLowerCase()}_${number}`;
        if (!seen.has(key)) {
          seen.add(key);
          contacts.push({
            id: `phone_${Date.now()}_${contacts.length}`,
            name,
            number
          });
        }
      }
    }

    log(`Successfully synced ${contacts.length} contacts from device.`, 'success');
    return contacts;
  } catch (error) {
    log(`Contact sync failed: ${error.message}`, 'error');
    throw error;
  }
}

/** Loopback and link-local are never the address the PC should dial. */
function isUsableLanIp(ip) {
  return Boolean(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.');
}

/**
 * The phone's Wi-Fi address.
 *
 * Reads the interface directly rather than parsing `ip route`, which is what
 * this used to do. Android files routes under per-network tables, so on some
 * devices — a Vivo V2437 on Android 16, for one — the main table `ip route`
 * prints is simply empty, and the old `src` regex found nothing *even with
 * Wi-Fi connected and working*. Asking `ip route show table all` instead is no
 * fix either: the first `src` in that output is 127.0.0.1.
 */
/** This PC's own LAN addresses, used to work out which phone address it can reach. */
function localIPv4Addresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isUsableLanIp(entry.address)) {
        out.push(entry.address);
      }
    }
  }
  return out;
}

const subnet24 = (ip) => ip.split('.').slice(0, 3).join('.');

export async function getWifiIp(deviceId) {
  const id = assertDeviceId(deviceId);
  const candidates = [];

  // `ap0` matters as much as `wlan0`: when the phone is running a hotspot and
  // this PC has joined it, the phone's *client* address (wlan0, on the router's
  // network) is the one address the PC cannot reach — and on a phone doing
  // STA+AP at once, both interfaces are up simultaneously.
  for (const iface of ['wlan0', 'wlan1', 'ap0', 'softap0', 'swlan0']) {
    try {
      const out = await runAdbArgs(['-s', id, 'shell', 'ip', '-f', 'inet', 'addr', 'show', iface], { timeout: 8000 });
      const ip = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
      if (isUsableLanIp(ip)) candidates.push(ip);
    } catch {
      // Interface absent on this device — try the next name.
    }
  }

  // Devices that name their interfaces something else entirely.
  if (!candidates.length) {
    try {
      const routes = await runAdbArgs(['-s', id, 'shell', 'ip', 'route', 'show', 'table', 'all'], { timeout: 8000 });
      for (const m of routes.matchAll(/src\s+(\d+\.\d+\.\d+\.\d+)/g)) {
        if (isUsableLanIp(m[1])) candidates.push(m[1]);
      }
    } catch {  }
  }

  if (!candidates.length) {
    let wifiOn = '';
    try {
      wifiOn = (await runAdbArgs(['-s', id, 'shell', 'settings', 'get', 'global', 'wifi_on'], { timeout: 8000 })).trim();
    } catch {  }
    throw new Error(wifiOn === '0'
      ? 'Wi-Fi is switched off on the phone. Turn Wi-Fi on (same network as this PC), or start its hotspot and join this PC to it.'
      : 'Could not read a Wi-Fi address from the phone. Put it on the same network as this PC and try again.');
  }

  // Prefer an address this PC shares a subnet with — that is the one it stands
  // any chance of opening a socket to.
  const localSubnets = new Set(localIPv4Addresses().map(subnet24));
  return candidates.find((ip) => localSubnets.has(subnet24(ip))) || candidates[0];
}

/**
 * Runs `adb connect` and reports whether the device actually showed up.
 *
 * `adb connect` exits 0 even when it fails, so its exit code proves nothing.
 * Nor does its text: the Windows failure reads "...because THE CONNECTED PARTY
 * did not properly respond...", which sailed straight through the old
 * `includes('connected')` check and reported success for a dead link — the UI
 * then told people to unplug a cable that was the only thing working. The
 * device list is the only answer that cannot lie.
 */
async function connectAndVerify(address) {
  log(`Connecting to ${address} wirelessly...`, 'info');
  // An unreachable host makes adb sit on the OS TCP timeout, ~21s on Windows,
  // so allow for that. A throw here (timeout, non-zero exit) is not fatal on
  // its own — the device-list check below decides, and callers phrase the
  // failure far better than a raw "Command failed" ever could.
  let output = '';
  try {
    output = (await runAdbArgs(['connect', address], { timeout: 45000 })).trim();
  } catch (connectError) {
    output = String(connectError.stdout || connectError.message || '').trim();
  }
  log(`Wireless connection result: ${output}`, 'info');

  const connected = (await getDevices()).some(
    (d) => d.id === address && d.status === 'device'
  );
  return { connected, output };
}

export async function enableWirelessAdb() {
  const devices = await getDevices();
  if (devices.length === 0) {
    throw new Error('No device connected via USB. Connect USB first to enable wireless.');
  }
  const deviceId = devices[0].id;

  log('Enabling wireless ADB mode...', 'info');

  try {
    const phoneIp = await getWifiIp(deviceId);
    log(`Device Wi-Fi IP detected: ${phoneIp}`, 'info');

    log('Switching ADB transport to TCP/IP on port 5555...', 'info');
    await runAdb(`-s ${deviceId} tcpip 5555`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const address = `${phoneIp}:5555`;
    const { connected, output } = await connectAndVerify(address);

    if (!connected) {
      throw new Error(
        `Could not reach ${address}. adb said: ${output || '(nothing)'}. ` +
        'The phone is on Wi-Fi, but nothing on this PC can open a TCP connection to it — ' +
        'check for client/AP isolation on the router, or use Android 11+ ' +
        'Wireless debugging (Developer options) instead of port 5555.'
      );
    }

    log('Wireless ADB activated successfully! You can now remove the USB cable.', 'success');
    return { success: true, ip: phoneIp, port: 5555 };
  } catch (error) {
    log(`Wireless ADB setup failed: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Android 11+ pairing — the cable-free path.
 *
 * The phone's "Pair device with pairing code" dialog shows a one-shot address
 * and a 6-digit code; both are only valid while that dialog is open. Pairing
 * does not connect: it authorises this PC's key, after which the *other*
 * address on the Wireless debugging screen is the one to connect to.
 */
export async function pairWirelessDevice(address, code) {
  const target = assertHostPort(address);
  const pin = assertPairingCode(code);

  log(`Pairing with ${target}...`, 'info');
  let output = '';
  try {
    // `adb pair` holds the socket open until the phone answers, and the code is
    // passed as an argument so nothing waits on stdin.
    output = (await runAdbArgs(['pair', target, pin], { timeout: 60000 })).trim();
  } catch (pairError) {
    output = String(pairError.stdout || pairError.message || '').trim();
  }

  // Unlike `connect`, pairing leaves no device-list entry to verify against —
  // adb's own wording is the only signal available.
  if (!/successfully paired/i.test(output)) {
    throw new Error(
      `Pairing with ${target} failed. adb said: ${output || '(nothing)'}. ` +
      'The pairing dialog must still be open on the phone (its address and code ' +
      'change every time it is reopened), and both devices must be on the same network.'
    );
  }

  log(`Paired with ${target}. Now connect using the address shown on the Wireless debugging screen.`, 'success');
  return { success: true, address: target, output };
}

/** Connects to an already-paired phone at the address from its Wireless debugging screen. */
export async function connectWirelessDevice(address) {
  const target = assertHostPort(address);
  const { connected, output } = await connectAndVerify(target);

  if (!connected) {
    throw new Error(
      `Could not connect to ${target}. adb said: ${output || '(nothing)'}. ` +
      'Check that the phone is paired with this PC, that Wireless debugging is still on ' +
      '(the port changes each time it is toggled), and that both are on the same network ' +
      'with no client/AP isolation.'
    );
  }

  log(`Connected wirelessly to ${target}.`, 'success');
  return { success: true, address: target };
}

export async function disableWirelessAdb() {
  log('Disabling wireless ADB mode, reverting to USB transport...', 'info');
  try {
    await runAdb('disconnect');
    log('All wireless connections disconnected. Reverting to USB.', 'success');
    return { success: true };
  } catch (error) {
    log(`Failed to disconnect wireless: ${error.message}`, 'warning');
    return { success: false, error: error.message };
  }
}


async function getFirstDevice() {
  const devices = await getDevices();
  if (devices.length === 0) throw new Error('No device connected');
  return devices[0].id;
}

export async function volumeUp() {
  const id = await getFirstDevice();
  log('Increasing volume...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_UP`);
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_UP`);
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_UP`);
  log('Volume increased.', 'success');
}

export async function volumeDown() {
  const id = await getFirstDevice();
  log('Decreasing volume...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_DOWN`);
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_DOWN`);
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_DOWN`);
  log('Volume decreased.', 'success');
}

export async function volumeMute() {
  const id = await getFirstDevice();
  log('Toggling mute...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_VOLUME_MUTE`);
  log('Volume mute toggled.', 'success');
}

export async function setBrightness(level) {
  const id = await getFirstDevice();
  const val = Math.max(0, Math.min(255, parseInt(level) || 128));
  log(`Setting screen brightness to ${val}/255...`, 'info');
  await runAdb(`-s ${id} shell settings put system screen_brightness_mode 0`);
  await runAdb(`-s ${id} shell settings put system screen_brightness ${val}`);
  log(`Brightness set to ${val}.`, 'success');
}

export async function toggleFlashlight(state) {
  const id = await getFirstDevice();
  const onOff = state ? 'true' : 'false';
  log(`Setting flashlight: ${state ? 'ON' : 'OFF'}...`, 'info');
  try {
    await runAdb(`-s ${id} shell cmd statusbar expand-settings`);
    await new Promise(r => setTimeout(r, 500));
    await runAdb(`-s ${id} shell "service call SurfaceFlinger 1015 i32 ${state ? 1 : 0}"`);
    log(`Flashlight ${state ? 'enabled' : 'disabled'}.`, 'success');
  } catch (e) {
    log(`Flashlight toggle via keyevent fallback...`, 'warning');
    await runAdb(`-s ${id} shell input keyevent KEYCODE_HOME`);
  }
}


const resolvedPackageCache = {};

async function resolveLauncherActivity(deviceId, packageName) {
  assertDeviceId(deviceId);
  assertPackageName(packageName);
  try {
    const { stdout, stderr } = await execFileAsync(adbPath,
      ['-s', deviceId, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
       '-c', 'android.intent.category.LAUNCHER', packageName]
    );
    const output = (stdout || '') + '\n' + (stderr || '');
    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('/') && !lines[i].includes('=')) {
        return lines[i];
      }
    }
  } catch (e) {
    const output = (e.stdout || '') + '\n' + (e.stderr || '');
    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('/') && !lines[i].includes('=')) {
        return lines[i];
      }
    }
  }
  return null;
}

async function isPackageInstalled(deviceId, packageName) {
  assertDeviceId(deviceId);
  assertPackageName(packageName);
  try {
    const { stdout } = await execFileAsync(adbPath,
      ['-s', deviceId, 'shell', 'pm', 'path', packageName]
    );
    return (stdout || '').includes('package:');
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).includes('package:');
  }
}

async function tryLaunchPackage(deviceId, packageName) {
  assertDeviceId(deviceId);
  assertPackageName(packageName);
  const component = await resolveLauncherActivity(deviceId, packageName);
  const componentIsSafe = component && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+\/[A-Za-z0-9_.]+$/.test(component);
  if (component && !componentIsSafe) {
    log(`Resolved component "${component}" is not a plain identifier; skipping am start.`, 'warning');
  }

  if (componentIsSafe) {
    try {
      const { stdout, stderr } = await execFileAsync(adbPath,
        ['-s', deviceId, 'shell', 'am', 'start', '-n', component]
      );
      const output = (stdout || '') + '\n' + (stderr || '');
      if (output.includes('Error:') || output.includes('does not exist') || output.includes('ClassNotFoundException')) {
        log(`am start failed for ${component}: ${output.trim().substring(0, 100)}`, 'warning');
        return false;
      }
      log(`Cleanly launched: ${component}`, 'success');
      return true;
    } catch (e) {
      const output = (e.stdout || '') + '\n' + (e.stderr || '');
      if (output.includes('Starting:') || output.includes('Warning: Activity')) {
        log(`Launched (with warning): ${component}`, 'success');
        return true;
      }
      if (output.includes('Error:') || output.includes('does not exist')) {
        return false;
      }
      log(`Launched: ${component} (stderr present but no error)`, 'success');
      return true;
    }
  }

  const installed = await isPackageInstalled(deviceId, packageName);
  if (!installed) {
    return false;
  }

  try {
    const { stdout, stderr } = await execFileAsync(adbPath,
      ['-s', deviceId, 'shell', 'am', 'start',
       '-a', 'android.intent.action.MAIN',
       '-c', 'android.intent.category.LAUNCHER',
       '-n', `${packageName}/.MainActivity`]
    );
    const output = (stdout || '') + '\n' + (stderr || '');
    if (output.includes('Error:') || output.includes('does not exist')) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function findPackageOnDevice(deviceId, appName) {
  if (resolvedPackageCache[appName]) {
    log(`Package cache hit: ${appName} -> ${resolvedPackageCache[appName]}`, 'info');
    return resolvedPackageCache[appName];
  }

  log(`Scanning device for package matching "${appName}"...`, 'info');

  assertDeviceId(deviceId);
  let listOutput;
  try {
    const { stdout } = await execFileAsync(adbPath, ['-s', deviceId, 'shell', 'pm', 'list', 'packages']);
    listOutput = stdout;
  } catch (e) {
    listOutput = e.stdout || '';
  }

  const allPackages = listOutput
    .split('\n')
    .map(l => l.trim().replace('package:', ''))
    .filter(l => l.length > 0);

  const searchName = appName.toLowerCase().replace(/\s+/g, '');

  let bestMatch = null;
  let bestScore = 0;

  for (const pkg of allPackages) {
    const pkgLower = pkg.toLowerCase();
    let score = 0;

    if (pkgLower.includes(searchName)) {
      score += 100;
    }

    const words = appName.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 2 && pkgLower.includes(word)) {
        score += 30;
      }
    }

    if (pkgLower.includes('provider') || pkgLower.includes('overlay') ||
        pkgLower.includes('service') || pkgLower.includes('framework') ||
        pkgLower.includes('widget') || pkgLower.includes('plugin') ||
        pkgLower.includes('config') || pkgLower.includes('extension')) {
      score -= 50;
    }

    if (score > 0) {
      score += Math.max(0, 30 - pkg.length);
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = pkg;
    }
  }

  if (bestMatch && bestScore > 0) {
    resolvedPackageCache[appName] = bestMatch;
    log(`Dynamic package match: "${appName}" -> ${bestMatch} (score: ${bestScore})`, 'success');
    return bestMatch;
  }

  return null;
}

export async function openApp(appName) {
  if (typeof appName !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(appName.trim())) {
    throw new Error('App name may only contain letters, digits, spaces, dot, underscore and dash.');
  }
  appName = appName.trim();
  const id = assertDeviceId(await getFirstDevice());

  const screenActive = await isScreenOn(id);
  if (!screenActive) {
    log('Screen is OFF. Waking device...', 'info');
    await runAdb(`-s ${id} shell input keyevent KEYCODE_WAKEUP`);
    await new Promise(resolve => setTimeout(resolve, 800));
    const sizeOutput = await runAdb(`-s ${id} shell wm size`);
    const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);
    if (sizeMatch) {
      const w = parseInt(sizeMatch[1]);
      const h = parseInt(sizeMatch[2]);
      await runAdb(`-s ${id} shell input swipe ${Math.floor(w/2)} ${Math.floor(h*0.8)} ${Math.floor(w/2)} ${Math.floor(h*0.2)} 250`);
    } else {
      await runAdb(`-s ${id} shell input swipe 500 1600 500 400 250`);
    }
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  const appMap = {
    'camera': ['com.android.camera', 'com.vivo.alphacamera', 'com.sec.android.app.camera', 'com.huawei.camera', 'com.oppo.camera', 'com.oneplus.camera', 'com.miui.camera'],
    'gallery': ['com.google.android.apps.photos', 'com.vivo.gallery', 'com.miui.gallery', 'com.sec.android.gallery3d', 'com.coloros.gallery3d'],
    'photos': ['com.google.android.apps.photos'],
    'settings': ['com.android.settings'],
    'chrome': ['com.android.chrome'],
    'youtube': ['com.google.android.youtube'],
    'maps': ['com.google.android.apps.maps'],
    'gmail': ['com.google.android.gm'],
    'calculator': ['com.google.android.calculator', 'com.vivo.calculator', 'com.miui.calculator', 'com.sec.android.app.popupcalculator', 'com.coloros.calculator', 'com.oneplus.calculator'],
    'clock': ['com.google.android.deskclock', 'com.android.deskclock', 'com.sec.android.app.clockpackage'],
    'calendar': ['com.google.android.calendar', 'com.android.calendar'],
    'whatsapp': ['com.whatsapp'],
    'instagram': ['com.instagram.android'],
    'facebook': ['com.facebook.katana'],
    'twitter': ['com.twitter.android', 'com.twitter.android.lite'],
    'x': ['com.twitter.android'],
    'spotify': ['com.spotify.music'],
    'telegram': ['org.telegram.messenger'],
    'netflix': ['com.netflix.mediaclient'],
    'phone': ['com.android.dialer', 'com.android.phone', 'com.samsung.android.dialer', 'com.vivo.dailer'],
    'dialer': ['com.android.dialer', 'com.android.phone'],
    'contacts': ['com.android.contacts', 'com.google.android.contacts'],
    'messages': ['com.google.android.apps.messaging', 'com.android.mms', 'com.samsung.android.messaging'],
    'files': ['com.google.android.apps.nbu.files', 'com.android.filemanager', 'com.android.documentsui', 'com.mi.android.globalFileexplorer'],
    'file manager': ['com.android.filemanager', 'com.google.android.apps.nbu.files', 'com.mi.android.globalFileexplorer'],
    'play store': ['com.android.vending'],
    'playstore': ['com.android.vending'],
    'music': ['com.google.android.music', 'com.android.bbkmusic', 'com.miui.player'],
    'snapchat': ['com.snapchat.android'],
    'amazon': ['in.amazon.mShop.android.shopping', 'com.amazon.mShop.android.shopping'],
    'flipkart': ['com.flipkart.android'],
    'paytm': ['net.one97.paytm'],
    'phonepe': ['com.phonepe.app'],
    'gpay': ['com.google.android.apps.nbu.paisa.user'],
    'google pay': ['com.google.android.apps.nbu.paisa.user'],
    'zomato': ['com.application.zomato'],
    'swiggy': ['in.swiggy.android'],
    'uber': ['com.ubercab'],
    'ola': ['com.olacabs.customer'],
    'hotstar': ['in.startv.hotstar', 'com.jio.media.stb.ondemand'],
    'jio': ['com.jio.media.jiobeats'],
    'notes': ['com.google.android.keep', 'com.android.notes'],
  };

  const nameLower = appName.toLowerCase().trim();
  const candidatePackages = appMap[nameLower] || [];

  log(`Opening app: "${appName}" | Candidates: ${candidatePackages.length > 0 ? candidatePackages.join(', ') : 'none (will use dynamic search)'}`, 'info');

  for (const pkg of candidatePackages) {
    log(`Trying static package: ${pkg}...`, 'info');
    const launched = await tryLaunchPackage(id, pkg);
    if (launched) {
      log(`App "${appName}" launched successfully via ${pkg}.`, 'success');
      resolvedPackageCache[nameLower] = pkg;
      return;
    }
  }

  if (candidatePackages.length > 0) {
    log(`All static packages failed for "${appName}". Falling back to dynamic search...`, 'warning');
  }

  const dynamicPkg = await findPackageOnDevice(id, appName);

  if (dynamicPkg) {
    log(`Trying dynamically resolved package: ${dynamicPkg}...`, 'info');
    const launched = await tryLaunchPackage(id, dynamicPkg);
    if (launched) {
      log(`App "${appName}" launched successfully via dynamic resolution: ${dynamicPkg}`, 'success');
      return;
    }
  }

  if (nameLower.includes('.')) {
    log(`Trying "${nameLower}" as direct package name...`, 'info');
    try {
      const launched = await tryLaunchPackage(id, nameLower);
      if (launched) {
        log(`App "${appName}" launched using direct package name.`, 'success');
        return;
      }
    } catch (e) {
      log(`"${nameLower}" is not a valid package name: ${e.message}`, 'warning');
    }
  }

  throw new Error(`App "${appName}" could not be found or launched on this device. Package not installed.`);
}

export async function openUrl(url) {
  const id = assertDeviceId(await getFirstDevice());
  let raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs may be opened (got ${parsed.protocol}).`);
  }

  const fullUrl = parsed.toString();
  log(`Opening URL: ${fullUrl}...`, 'info');
  await runAdbArgs(['-s', id, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', fullUrl]);
  log(`URL opened in browser.`, 'success');
}

export async function toggleWifi(enable) {
  const id = await getFirstDevice();
  const state = enable ? 'enable' : 'disable';
  log(`Turning WiFi ${state}...`, 'info');
  await runAdb(`-s ${id} shell svc wifi ${state}`);
  log(`WiFi ${state}d.`, 'success');
}

export async function toggleBluetooth(enable) {
  const id = await getFirstDevice();
  const state = enable ? 'enable' : 'disable';
  log(`Turning Bluetooth ${state}...`, 'info');
  try {
    await runAdb(`-s ${id} shell am start -a android.bluetooth.adapter.action.REQUEST_${enable ? 'ENABLE' : 'DISABLE'}`);
    log(`Bluetooth ${state} request sent.`, 'success');
  } catch (e) {
    await runAdb(`-s ${id} shell svc bluetooth ${state}`);
    log(`Bluetooth ${state}d.`, 'success');
  }
}

export async function takePhoto() {
  const id = await getFirstDevice();
  log('Opening camera and capturing photo...', 'info');
  await runAdb(`-s ${id} shell am start -a android.media.action.STILL_IMAGE_CAMERA`);
  await new Promise(r => setTimeout(r, 2500));
  await runAdb(`-s ${id} shell input keyevent KEYCODE_CAMERA`);
  await new Promise(r => setTimeout(r, 500));
  await runAdb(`-s ${id} shell input keyevent KEYCODE_FOCUS`);
  await runAdb(`-s ${id} shell input keyevent KEYCODE_CAMERA`);
  log('Photo captured!', 'success');
}

export async function mediaPlayPause() {
  const id = await getFirstDevice();
  log('Toggling media play/pause...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_MEDIA_PLAY_PAUSE`);
  log('Media play/pause toggled.', 'success');
}

export async function mediaNext() {
  const id = await getFirstDevice();
  log('Skipping to next track...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_MEDIA_NEXT`);
  log('Next track.', 'success');
}

export async function mediaPrevious() {
  const id = await getFirstDevice();
  log('Going to previous track...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_MEDIA_PREVIOUS`);
  log('Previous track.', 'success');
}

export async function pressHome() {
  const id = await getFirstDevice();
  log('Pressing HOME button...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_HOME`);
  log('Home screen activated.', 'success');
}

export async function pressBack() {
  const id = await getFirstDevice();
  log('Pressing BACK button...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_BACK`);
  log('Back pressed.', 'success');
}

export async function openRecents() {
  const id = await getFirstDevice();
  log('Opening recent apps...', 'info');
  await runAdb(`-s ${id} shell input keyevent KEYCODE_APP_SWITCH`);
  log('Recent apps opened.', 'success');
}

export async function openNotifications() {
  const id = await getFirstDevice();
  log('Pulling down notification shade...', 'info');
  await runAdb(`-s ${id} shell cmd statusbar expand-notifications`);
  log('Notification shade opened.', 'success');
}

const KEYEVENTS = Object.freeze({
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  recents: 'KEYCODE_APP_SWITCH',
  delete: 'KEYCODE_DEL',
  search: 'KEYCODE_SEARCH',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  power: 'KEYCODE_POWER',
  // Added for the mirror's key bar and PC keyboard passthrough. The agent's
  // `press_key` enum reads the same map, so these are available to it too;
  // the safety classifier scores everything but `power` as safe.
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  volume_mute: 'KEYCODE_VOLUME_MUTE',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT'
});

export function keyEventCodeFor(name) {
  return KEYEVENTS[String(name || '').toLowerCase()];
}

export function listKeyEventNames() {
  return Object.keys(KEYEVENTS);
}

/** Press a named navigation key. Only names in KEYEVENTS are accepted. */
export async function pressKeyEvent(name, deviceId) {
  const code = keyEventCodeFor(name);
  if (!code) throw new Error(`Unsupported key: ${JSON.stringify(name)}`);
  const id = assertDeviceId(deviceId || await getFirstDevice());
  log(`Pressing ${code}...`, 'info');
  await runAdbArgs(['-s', id, 'shell', 'input', 'keyevent', code], { timeout: 8000 });
  return { success: true, key: code };
}

export async function typeText(text) {
  const id = assertDeviceId(await getFirstDevice());
  const value = String(text ?? '');
  if (value.length > 2000) {
    throw new Error('Text is too long to type (max 2000 characters).');
  }
  log(`Typing text: "${value}"...`, 'info');
  await runAdbArgs(['-s', id, 'shell', 'input', 'text', deviceShellQuote(value)]);
  log('Text typed on device.', 'success');
}



export async function openWhatsAppChat(phoneNumber) {
  const id = await getFirstDevice();
  let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
  if (formattedNumber.length === 10) formattedNumber = '91' + formattedNumber;

  log(`Opening WhatsApp Chat for ${formattedNumber}...`, 'info');
  const whatsappUrl = `whatsapp://send?phone=${formattedNumber}`;
  await runAdb(`-s ${id} shell am start -a android.intent.action.VIEW -d "${whatsappUrl}"`);
  log('WhatsApp Chat opened.', 'success');
}

export async function tapWhatsAppSend() {
  const id = await getFirstDevice();
  log('Tapping WhatsApp Send button...', 'info');
  await runAdb(`-s ${id} shell input keyevent 66`);
  await new Promise(r => setTimeout(r, 200));

  const sizeOutput = await runAdb(`-s ${id} shell wm size`);
  const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);
  if (sizeMatch) {
    const width = parseInt(sizeMatch[1]);
    const height = parseInt(sizeMatch[2]);
    const sendX = Math.floor(width * 0.91);
    const sendY = Math.floor(height * 0.55);
    await runAdb(`-s ${id} shell input tap ${sendX} ${sendY}`);
  }
  log('Message Sent trigger executed.', 'success');
}

export async function tapWhatsAppCall() {
  const id = await getFirstDevice();
  log('Initiating WhatsApp Audio Call using Pro-Max UI Automator...', 'info');

  try {
    await runAdb(`-s ${id} shell uiautomator dump /sdcard/window_dump.xml`);
    const xml = await runAdb(`-s ${id} shell cat /sdcard/window_dump.xml`);

    const callMatch = xml.match(/node[^>]+content-desc="Voice call"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i) ||
                      xml.match(/node[^>]+content-desc="Call"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);

    if (callMatch) {
      const x1 = parseInt(callMatch[1]);
      const y1 = parseInt(callMatch[2]);
      const x2 = parseInt(callMatch[3]);
      const y2 = parseInt(callMatch[4]);
      const callX = Math.floor((x1 + x2) / 2);
      const callY = Math.floor((y1 + y2) / 2);

      log(`Exact Call Button found at X:${callX} Y:${callY}`, 'success');
      await runAdb(`-s ${id} shell input tap ${callX} ${callY}`);

      await new Promise(r => setTimeout(r, 1500));
      await runAdb(`-s ${id} shell uiautomator dump /sdcard/window_dump_confirm.xml`);
      const confirmXml = await runAdb(`-s ${id} shell cat /sdcard/window_dump_confirm.xml`);

      const confirmMatch = confirmXml.match(/node[^>]+text="Call"[^>]+class="android.widget.Button"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
      if (confirmMatch) {
        const cx1 = parseInt(confirmMatch[1]);
        const cy1 = parseInt(confirmMatch[2]);
        const cx2 = parseInt(confirmMatch[3]);
        const cy2 = parseInt(confirmMatch[4]);
        const confirmX = Math.floor((cx1 + cx2) / 2);
        const confirmY = Math.floor((cy1 + cy2) / 2);
        log(`Confirmation popup detected! Tapping Call at X:${confirmX} Y:${confirmY}`, 'warning');
        await runAdb(`-s ${id} shell input tap ${confirmX} ${confirmY}`);
      }
      log('WhatsApp Audio Call sequence completed successfully.', 'success');
    } else {
      log('Could not find Voice call button in UI. Attempting fallback coordinates...', 'warning');
      const sizeOutput = await runAdb(`-s ${id} shell wm size`);
      const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);
      if (sizeMatch) {
        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);
        await runAdb(`-s ${id} shell input tap ${Math.floor(width * 0.83)} ${Math.floor(height * 0.07)}`);
      }
    }
  } catch (error) {
    log(`Failed to execute UI Automator call sequence: ${error.message}`, 'error');
  }
}

export async function tapWhatsAppVideoCall() {
  const id = await getFirstDevice();
  log('Initiating WhatsApp Video Call using Pro-Max UI Automator...', 'info');

  try {
    await runAdb(`-s ${id} shell uiautomator dump /sdcard/window_dump.xml`);
    const xml = await runAdb(`-s ${id} shell cat /sdcard/window_dump.xml`);

    const callMatch = xml.match(/node[^>]+content-desc="Video call"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);

    if (callMatch) {
      const x1 = parseInt(callMatch[1]);
      const y1 = parseInt(callMatch[2]);
      const x2 = parseInt(callMatch[3]);
      const y2 = parseInt(callMatch[4]);
      const callX = Math.floor((x1 + x2) / 2);
      const callY = Math.floor((y1 + y2) / 2);

      log(`Exact Video Call Button found at X:${callX} Y:${callY}`, 'success');
      await runAdb(`-s ${id} shell input tap ${callX} ${callY}`);

      await new Promise(r => setTimeout(r, 1500));
      await runAdb(`-s ${id} shell uiautomator dump /sdcard/window_dump_confirm.xml`);
      const confirmXml = await runAdb(`-s ${id} shell cat /sdcard/window_dump_confirm.xml`);
      const confirmMatch = confirmXml.match(/node[^>]+text="Call"[^>]+class="android.widget.Button"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);

      if (confirmMatch) {
        const cx1 = parseInt(confirmMatch[1]);
        const cy1 = parseInt(confirmMatch[2]);
        const cx2 = parseInt(confirmMatch[3]);
        const cy2 = parseInt(confirmMatch[4]);
        const confirmX = Math.floor((cx1 + cx2) / 2);
        const confirmY = Math.floor((cy1 + cy2) / 2);
        await runAdb(`-s ${id} shell input tap ${confirmX} ${confirmY}`);
      }
      log('WhatsApp Video Call sequence completed successfully.', 'success');
    } else {
      log('Could not find Video call button in UI.', 'warning');
    }
  } catch (error) {
    log(`Failed to execute UI Automator video call sequence: ${error.message}`, 'error');
  }
}

export async function searchAndOpenWhatsAppContact(contactName) {
  const id = assertDeviceId(await getFirstDevice());
  const name = String(contactName ?? '').slice(0, 80);
  log(`Performing live UI search in WhatsApp for: "${name}"...`, 'info');

  try {
    await runAdb(`-s ${id} shell am start -n com.whatsapp/.Main`);
    await new Promise(r => setTimeout(r, 2000));

    await runAdb(`-s ${id} shell uiautomator dump /sdcard/window_dump.xml`);
    const xml = await runAdb(`-s ${id} shell cat /sdcard/window_dump.xml`);

    let searchMatch = xml.match(/node[^>]+resource-id="com.whatsapp:id\/search_bar_inner_layout"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i) ||
                      xml.match(/node[^>]+content-desc="Search"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i) ||
                      xml.match(/node[^>]+resource-id="com.whatsapp:id\/menuitem_search"[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);

    if (!searchMatch) {
      log('Search icon not found on WhatsApp main screen.', 'error');
      return false;
    }

    const sx = Math.floor((parseInt(searchMatch[1]) + parseInt(searchMatch[3])) / 2);
    const sy = Math.floor((parseInt(searchMatch[2]) + parseInt(searchMatch[4])) / 2);
    await runAdb(`-s ${id} shell input tap ${sx} ${sy}`);
    await new Promise(r => setTimeout(r, 1000));

    await runAdbArgs(['-s', id, 'shell', 'input', 'text', deviceShellQuote(name)]);
    await new Promise(r => setTimeout(r, 2000));

    const sizeOutput = await runAdb(`-s ${id} shell wm size`);
    const sizeMatch = sizeOutput.match(/Physical size:\s+(\d+)x(\d+)/);
    if (sizeMatch) {
      const width = parseInt(sizeMatch[1]);
      const height = parseInt(sizeMatch[2]);

      const firstResultX = Math.floor(width / 2);
      const firstResultY = Math.floor(height * 0.20);

      log(`Tapping first search result roughly at X:${firstResultX} Y:${firstResultY}`, 'info');
      await runAdb(`-s ${id} shell input tap ${firstResultX} ${firstResultY}`);

      await new Promise(r => setTimeout(r, 2500));
      return true;
    }
  } catch (error) {
    log(`Live UI Search failed: ${error.message}`, 'error');
    return false;
  }
}
