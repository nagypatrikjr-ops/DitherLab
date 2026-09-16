// Helpers installed in the page as window.__e2e. They find controls the way a
// person would — by their visible label — and operate them the way React
// expects, so the tests exercise the same code paths a click or a keystroke does.
//
// Anything that would open a native dialog (file pickers, folder choosers,
// "Show in folder") is refused here, so a test run can never pop a window on
// the desktop of whoever is running it.

export const PAGE_HELPERS = String.raw`
(() => {
  if (window.__e2e) return;
  const FORBIDDEN = /^(open image|kép megnyitása|open$|megnyitás$|import$|importálás$|load$|betölt$|change…|módosítás…|show in folder|megjelenítés a mappában|open folder|mappa megnyitása|share as link)/i;
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const rx = (source, flags) => new RegExp(source, flags || 'i');

  const all = (sel, root) => [...(root || document).querySelectorAll(sel)];

  function scope(within) {
    if (!within) return document;
    const el = document.querySelector(within);
    if (!el) throw new Error('scope not found: ' + within);
    return el;
  }

  function button(source, within) {
    const re = rx(source);
    return all('button', scope(within)).find((b) => re.test(text(b)) || re.test(b.getAttribute('aria-label') || '')) || null;
  }

  function click(source, within) {
    const b = button(source, within);
    if (!b) throw new Error('button not found: /' + source + '/');
    const label = text(b) || b.getAttribute('aria-label') || '';
    if (FORBIDDEN.test(label)) throw new Error('refusing to press a control that opens a native dialog: ' + label);
    if (b.disabled) throw new Error('button is disabled: ' + label);
    b.scrollIntoView({ block: 'nearest' });
    b.click();
    return label;
  }

  function isDisabled(source, within) {
    const b = button(source, within);
    if (!b) throw new Error('button not found: /' + source + '/');
    return b.disabled;
  }

  function exists(source, within) {
    return button(source, within) !== null;
  }

  function section(titleSource, within) {
    const re = rx(titleSource);
    const toggle = all('.section-toggle', scope(within)).find((t) => re.test(text(t)));
    if (!toggle) throw new Error('section not found: /' + titleSource + '/');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    return text(toggle);
  }

  function sectionTitles(within) {
    return all('.section-toggle', scope(within)).map(text);
  }

  function field(labelSource, within) {
    const re = rx(labelSource);
    const f = all('.field', scope(within)).find((x) => {
      const l = x.querySelector(':scope > .label');
      return l && re.test(text(l));
    });
    if (!f) throw new Error('field not found: /' + labelSource + '/');
    return f;
  }

  const setNative = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  };

  function selectEl(labelSource, within) {
    const f = field(labelSource, within);
    const s = f.querySelector('select');
    if (!s) throw new Error('no select in field: ' + labelSource);
    return s;
  }

  function options(labelSource, within) {
    return [...selectEl(labelSource, within).options].filter((o) => !o.disabled && o.value !== '').map((o) => o.value);
  }

  function choose(labelSource, value, within) {
    const s = selectEl(labelSource, within);
    if (![...s.options].some((o) => o.value === value)) throw new Error('no option ' + value + ' in ' + labelSource);
    setNative(s, value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((r) => setTimeout(() => r(s.value), 60));
  }

  function sliderInfo(labelSource, within) {
    const f = field(labelSource, within);
    const slider = f.querySelector('[role=slider]');
    const box = f.querySelector('input.num');
    if (!slider || !box) throw new Error('no slider in field: ' + labelSource);
    return { min: Number(slider.getAttribute('aria-valuemin')), max: Number(slider.getAttribute('aria-valuemax')), value: Number(slider.getAttribute('aria-valuenow')) };
  }

  /** Type a value into a slider's number box and commit it; resolves with what the slider then shows. */
  async function setNumber(labelSource, value, within) {
    const f = field(labelSource, within);
    const box = f.querySelector('input.num');
    if (!box) throw new Error('no number box in field: ' + labelSource);
    box.focus();
    setNative(box, String(value));
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.blur();
    // React applies the state on its next render, not inside blur().
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const now = Number(f.querySelector('[role=slider]').getAttribute('aria-valuenow'));
      if (Math.abs(now - value) < 1e-9) return now;
    }
    return Number(f.querySelector('[role=slider]').getAttribute('aria-valuenow'));
  }

  /** Tag the settings section of the selected layer (the one after the stack). */
  function markLayerSection() {
    const secs = all('.panel.right > .section');
    const sec = secs[1];
    if (!sec) return null;
    const tag = 'l' + Math.random().toString(36).slice(2, 8);
    all('[data-e2e]').forEach((x) => x.removeAttribute('data-e2e'));
    sec.setAttribute('data-e2e', tag);
    return '[data-e2e="' + tag + '"]';
  }

  /** Every slider in a container, by label, so a test can sweep them all. */
  function sliders(within) {
    return all('.field', scope(within))
      .filter((f) => f.querySelector(':scope [role=slider]'))
      .map((f) => {
        const s = f.querySelector('[role=slider]');
        return { label: text(f.querySelector('.label > span')), min: Number(s.getAttribute('aria-valuemin')), max: Number(s.getAttribute('aria-valuemax')) };
      });
  }

  function selects(within) {
    return all('.field', scope(within))
      .filter((f) => f.querySelector(':scope > select'))
      .map((f) => ({ label: text(f.querySelector('.label > span')), options: [...f.querySelector('select').options].filter((o) => !o.disabled && o.value !== '').map((o) => o.value) }));
  }

  function checkbox(labelSource, want, within) {
    const re = rx(labelSource);
    const label = all('label.checkbox', scope(within)).find((l) => re.test(text(l)));
    if (!label) throw new Error('checkbox not found: /' + labelSource + '/');
    const box = label.querySelector('input[type=checkbox]');
    if (want === undefined || box.checked !== want) box.click();
    return box.checked;
  }

  function setColor(input, hex) {
    setNative(input, hex);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function colorInput(ariaSource, index, within) {
    const re = rx(ariaSource);
    const list = all('input[type=color]', scope(within)).filter((i) => re.test(i.getAttribute('aria-label') || i.getAttribute('title') || ''));
    const el = list[index || 0];
    if (!el) throw new Error('colour input not found: /' + ariaSource + '/');
    return el;
  }

  function pickColor(ariaSource, hex, index, within) {
    setColor(colorInput(ariaSource, index, within), hex);
    return hex;
  }

  function errorToasts() {
    return all('.toast.error').map((t) => text(t.querySelector('.toast-text') || t));
  }

  function dismissToasts() {
    all('.toast-close').forEach((b) => b.click());
  }

  function statusText() {
    const s = document.querySelector('.statusbar');
    return s ? text(s) : '';
  }

  /** Main window: an image is loaded and no render is in flight. */
  function mainIdle() {
    if (!document.querySelector('.canvas-wrap canvas')) return 'no preview canvas';
    const badges = all('.canvas-badge .badge').map(text);
    if (badges.some((b) => /render/i.test(b))) return 'rendering';
    return true;
  }

  /** How much is actually drawn on a canvas: a blank one has one colour. */
  function canvasStats(selector) {
    const c = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!c) return { error: 'no canvas ' + selector };
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return { error: 'empty canvas' };
    const step = Math.max(1, Math.floor(Math.min(c.width, c.height) / 64));
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    let opaque = 0;
    let n = 0;
    for (let y = 0; y < c.height; y += step) {
      for (let x = 0; x < c.width; x += step) {
        const i = (y * c.width + x) * 4;
        seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
        if (d[i + 3] > 0) opaque++;
        n++;
      }
    }
    return { width: c.width, height: c.height, colours: seen.size, opaque: opaque / n };
  }

  /** DTF studio: preview drawn, not busy, and the full-resolution check has reported. */
  function dtfIdle() {
    if (!document.querySelector('.studio')) return 'no studio';
    if (all('.studio-bar .badge').some((b) => /working|dolgozik/i.test(text(b)))) return 'busy';
    const banner = document.querySelector('.status-banner');
    if (!banner) return 'no banner';
    if (!/\b(ok|warn|error)\b/.test(banner.className)) return 'checking';
    if (/calculating|számol/i.test(text(document.querySelector('.zp-view') || document.body))) return 'calculating';
    return true;
  }

  function screenIdle() {
    if (!document.querySelector('.studio')) return 'no studio';
    const view = document.querySelector('.zp-view');
    if (view && /calculating|számol/i.test(text(view))) return 'calculating';
    if (all('.view-scroll button').length < 2) return 'no films yet';
    return true;
  }

  function viewTabs() {
    return all('.view-scroll button').map(text);
  }

  function clickTab(index) {
    const tabs = all('.view-scroll button');
    tabs[index].click();
    return text(tabs[index]);
  }

  function readout() {
    return all('.readout-cell').map((c) => text(c.querySelector('.readout-label')) + '=' + text(c.querySelector('.readout-value')));
  }

  function bannerText() {
    const b = document.querySelector('.status-banner');
    return b ? b.className + ' :: ' + text(b) : '';
  }

  function checks() {
    return all('.check').map((c) => c.className.replace('check ', '') + ': ' + text(c.querySelector('.check-title')));
  }

  function layerCount() {
    return all('.layer').length;
  }

  function layerNames() {
    return all('.layer .layer-name').map(text);
  }

  /** Remove layers one at a time, waiting for each to leave the DOM. */
  async function removeAllLayers() {
    for (let guard = 0; guard < 60 && all('.layer').length > 0; guard++) {
      const before = all('.layer').length;
      const row = all('.layer')[0];
      const remove = all('button', row).find((b) => /remove|törlés/i.test(b.getAttribute('aria-label') || ''));
      remove.click();
      for (let i = 0; i < 40 && all('.layer').length === before; i++) await new Promise((r) => setTimeout(r, 25));
    }
    if (all('.layer').length > 0) throw new Error('could not remove every layer');
    return 0;
  }

  function addLayerOptions() {
    const s = all('select').find((x) => /layer|réteg/i.test(x.getAttribute('aria-label') || ''));
    return [...s.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, name: o.textContent }));
  }

  async function addLayer(value) {
    const s = all('select').find((x) => /layer|réteg/i.test(x.getAttribute('aria-label') || ''));
    const before = all('.layer').length;
    setNative(s, value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40 && all('.layer').length === before; i++) await new Promise((r) => setTimeout(r, 25));
    return all('.layer').length;
  }

  async function settle() {
    await new Promise((r) => setTimeout(r, 60));
  }

  async function layerRowButton(index, ariaSource) {
    const row = all('.layer')[index];
    const re = rx(ariaSource);
    const b = all('button', row).find((x) => re.test(x.getAttribute('aria-label') || ''));
    if (!b) throw new Error('no ' + ariaSource + ' on layer ' + index);
    b.click();
    await settle();
    return true;
  }

  async function selectLayer(index) {
    all('.layer .layer-name')[index].click();
    await settle();
    return true;
  }

  async function layerKey(index, key) {
    const target = all('.layer .layer-name')[index];
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }));
    await settle();
    return true;
  }

  function dispatchFile(kind, base64, name, mime) {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (kind === 'drop') {
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    } else {
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return true;
  }

  function modalOpen() {
    return document.querySelector('.modal') !== null;
  }

  function closeModal() {
    const b = document.querySelector('.modal-head button');
    if (b) b.click();
    return document.querySelector('.modal') === null;
  }

  function bodyHas(source) {
    return rx(source).test(document.body.innerText);
  }

  function spotSwatches() {
    return all('.spot-swatch').map((b) => b.getAttribute('aria-label'));
  }

  function clickSpotSwatch(index) {
    all('.spot-swatch')[index].click();
    return true;
  }

  function spotInks() {
    const sec = all('.section').find((s) => /ink colou?rs|festékszínek/i.test(text(s.querySelector('.section-toggle'))));
    return sec ? all('.color-field input[type=text]', sec).map((i) => i.value) : [];
  }

  function zoomControl(ariaSource) {
    const re = rx(ariaSource);
    const b = all('.zp-controls button').find((x) => re.test(x.getAttribute('aria-label') || x.getAttribute('title') || text(x)));
    if (!b) throw new Error('zoom control not found: ' + ariaSource);
    b.click();
    return text(document.querySelector('.zp-zoom'));
  }

  function minimapClick() {
    const m = document.querySelector('.zp-minimap');
    if (!m) return 'no minimap';
    const r = m.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.3, pointerId: 1 };
    m.dispatchEvent(new PointerEvent('pointerdown', opts));
    m.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  }

  function helpTabs() {
    return all('.help-tab').map(text);
  }

  function clickHelpTab(index) {
    all('.help-tab')[index].click();
    return text(document.querySelector('.help-page') || document.body).slice(0, 80);
  }

  function typeInto(selector, value) {
    const el = document.querySelector(selector);
    setNative(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function inkRows() {
    const sec = all('.section').find((s) => /^inks|^festékek/i.test(text(s.querySelector('.section-toggle'))));
    return sec ? all('.ink-row', sec).length : -1;
  }

  /** Tag a section by its title so later calls can scope to it with a selector. */
  function markSection(titleSource, within) {
    const re = rx(titleSource);
    const sec = all('.section', scope(within)).find((x) => re.test(text(x.querySelector('.section-toggle'))));
    if (!sec) throw new Error('section not found: /' + titleSource + '/');
    const toggle = sec.querySelector('.section-toggle');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const tag = 's' + Math.random().toString(36).slice(2, 8);
    all('[data-e2e]').forEach((x) => x.removeAttribute('data-e2e'));
    sec.setAttribute('data-e2e', tag);
    return '[data-e2e="' + tag + '"]';
  }

  /** Checkboxes in a container, by label. */
  function checkboxes(within) {
    return all('label.checkbox', scope(within)).map(text);
  }

  function pressPointer(source, within) {
    const b = button(source, within);
    if (!b) throw new Error('button not found: /' + source + '/');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const on = b.classList.contains('active');
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return on;
  }

  function langSelect(value) {
    const s = document.querySelector('.lang-select');
    setNative(s, value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((r) => setTimeout(() => r(s.value), 60));
  }

  window.__e2e = {
    markSection, markLayerSection, checkboxes, pressPointer, langSelect,
    button: (s, w) => !!button(s, w), click, isDisabled, exists, section, sectionTitles, options, choose, sliderInfo, setNumber,
    sliders, selects, checkbox, pickColor, errorToasts, dismissToasts, statusText, mainIdle, canvasStats, dtfIdle,
    screenIdle, viewTabs, clickTab, readout, bannerText, checks, layerCount, layerNames, removeAllLayers, addLayerOptions,
    addLayer, layerRowButton, selectLayer, layerKey, dispatchFile, modalOpen, closeModal, bodyHas, spotSwatches,
    clickSpotSwatch, spotInks, zoomControl, minimapClick, helpTabs, clickHelpTab, typeInto, inkRows,
  };
})();
`;
