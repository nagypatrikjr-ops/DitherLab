#!/usr/bin/env node
// End-to-end pass over the packaged desktop app: every screen, every control
// the app has, and every file it can save, each file checked for what it is.
//
//   node scripts/e2e/run.mjs [--exe PATH] [--out DIR] [--pass N] [--heavy] [--only main,dtf,screen,failure,heavy,welcome]
//
// --heavy adds the 40.6 cm × 600 DPI print (92 megapixels), which takes minutes.
// Exits with status 1 when any check fails; a JSON report is written next to the runs.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExecutable, launch } from './driver.mjs';
import {
  inspectJpeg, inspectPdf, inspectPng, inspectSvg, inspectTiff, inspectWebp, inspectZip, pngAlphaValues, readText,
} from './files.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const exe = path.resolve(arg('exe', defaultExecutable(repo, version)));
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'ditherlab-e2e')));
const pass = arg('pass', '1');
const only = arg('only', 'welcome,main,dtf,screen,failure' + (flag('heavy') ? ',heavy' : '')).split(',');
mkdirSync(out, { recursive: true });

const fixtures = {
  png: path.join(repo, 'public', 'sample.png'),
  poster: path.join(repo, 'public', 'poster-test.png'),
  jpg: path.join(repo, 'tests', 'fixtures', 'poster.jpg'),
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const results = [];
let current = null;

function log(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * One named check. It fails if `fn` throws, or if the app reported anything
 * while it ran: an uncaught exception, a console error, an error notification.
 */
async function check(group, name, fn) {
  const app = current;
  const t0 = Date.now();
  const problemsBefore = app ? app.problems.length : 0;
  let status = 'pass';
  let detail = '';
  try {
    const r = await fn();
    detail = r === undefined ? '' : typeof r === 'string' ? r : JSON.stringify(r);
  } catch (e) {
    status = 'fail';
    detail = e instanceof Error ? e.message : String(e);
  }
  if (app) {
    const fresh = app.problems.slice(problemsBefore);
    if (fresh.length > 0) {
      status = 'fail';
      detail += `${detail ? ' | ' : ''}app reported: ${fresh.join(' || ')}`;
    }
    if (!app.isCrashed()) {
      try {
        const toasts = await app.call('errorToasts');
        if (toasts.length > 0) {
          status = 'fail';
          detail += `${detail ? ' | ' : ''}error notification: ${toasts.join(' || ')}`;
          await app.call('dismissToasts');
        }
      } catch {
        /* the page is gone; the crash is reported by the next check */
      }
    }
  }
  const ms = Date.now() - t0;
  results.push({ group, name, status, ms, detail });
  log(`${status === 'pass' ? '  ok  ' : ' FAIL '} ${group} › ${name} (${(ms / 1000).toFixed(1)} s)${detail && status === 'fail' ? `\n        ${detail}` : ''}`);
  return status === 'pass';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mainIdle(app, ms = 90000) {
  await sleep(250);
  await app.until(() => app.call('mainIdle'), ms, 'the preview render');
}

async function dtfIdle(app, ms = 240000) {
  await sleep(600);
  await app.until(() => app.call('dtfIdle'), ms, 'the T-shirt studio to settle');
}

async function screenIdle(app, ms = 180000) {
  await sleep(600);
  await app.until(() => app.call('screenIdle'), ms, 'the films');
}

async function canvasHasImage(app, selector) {
  const st = await app.call('canvasStats', selector);
  if (st.error) throw new Error(st.error);
  if (st.colours < 2) throw new Error(`the canvas is blank (${JSON.stringify(st)})`);
  return st;
}

/**
 * Operate every select and slider in a scoped part of the UI, each to every
 * option / both ends of its range, waiting for the app after each change,
 * then put it back. `skip` names labels to leave alone.
 */
async function sweep(app, within, idle, skip = /^$/, group, prefix) {
  const selects = await app.call('selects', within);
  for (const s of selects) {
    if (skip.test(s.label)) continue;
    const label = `^${esc(s.label)}$`;
    let original;
    await check(group, `${prefix} › “${s.label}”: every option (${s.options.length})`, async () => {
      original = (await app.ev(`[...document.querySelector(${JSON.stringify(within)}).querySelectorAll('.field')].find(f => (f.querySelector(':scope > .label > span:first-child')?.textContent ?? '').replace(/\\s+/g,' ').trim() === ${JSON.stringify(s.label)})?.querySelector('select')?.value`)) ?? s.options[0];
      for (const o of s.options) {
        await app.call('choose', label, o, within);
        await idle(app);
      }
      await app.call('choose', label, original, within);
      await idle(app);
    });
  }
  const sliders = await app.call('sliders', within);
  for (const sl of sliders) {
    if (skip.test(sl.label)) continue;
    const label = `^${esc(sl.label)}$`;
    await check(group, `${prefix} › “${sl.label}”: ${sl.min} … ${sl.max}`, async () => {
      const before = (await app.call('sliderInfo', label, within)).value;
      for (const v of [sl.max, sl.min, before]) {
        const got = await app.call('setNumber', label, v, within);
        if (Math.abs(got - v) > Math.max(1e-6, Math.abs(sl.max - sl.min) * 0.02)) {
          throw new Error(`asked for ${v}, the slider reads ${got}`);
        }
        await idle(app);
      }
    });
  }
}

async function base64(file) {
  return readFileSync(file).toString('base64');
}

// ---------------------------------------------------------------------------

async function welcomeFlow() {
  const G = 'welcome';
  const app = await launch({ exe, root: path.join(out, `p${pass}-welcome`) });
  current = app;
  try {
    await check(G, 'starts without an image and shows the welcome screen', async () => {
      await app.until(() => app.call('bodyHas', 'Welcome to DitherLab'), 30000, 'the welcome screen');
      const v = await app.ev('window.ditherlabDesktop?.version');
      if (v !== version) throw new Error(`the app reports version ${v}, expected ${version}`);
      return `version ${v}, ${process.platform}/${process.arch}`;
    });
    await check(G, 'toolbar commands that need an image are disabled', async () => {
      for (const b of ['^Render$', '^Before$', '^Compare$', '^Fit$', '^1:1$']) {
        if (!(await app.call('isDisabled', b))) throw new Error(`${b} is enabled with no image`);
      }
    });
    await check(G, '“Try the sample image” opens it', async () => {
      await app.call('click', '^Try the sample image$');
      await app.until(async () => /Opened:/.test(await app.call('statusText')), 30000, 'the sample image');
      await mainIdle(app);
      return app.call('statusText');
    });
  } finally {
    await app.close();
  }
}

async function mainFlow() {
  const G = 'main';
  const app = await launch({ exe, root: path.join(out, `p${pass}-main`), args: [fixtures.png] });
  current = app;
  try {
    await check(G, 'opens the image given on the command line', async () => {
      await app.until(async () => (await app.call('statusText')).includes('sample.png'), 40000, 'sample.png to load');
      await mainIdle(app);
      return app.call('statusText');
    });

    for (const starter of ['1-bit Floyd–Steinberg', 'Chunky Bayer 8×', 'Game Boy', 'Newsprint halftone', 'Riso duotone', 'CRT glitch']) {
      await check(G, `quick start “${starter}”`, async () => {
        await app.call('click', `^${esc(starter)}$`);
        await mainIdle(app);
        const layers = await app.call('layerCount');
        if (layers === 0) throw new Error('no layers were added');
        await canvasHasImage(app, '.canvas-wrap canvas');
        return `${layers} layers`;
      });
    }

    // Every effect on its own, with every one of its settings driven to both ends.
    const processors = await app.call('addLayerOptions');
    await check(G, `the effect list is not empty`, async () => {
      if (processors.length < 10) throw new Error(`only ${processors.length} effects`);
      return `${processors.length} effects`;
    });
    for (const p of processors) {
      await check(G, `effect “${p.name}” renders`, async () => {
        await app.call('removeAllLayers');
        await mainIdle(app);
        await app.call('addLayer', p.value);
        await mainIdle(app);
        await app.call('selectLayer', 0);
        const stack = await app.call('layerNames');
        if (stack.length !== 1) throw new Error(`the stack should hold only this effect, it holds ${stack}`);
        const title = await app.ev(`[...document.querySelectorAll('.panel.right > .section')][1]?.querySelector('.section-toggle')?.textContent.trim()`);
        if (title !== stack[0]) throw new Error(`the settings shown are for “${title}”, not “${stack[0]}”`);
        await canvasHasImage(app, '.canvas-wrap canvas');
      });
      const within = await app.call('markLayerSection');
      if (within) await sweep(app, within, mainIdle, /^Blend mode$/, G, `effect “${p.name}”`);
    }

    await check(G, 'layer stack: blend modes, opacity, on/off, duplicate, reorder, remove', async () => {
      await app.call('removeAllLayers');
      await app.call('click', '^1-bit Floyd–Steinberg$');
      await mainIdle(app);
      await app.call('selectLayer', 0);
      const within = await app.call('markLayerSection');
      for (const mode of await app.call('options', '^Blend mode$', within)) {
        await app.call('choose', '^Blend mode$', mode, within);
        await mainIdle(app);
      }
      await app.call('choose', '^Blend mode$', 'normal', within).catch(() => undefined);
      await app.call('setNumber', '^Opacity$', 0.5, within);
      await mainIdle(app);
      const n = await app.call('layerCount');
      await app.call('layerRowButton', 0, '^Duplicate$');
      await mainIdle(app);
      if ((await app.call('layerCount')) !== n + 1) throw new Error('duplicate did not add a layer');
      await app.call('layerRowButton', 0, '^Turn off$');
      await mainIdle(app);
      await app.call('layerRowButton', 0, '^Turn on$');
      await mainIdle(app);
      const names = await app.call('layerNames');
      await app.call('layerKey', 1, 'ArrowUp');
      await mainIdle(app);
      const moved = await app.call('layerNames');
      if (moved[0] !== names[1]) throw new Error(`Alt+↑ did not move the layer: ${names} → ${moved}`);
      await app.call('layerRowButton', 0, '^Remove$');
      await mainIdle(app);
      if ((await app.call('layerCount')) !== n) throw new Error('remove did not remove the layer');
    });

    await check(G, 'undo and redo', async () => {
      const n = await app.call('layerCount');
      await app.call('layerRowButton', 0, '^Duplicate$');
      await mainIdle(app);
      await app.call('click', '^Undo');
      await mainIdle(app);
      if ((await app.call('layerCount')) !== n) throw new Error('undo did not take the layer back');
      await app.call('click', '^Redo');
      await mainIdle(app);
      if ((await app.call('layerCount')) !== n + 1) throw new Error('redo did not restore it');
      await app.call('click', '^Undo');
      await mainIdle(app);
    });

    await check(G, 'every built-in palette in every category', async () => {
      const within = await app.call('markSection', '^Color palette$', '.panel.left');
      let count = 0;
      for (const cat of await app.call('options', '^Category$', within)) {
        await app.call('choose', '^Category$', cat, within);
        await mainIdle(app);
        for (const pal of await app.call('options', '^Palette', within)) {
          await app.call('choose', '^Palette', pal, within);
          await mainIdle(app);
          count++;
        }
      }
      return `${count} palettes`;
    });

    await check(G, 'palette editing: add a colour, move it, remove it', async () => {
      const within = await app.call('markSection', '^Color palette$', '.panel.left');
      const rows = () => app.ev(`document.querySelectorAll(${JSON.stringify(within)} + ' .color-row').length`);
      const n = await rows();
      await app.call('click', '^\\+ Color$', within);
      await mainIdle(app);
      if ((await rows()) !== n + 1) throw new Error('+ Color did not add a row');
      await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .color-row')].at(-1).querySelector('button[aria-label="Move up"]').click()`);
      await mainIdle(app);
      await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .color-row')].at(-1).querySelector('button[aria-label="Remove"]').click()`);
      await mainIdle(app);
      if ((await rows()) !== n) throw new Error('remove did not delete the row');
    });

    for (const [title, skip] of [['^Palette from the image$', /^$/], ['^Color management$', /^$/], ['^Seed & noise$', /^$/]]) {
      const within = await app.call('markSection', title, '.panel.left');
      await sweep(app, within, mainIdle, skip, G, title.replace(/[\^$\\]/g, ''));
      for (const cb of await app.call('checkboxes', within)) {
        await check(G, `${title.replace(/[\^$\\]/g, '')} › “${cb}” on and off`, async () => {
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await mainIdle(app);
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await mainIdle(app);
        });
      }
    }
    await check(G, 'palette from the image: Extract', async () => {
      const within = await app.call('markSection', '^Palette from the image$', '.panel.left');
      await app.call('click', '^Extract$', within);
      await mainIdle(app);
    });
    await check(G, 'new random seed', async () => {
      const within = await app.call('markSection', '^Seed & noise$', '.panel.left');
      await app.call('click', '^New seed$', within);
      await mainIdle(app);
    });

    // Put a vector-capable stack back for the exports.
    await app.call('removeAllLayers');
    await app.call('click', '^1-bit Floyd–Steinberg$');
    await mainIdle(app);

    await check(G, 'preset: Save writes a DitherLab preset file', async () => {
      const within = await app.call('markSection', '^Presets$', '.panel.left');
      const [file] = await app.expectSave(() => app.call('click', '^Save$', within));
      const json = JSON.parse(readText(file));
      if (typeof json !== 'object' || json === null) throw new Error('not a JSON object');
      return path.basename(file);
    });

    await check(G, 'viewing: before, compare, zoom in/out, fit, 1:1', async () => {
      await app.call('pressPointer', '^Before$');
      await app.call('click', '^Compare$');
      await mainIdle(app);
      await app.call('click', '^Compare$');
      for (const b of ['^Zoom in', '^Zoom out', '^Fit$', '^1:1$']) {
        await app.call('click', b);
        await sleep(150);
      }
      await canvasHasImage(app, '.canvas-wrap canvas');
    });

    await check(G, 'keyboard: F, 0, C, 1 (mute layer 1), ? (help), Esc', async () => {
      for (const k of ['f', '0', 'c', 'c', '1', '1']) {
        await app.key(k, `Key${k.toUpperCase()}`, k);
        await sleep(200);
      }
      await mainIdle(app);
      await app.key('?', 'Slash', '?');
      await app.until(() => app.call('modalOpen'), 5000, 'the help window');
      await app.key('Escape', 'Escape');
      await app.until(async () => !(await app.call('modalOpen')), 5000, 'the help window to close');
    });

    const exportsAndChecks = [
      ['^PNG$', (f) => inspectPng(f), /-dither\.png$/],
      ['^PNG \\(indexed\\)$', (f) => inspectPng(f), /-indexed\.png$/],
      ['^WEBP$', (f) => inspectWebp(f), /-dither\.webp$/],
      ['^JPG$', (f) => inspectJpeg(f), /-dither\.jpg$/],
      ['^TIFF$', (f) => inspectTiff(f), /-dither\.tif$/],
    ];
    for (const [label, inspect, nameRe] of exportsAndChecks) {
      await check(G, `export ${label.replace(/[\^$\\]/g, '')}`, async () => {
        const [file] = await app.expectSave(() => app.call('click', label, '.panel.right'));
        if (!nameRe.test(path.basename(file))) throw new Error(`unexpected file name ${path.basename(file)}`);
        const info = inspect(file);
        if (info.width !== undefined && (info.width !== 900 || info.height !== 600)) {
          throw new Error(`exported at ${info.width}×${info.height}, the image is 900×600`);
        }
        return `${path.basename(file)} ${JSON.stringify(info)}`;
      });
    }
    await check(G, 'export quality slider, then a low-quality JPG', async () => {
      const within = await app.call('markSection', '^Export image$', '.panel.right');
      if ((await app.call('setNumber', 'quality', 10, within)) !== 10) throw new Error('quality did not change');
      const [file] = await app.expectSave(() => app.call('click', '^JPG$', within));
      inspectJpeg(file);
      await app.call('setNumber', 'quality', 92, within);
    });
    {
      const within = await app.call('markSection', '^Vector export$', '.panel.right');
      await sweep(app, within, async () => sleep(150), /^$/, G, 'Vector export');
      for (const [label, inspect] of [['^SVG$', inspectSvg], ['^PDF$', inspectPdf]]) {
        await check(G, `vector export ${label.replace(/[\^$\\]/g, '')}`, async () => {
          const [file] = await app.expectSave(() => app.call('click', label, within), 180000);
          return `${path.basename(file)} ${JSON.stringify(inspect(file))}`;
        });
      }
      for (const cb of await app.call('checkboxes', within)) {
        await check(G, `Vector export › “${cb}” then SVG`, async () => {
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          const [file] = await app.expectSave(() => app.call('click', '^SVG$', within), 180000);
          inspectSvg(file);
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
        });
      }
    }

    await check(G, 'drop a JPG onto the window', async () => {
      await app.call('dispatchFile', 'drop', await base64(fixtures.jpg), 'poster.jpg', 'image/jpeg');
      await app.until(async () => (await app.call('statusText')).includes('poster.jpg'), 30000, 'poster.jpg to load');
      await mainIdle(app);
    });
    await check(G, 'paste a PNG', async () => {
      await app.call('dispatchFile', 'paste', await base64(fixtures.png), 'sample.png', 'image/png');
      await app.until(async () => /Opened: (sample|clipboard|vágólap)/i.test(await app.call('statusText')), 30000, 'the pasted image');
      await mainIdle(app);
    });
    await check(G, 'a second launch with a file opens it in this window', async () => {
      const second = spawn(exe, [fixtures.poster], { stdio: 'ignore', env: { ...process.env, DITHERLAB_USER_DATA: app.profile } });
      await app.until(async () => (await app.call('statusText')).includes('poster-test.png'), 40000, 'poster-test.png from the second launch');
      await new Promise((r) => {
        second.on('exit', r);
        setTimeout(r, 10000);
      });
      await mainIdle(app);
    });

    await check(G, 'language: Magyar and back', async () => {
      await app.call('langSelect', 'hu');
      await app.until(() => app.call('bodyHas', 'Megnyitás'), 5000, 'Hungarian texts');
      await app.call('langSelect', 'en');
      await app.until(() => app.call('bodyHas', '\\bOpen\\b'), 5000, 'English texts');
    });

    await check(G, 'help: every page, glossary search', async () => {
      await app.call('click', '^Help$');
      await app.until(() => app.call('modalOpen'), 5000, 'help');
      const tabs = await app.call('helpTabs');
      for (let i = 0; i < tabs.length; i++) await app.call('clickHelpTab', i);
      const g = tabs.findIndex((x) => /glossary/i.test(x));
      await app.call('clickHelpTab', g);
      await app.call('typeInto', '.help-search', 'dither');
      await app.call('closeModal');
      return tabs.join(', ');
    });

    await check(G, 'settings: wheel mode, studio options, close', async () => {
      await app.call('click', '^Settings$');
      await app.until(() => app.call('modalOpen'), 5000, 'settings');
      await app.call('click', '^Moves the image$', '.modal');
      await app.call('click', '^Zooms$', '.modal');
      await app.call('checkbox', 'simple mode', undefined, '.modal');
      await app.call('checkbox', 'simple mode', undefined, '.modal');
      if (!(await app.call('bodyHas', 'Files are saved to'))) throw new Error('the save folder is not shown');
      await app.call('closeModal');
    });
  } finally {
    await app.close();
  }
}

async function dtfFlow() {
  const G = 'dtf';
  const app = await launch({ exe, root: path.join(out, `p${pass}-dtf`), args: [fixtures.poster] });
  current = app;
  try {
    await check(G, 'opens from the toolbar and settles', async () => {
      await app.until(async () => (await app.call('statusText')).includes('poster-test.png'), 40000, 'the image');
      await mainIdle(app);
      await app.call('click', '^T-shirt print \\(DTF\\)');
      await dtfIdle(app);
      await canvasHasImage(app, '.zp-canvas');
      return (await app.call('readout')).join(' · ');
    });
    await check(G, 'Advanced shows every section', async () => {
      await app.call('click', '^Advanced$', '.studio-bar');
      await dtfIdle(app);
      const titles = await app.call('sectionTitles', '.studio');
      for (const want of ['Black knockout', 'Halftone screen', 'RIP & white underbase', 'Ink colours', 'Check', 'Pressing', 'Save for printing']) {
        if (!titles.some((t) => t.toLowerCase().startsWith(want.toLowerCase()))) throw new Error(`missing section ${want}`);
      }
      return titles.join(' | ');
    });

    await check(G, 'every view draws', async () => {
      const tabs = await app.call('viewTabs');
      for (let i = 0; i < tabs.length; i++) {
        await app.call('clickTab', i);
        await sleep(1500);
        await canvasHasImage(app, '.zp-canvas');
      }
      return tabs.join(', ');
    });
    await check(G, 'background view: every swatch; zoom controls; overview map', async () => {
      const tabs = await app.call('viewTabs');
      await app.call('clickTab', tabs.findIndex((t) => /background/i.test(t)));
      await sleep(800);
      const n = await app.ev(`document.querySelectorAll('.bg-swatch').length`);
      for (let i = 0; i < n; i++) {
        await app.ev(`document.querySelectorAll('.bg-swatch')[${i}].click()`);
        await sleep(200);
      }
      for (const z of ['Zoom in', 'Zoom in', 'Zoom out', 'Fit', 'Actual']) await app.call('zoomControl', z);
      await sleep(2500);
      await app.call('minimapClick');
      await sleep(1500);
      await canvasHasImage(app, '.zp-canvas');
      await app.call('zoomControl', 'Fit');
    });

    const skip = /^(File resolution|Which image)$/;
    for (const title of ['^Shirt$', '^Placement & size$', '^Black knockout$', '^Improve image$', '^Edge fade$', '^Halftone screen$', '^RIP & white underbase$', '^Automatic settings']) {
      const within = await app.call('markSection', title, '.studio');
      const name = title.replace(/[\^$\\]/g, '');
      await sweep(app, within, dtfIdle, skip, G, name);
      for (const cb of await app.call('checkboxes', within)) {
        await check(G, `${name} › “${cb}” off and on`, async () => {
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await dtfIdle(app);
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await dtfIdle(app);
        });
      }
    }
    await check(G, 'knockout looks', async () => {
      const within = await app.call('markSection', '^Black knockout$', '.studio');
      const looks = await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .look-row .btn')].map(b => b.textContent.trim())`);
      for (const l of looks) {
        await app.call('click', `^${esc(l)}$`, within);
        await dtfIdle(app);
      }
      return looks.join(', ');
    });
    await check(G, 'file resolution 360 DPI and back', async () => {
      const within = await app.call('markSection', '^Placement & size$', '.studio');
      await app.call('choose', '^File resolution$', '360', within);
      await dtfIdle(app);
      const r = (await app.call('readout')).join(' ');
      if (!r.includes('360 DPI')) throw new Error(`readout did not follow: ${r}`);
      await app.call('choose', '^File resolution$', '300', within);
      await dtfIdle(app);
    });
    await check(G, 'custom shirt colour', async () => {
      const within = await app.call('markSection', '^Shirt$', '.studio');
      await app.call('pickColor', '^Color$', '#203040', 0, within);
      await dtfIdle(app);
      await app.call('choose', '^Color$', 'black', within);
      await dtfIdle(app);
    });
    await check(G, 'automatic settings: Tune again, candidates', async () => {
      const within = await app.call('markSection', '^Automatic settings', '.studio');
      await app.call('click', '^Tune again$', within);
      await dtfIdle(app);
      const candidates = await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .tune-box .seg .btn, ' + ${JSON.stringify(within)} + ' .tune-box button')].map(b => b.textContent.trim()).filter(Boolean)`);
      for (const c of candidates) {
        await app.call('click', `^${esc(c)}$`, within);
        await dtfIdle(app);
      }
      return candidates.join(', ');
    });

    await check(G, 'ink colours: read, pick, add, remove, every mode', async () => {
      const within = await app.call('markSection', '^Ink colours$', '.studio');
      await app.call('checkbox', 'colours I choose', true, within);
      await app.until(async () => (await app.call('spotSwatches')).length > 0, 30000, 'colours read from the print');
      const swatches = await app.call('spotSwatches');
      await app.call('clickSpotSwatch', 0);
      await app.call('clickSpotSwatch', Math.min(1, swatches.length - 1));
      await dtfIdle(app);
      await app.call('click', '^Add a colour$', within);
      await dtfIdle(app);
      const inks = await app.call('spotInks');
      await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .color-field')].at(-1).querySelector('button').click()`);
      await dtfIdle(app);
      for (const mode of await app.call('options', '^Every other colour$', within)) {
        await app.call('choose', '^Every other colour$', mode, within);
        await dtfIdle(app);
      }
      await app.call('pickColor', 'takes this colour', '#22cc55', 0, within);
      await dtfIdle(app);
      await app.call('setNumber', '^Reach$', 20, within);
      await dtfIdle(app);
      await app.call('choose', '^Every other colour$', 'remove', within);
      await dtfIdle(app);
      return `${swatches.length} colours read; inks ${inks.join(' ')}`;
    });

    await check(G, 'save: print-ready PNG is real print data', async () => {
      const within = await app.call('markSection', '^Save for printing$', '.studio');
      const readout = await app.call('readout');
      const [file] = await app.expectSave(() => app.call('click', '^Print-ready PNG', within), 300000);
      const info = inspectPng(file);
      const px = readout.find((r) => r.startsWith('File='))?.match(/(\d+) × (\d+)/);
      if (!px || info.width !== Number(px[1]) || info.height !== Number(px[2])) {
        throw new Error(`file is ${info.width}×${info.height}, the readout says ${px?.[0]}`);
      }
      if (info.dpi !== 300) throw new Error(`file says ${info.dpi} DPI`);
      const alpha = pngAlphaValues(file);
      if (!alpha || alpha.some((a) => a !== 0 && a !== 255)) throw new Error(`semi-transparent pixels in the print file: ${alpha}`);
      return `${path.basename(file)} ${info.width}×${info.height} @ ${info.dpi} DPI`;
    });
    await check(G, 'save: ink filter off again, TIFF', async () => {
      const spot = await app.call('markSection', '^Ink colours$', '.studio');
      await app.call('checkbox', 'colours I choose', false, spot);
      await dtfIdle(app);
      const within = await app.call('markSection', '^Save for printing$', '.studio');
      const [file] = await app.expectSave(() => app.call('click', '^TIFF', within), 300000);
      return JSON.stringify(inspectTiff(file));
    });
    await check(G, 'save: mockup, job sheet', async () => {
      const within = await app.call('markSection', '^Save for printing$', '.studio');
      const [mock] = await app.expectSave(() => app.call('click', '^Mockup PNG$', within));
      inspectPng(mock);
      const [sheet] = await app.expectSave(() => app.call('click', '^Job sheet$', within));
      const txt = readText(sheet);
      if (!/DTF JOB SHEET/.test(txt) || !/300 DPI/.test(txt)) throw new Error('the job sheet is missing its content');
    });
    await check(G, 'save: print-shop package', async () => {
      const within = await app.call('markSection', '^Save for printing$', '.studio');
      const [zip] = await app.expectSave(() => app.call('click', '^Print-shop package', within), 300000);
      const { names } = inspectZip(zip);
      if (!names.some((n) => n.endsWith('.png')) || !names.some((n) => n.endsWith('.txt'))) throw new Error(`package holds ${names}`);
      return names.join(', ');
    });
    await check(G, 'mirrored file and Reset to recommended', async () => {
      const rip = await app.call('markSection', '^RIP & white underbase$', '.studio');
      await app.call('checkbox', '^Mirrored file', true, rip);
      await dtfIdle(app);
      const save = await app.call('markSection', '^Save for printing$', '.studio');
      const [file] = await app.expectSave(() => app.call('click', '^Print-ready PNG', save), 300000);
      inspectPng(file);
      await app.call('click', '^Reset to recommended$', '.studio');
      await dtfIdle(app);
    });
    await check(G, 'Simple mode and Esc closes the studio', async () => {
      await app.call('click', '^Simple$', '.studio-bar');
      await dtfIdle(app);
      await app.key('Escape', 'Escape');
      await app.until(async () => !(await app.ev(`!!document.querySelector('.studio')`)), 5000, 'the studio to close');
    });
  } finally {
    await app.close();
  }
}

async function screenFlow() {
  const G = 'screen';
  const app = await launch({ exe, root: path.join(out, `p${pass}-screen`), args: [fixtures.poster] });
  current = app;
  try {
    await check(G, 'opens and makes films', async () => {
      await app.until(async () => (await app.call('statusText')).includes('poster-test.png'), 40000, 'the image');
      await mainIdle(app);
      await app.call('click', '^T-shirt print \\(DTF\\)');
      await dtfIdle(app);
      await app.call('click', '^Screen-print films$', '.studio-bar');
      await screenIdle(app);
      return (await app.call('viewTabs')).join(', ');
    });
    await check(G, 'every view draws', async () => {
      const tabs = await app.call('viewTabs');
      for (let i = 0; i < tabs.length; i++) {
        await app.call('clickTab', i);
        await sleep(1200);
        await canvasHasImage(app, '.zp-canvas');
      }
    });
    await check(G, 'inks: read from the image, add, toggle, recolour, underbase, remove', async () => {
      const within = await app.call('markSection', '^Inks', '.studio');
      await app.call('click', '^Read colors from the image$', within);
      await screenIdle(app);
      const n = await app.call('inkRows');
      await app.call('click', '^\\+ Ink$', within);
      await screenIdle(app);
      if ((await app.call('inkRows')) !== n + 1) throw new Error('+ Ink did not add an ink');
      await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .ink-row')].at(-1).querySelector('button.mini').click()`);
      await screenIdle(app);
      await app.ev(`(() => { const row = [...document.querySelectorAll(${JSON.stringify(within)} + ' .ink-row')].at(-1); const c = row.querySelector('input[type=color]'); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(c, '#3366cc'); c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); row.querySelector('input[type=checkbox]')?.click(); })()`);
      await screenIdle(app);
      await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .ink-row')].at(-1).querySelector('button[aria-label="Remove"]').click()`);
      await screenIdle(app);
      if ((await app.call('inkRows')) !== n) throw new Error('remove did not delete the ink');
    });
    for (const title of ['^Source$', '^White underbase$', '^Halftone screen$', '^Press tolerances$']) {
      const within = await app.call('markSection', title, '.studio');
      const name = title.replace(/[\^$\\]/g, '');
      await sweep(app, within, screenIdle, /^(Film resolution|Which image)$/, G, name);
      for (const cb of await app.call('checkboxes', within)) {
        await check(G, `${name} › “${cb}” off and on`, async () => {
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await screenIdle(app);
          await app.call('checkbox', `^${esc(cb)}$`, undefined, within);
          await screenIdle(app);
        });
      }
    }
    await check(G, 'save: every film, all films as ZIP, preview', async () => {
      const within = await app.call('markSection', '^Save films$', '.studio');
      const films = await app.ev(`[...document.querySelectorAll(${JSON.stringify(within)} + ' .add-grid .btn')].map(b => b.textContent.trim())`);
      for (const f of films) {
        const [file] = await app.expectSave(() => app.call('click', `^${esc(f)}$`, within), 300000);
        const info = inspectPng(file);
        if (info.dpi === null) throw new Error(`${path.basename(file)} has no resolution`);
      }
      const [zip] = await app.expectSave(() => app.call('click', '^All films \\(ZIP\\)$', within), 600000);
      const { names } = inspectZip(zip);
      if (names.filter((n) => n.endsWith('.png')).length !== films.length) throw new Error(`ZIP holds ${names}`);
      const [preview] = await app.expectSave(() => app.call('click', '^Print preview PNG$', within), 120000);
      inspectPng(preview);
      return `${films.length} films; ZIP: ${names.join(', ')}`;
    });
  } finally {
    await app.close();
  }
}

async function failureFlow() {
  const G = 'failure';
  // A save folder that is really a file: every save into it must fail, and the
  // user must be told — the bug was that nothing at all happened.
  const root = path.join(out, `p${pass}-failure`);
  const blocker = path.join(out, `p${pass}-not-a-folder.txt`);
  writeFileSync(blocker, 'this is a file, not a folder');
  const app = await launch({ exe, root, args: [fixtures.png], settings: { saveFolder: blocker } });
  current = app;
  try {
    await check(G, 'a save that cannot be written says so', async () => {
      await app.until(async () => (await app.call('statusText')).includes('sample.png'), 40000, 'the image');
      await app.call('click', '^1-bit Floyd–Steinberg$');
      await mainIdle(app);
      await app.call('click', '^PNG$', '.panel.right');
      const t0 = Date.now();
      let toasts = [];
      while (Date.now() - t0 < 30000 && toasts.length === 0) {
        toasts = await app.call('errorToasts');
        await sleep(250);
      }
      if (toasts.length === 0) throw new Error('no message: the failed save was silent');
      if (!/Could not save/.test(toasts.join(' '))) throw new Error(`unexpected message: ${toasts}`);
      await app.call('dismissToasts');
      return toasts[0];
    });
  } finally {
    await app.close();
  }
}

async function heavyFlow() {
  const G = 'heavy';
  const app = await launch({ exe, root: path.join(out, `p${pass}-heavy`), args: [fixtures.poster] });
  current = app;
  try {
    await check(G, '40.6 cm at 600 DPI (9591 × 9591 px) saves', async () => {
      await app.until(async () => (await app.call('statusText')).includes('poster-test.png'), 40000, 'the image');
      await mainIdle(app);
      await app.call('click', '^T-shirt print \\(DTF\\)');
      await dtfIdle(app);
      const place = await app.call('markSection', '^Placement & size$', '.studio');
      await app.call('setNumber', '^Print width$', 406, place);
      await app.call('choose', '^File resolution$', '600', place);
      await dtfIdle(app, 900000);
      const save = await app.call('markSection', '^Save for printing$', '.studio');
      const [file] = await app.expectSave(() => app.call('click', '^Print-ready PNG', save), 1800000);
      const info = inspectPng(file);
      if (info.width !== 9591 || info.dpi !== 600) throw new Error(`got ${JSON.stringify(info)}`);
      return `${path.basename(file)} ${(info.bytes / 1e6).toFixed(1)} MB`;
    });
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------

const flows = { welcome: welcomeFlow, main: mainFlow, dtf: dtfFlow, screen: screenFlow, failure: failureFlow, heavy: heavyFlow };
log(`DitherLab ${version} end-to-end, pass ${pass} — ${process.platform}/${process.arch}\n  app: ${exe}\n  runs: ${out}`);
const started = Date.now();
for (const name of only) {
  log(`\n[${name}]`);
  try {
    await flows[name]();
  } catch (e) {
    results.push({ group: name, name: 'flow aborted', status: 'fail', ms: 0, detail: e instanceof Error ? e.stack ?? e.message : String(e) });
    log(` FAIL  ${name} › flow aborted\n        ${e instanceof Error ? e.message : e}`);
  }
}
const failed = results.filter((r) => r.status === 'fail');
const report = {
  version, pass, platform: process.platform, arch: process.arch, exe,
  minutes: Number(((Date.now() - started) / 60000).toFixed(1)),
  total: results.length, failed: failed.length, results,
};
const reportFile = path.join(out, `report-pass${pass}-${process.platform}-${process.arch}.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2));
log(`\n${results.length - failed.length}/${results.length} checks passed in ${report.minutes} min — report: ${reportFile}`);
for (const f of failed) log(`  FAIL ${f.group} › ${f.name}: ${f.detail.split('\n')[0]}`);
process.exit(failed.length > 0 ? 1 : 0);
