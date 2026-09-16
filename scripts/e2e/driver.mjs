// Drives the packaged desktop app over the Chrome DevTools Protocol.
//
// Every run gets its own profile and its own save folder, so a test never
// touches the user's settings, recent images or Downloads folder, and the
// single-instance lock never hands a test file to a copy the user has open.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGE_HELPERS } from './page.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultExecutable(repo, version) {
  const base = path.join(repo, 'release', version);
  if (process.platform === 'win32') return path.join(base, 'win-unpacked', 'DitherLab.exe');
  if (process.platform === 'darwin') {
    for (const dir of ['mac-universal', 'mac-arm64', 'mac']) {
      const exe = path.join(base, dir, 'DitherLab.app', 'Contents', 'MacOS', 'DitherLab');
      if (existsSync(exe)) return exe;
    }
  }
  return path.join(base, 'linux-unpacked', 'ditherlab');
}

/**
 * Start the app. `settings` is merged into the desktop settings file written
 * before launch; `args` are extra command-line arguments (files to open).
 */
export async function launch({ exe, root, settings = {}, args = [], language = 'en' }) {
  if (!existsSync(exe)) throw new Error(`app not found: ${exe}`);
  const profile = path.join(root, 'profile');
  const saves = path.join(root, 'saves');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  mkdirSync(saves, { recursive: true });
  const desktopSettings = {
    askWhereToSave: false,
    saveFolder: saves,
    language,
    window: { width: 1480, height: 940, maximized: false },
    ...settings,
  };
  writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(desktopSettings));

  const port = 9600 + Math.floor(Math.random() * 300);
  const env = { ...process.env, DITHERLAB_USER_DATA: profile };
  const proc = spawn(exe, [`--remote-debugging-port=${port}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  const mainLog = [];
  proc.stdout.on('data', (d) => mainLog.push(String(d)));
  proc.stderr.on('data', (d) => mainLog.push(String(d)));
  let exited = false;
  proc.on('exit', () => (exited = true));

  let target;
  for (let i = 0; i < 240 && !target && !exited; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
    } catch {
      /* not listening yet */
    }
    if (!target) await sleep(250);
  }
  if (!target) {
    proc.kill();
    throw new Error(`the app did not start (exited: ${exited})\n${mainLog.join('')}`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const waiting = new Map();
  const problems = [];
  let crashed = false;
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      problems.push(`uncaught: ${d.exception?.description ?? d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (m.method === 'Inspector.targetCrashed') {
      crashed = true;
      problems.push('RENDERER CRASHED');
    }
  };
  ws.onclose = () => {
    crashed = true;
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (crashed) {
        reject(new Error('renderer is gone'));
        return;
      }
      const id = ++nextId;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** Evaluate an expression in the page; page-side exceptions become JS errors here. */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  };
  /** Call one of the helpers in page.mjs with JSON arguments. */
  const call = (name, ...a) =>
    ev(`window.__e2e.${name}(${a.map((x) => (x === undefined ? 'undefined' : JSON.stringify(x))).join(', ')})`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Inspector.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
  await ev(PAGE_HELPERS);

  const until = async (fn, ms, label) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      if (crashed) throw new Error(`renderer crashed while waiting for ${label}`);
      last = await fn();
      if (last === true) return;
      await sleep(200);
    }
    throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${label}${last !== undefined && last !== false ? ` (last: ${JSON.stringify(last)})` : ''}`);
  };

  const listSaved = () => readdirSync(saves).filter((n) => !n.endsWith('.crdownload') && !n.startsWith('.'));
  /** Run `action`, then wait for exactly the new files it saves. */
  const expectSave = async (action, ms = 120000, count = 1) => {
    const before = new Set(listSaved());
    await action();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (crashed) throw new Error('renderer crashed during save');
      const fresh = listSaved().filter((n) => !before.has(n));
      if (fresh.length >= count) {
        // Let the writer finish: size stable across two looks.
        let sizes = fresh.map((n) => statSync(path.join(saves, n)).size);
        for (;;) {
          await sleep(400);
          const again = fresh.map((n) => statSync(path.join(saves, n)).size);
          if (again.every((s, i) => s === sizes[i])) break;
          sizes = again;
        }
        return fresh.map((n) => path.join(saves, n));
      }
      const failed = await call('errorToasts');
      if (failed.length > 0) throw new Error(`save failed: ${failed.join(' | ')}`);
      await sleep(250);
    }
    throw new Error(`no file saved within ${Math.round(ms / 1000)} s`);
  };

  const key = async (keyName, code, text) => {
    const base = { key: keyName, code, windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const close = async () => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    proc.kill();
    for (let i = 0; i < 40 && !exited; i++) await sleep(100);
  };

  return {
    proc, port, profile, saves, mainLog, problems, send, ev, call, until, expectSave, listSaved, key, close, sleep,
    isCrashed: () => crashed,
    hasExited: () => exited,
  };
}
