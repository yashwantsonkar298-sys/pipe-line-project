/**
 * Benchmark tasks for Vani Autopilot.
 *
 * Each task is a natural-language instruction plus a *programmatic* checker that
 * reads device state over ADB — the agent never sees the checker, so it cannot
 * game it. `setup` puts the phone in a known state first.
 *
 * Every task here is non-destructive and reversible: no calls, no messages, no
 * purchases. `restore` puts things back afterwards.
 */

import { runAdbArgs } from '../server/adb.js';

const sh = async (deviceId, command) => {
  const prefix = deviceId ? ['-s', deviceId] : [];
  return (await runAdbArgs([...prefix, 'shell', command], { timeout: 10000 })).trim();
};

const setting = (ns, key) => (deviceId) => sh(deviceId, `settings get ${ns} ${key}`);

/** Whichever package is in the foreground right now. */
async function foreground(deviceId) {
  const out = await sh(deviceId, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"').catch(() => '');
  return /([A-Za-z][\w.]+)\/[\w.$]+/.exec(out)?.[1] || '';
}

export const TASKS = [
  {
    id: 'airplane-on',
    prompt: 'turn on airplane mode',
    setup: (d) => sh(d, 'cmd connectivity airplane-mode disable').catch(() => {}),
    check: async (d) => (await setting('global', 'airplane_mode_on')(d)) === '1',
    restore: (d) => sh(d, 'cmd connectivity airplane-mode disable').catch(() => {})
  },
  {
    id: 'airplane-off',
    prompt: 'airplane mode band kar do',
    setup: (d) => sh(d, 'cmd connectivity airplane-mode enable').catch(() => {}),
    check: async (d) => (await setting('global', 'airplane_mode_on')(d)) === '0',
    restore: (d) => sh(d, 'cmd connectivity airplane-mode disable').catch(() => {})
  },
  {
    id: 'bluetooth-on',
    prompt: 'switch bluetooth on',
    setup: (d) => sh(d, 'svc bluetooth disable').catch(() => {}),
    check: async (d) => (await setting('global', 'bluetooth_on')(d)) === '1',
    restore: (d) => sh(d, 'svc bluetooth disable').catch(() => {})
  },
  {
    id: 'brightness-max',
    prompt: 'set the screen brightness to maximum',
    setup: (d) => sh(d, 'settings put system screen_brightness 40').catch(() => {}),
    check: async (d) => Number(await setting('system', 'screen_brightness')(d)) >= 200
  },
  {
    id: 'screen-timeout',
    prompt: 'change the screen timeout to 30 seconds in settings',
    setup: (d) => sh(d, 'settings put system screen_off_timeout 120000').catch(() => {}),
    check: async (d) => (await setting('system', 'screen_off_timeout')(d)) === '30000',
    restore: (d) => sh(d, 'settings put system screen_off_timeout 60000').catch(() => {})
  },
  {
    id: 'open-youtube',
    prompt: 'open YouTube',
    setup: (d) => sh(d, 'input keyevent KEYCODE_HOME').catch(() => {}),
    check: async (d) => (await foreground(d)).includes('youtube')
  },
  {
    id: 'open-clock',
    prompt: 'ghadi wala app kholo',
    setup: (d) => sh(d, 'input keyevent KEYCODE_HOME').catch(() => {}),
    check: async (d) => /deskclock|clockpackage|\.clock/.test(await foreground(d))
  },
  {
    id: 'youtube-search',
    prompt: 'open YouTube and search for lofi beats',
    setup: (d) => sh(d, 'input keyevent KEYCODE_HOME').catch(() => {}),
    // The agent must reach YouTube *and* get a search field on screen.
    check: async (d) => {
      if (!(await foreground(d)).includes('youtube')) return false;
      const dump = await sh(d, 'uiautomator dump /sdcard/nx_bench.xml && cat /sdcard/nx_bench.xml').catch(() => '');
      return /lofi/i.test(dump);
    }
  }
];

export default TASKS;
