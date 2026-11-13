// Tiny DOM helpers shared by all pages.
import { mic } from './audio.js';
import { settings } from './store.js';
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function toast(msg, kind = 'info', ms = 4200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export async function ensureMic() {
  if (mic.running) return true;
  try {
    await mic.start();
    mic.setSensitivity(settings.micSens);
    document.dispatchEvent(new CustomEvent('mic-change'));
    return true;
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it from the site settings next to the address bar, then try again.' : 'Could not start the microphone: ' + e.message, 'bad', 7000);
    return false;
  }
}

export function tipList(tips) {
  const ul = h('ul', { class: 'tips' });
  for (const t of tips) {
    const li = h('li', { class: 'tip ' + (t.level || 'info') }, h('strong', {}, t.title), h('p', {}, t.detail));
    if (t.drill) li.append(h('a', { class: 'tip-link', href: '#practice/' + t.drill }, 'Open the drill'));
    ul.append(li);
  }
  return ul;
}

export function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

// ---- popovers, menus, sheets --------------------------------------------------------
// One small floating panel at a time, anchored to the button that opened it.
let openPop = null;
let menuAnchor = null; // the button whose menu item is running: a sheet it opens returns focus there
export function closePopover() { if (openPop) { const p = openPop; openPop = null; p.close(); } }
export function popoverOpen() { return !!openPop; }
export function popover(anchor, content, { align = 'start', className = '', onClose } = {}) {
  if (openPop && openPop.anchor === anchor) { closePopover(); return null; } // a second click closes it
  closePopover();
  const el = h('div', { class: 'pop ' + className }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, ht = el.offsetHeight;
    let x = align === 'end' ? r.right - w : align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    let y = r.bottom + 8;
    if (y + ht > window.innerHeight - 8 && r.top - ht - 8 > 8) y = r.top - ht - 8;
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.max(8, y)) + 'px';
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { closePopover(); anchor.focus(); } };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
  const handle = {
    anchor, el, place,
    close: () => {
      el.classList.add('out'); setTimeout(() => el.remove(), 150);
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      onClose && onClose();
    },
  };
  openPop = handle;
  const first = el.querySelector('button:not([disabled]), input, select, textarea');
  if (first && anchor.matches(':focus-visible')) first.focus();
  return handle;
}
// items: { label, sub, icon, checked, disabled, danger, onclick } | 'sep' | { head } | { el }
export function menu(anchor, items, opts = {}) {
  const list = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { list.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.head) { list.append(h('div', { class: 'menu-head' }, it.head)); continue; }
    if (it.el) { list.append(it.el); continue; }
    list.append(h('button', {
      class: 'menu-item' + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : ''), role: it.checked != null ? 'menuitemradio' : 'menuitem',
      'aria-checked': it.checked != null ? String(!!it.checked) : null, disabled: it.disabled, title: it.title,
      onclick: () => {
        if (!it.keepOpen) closePopover();
        menuAnchor = anchor;
        try { it.onclick && it.onclick(); } finally { menuAnchor = null; }
        // nothing else took focus (no sheet, no other menu): back to the button that opened this one
        const ae = document.activeElement;
        if (!it.keepOpen && anchor.isConnected && !openPop && !document.querySelector('dialog[open]') && (!ae || ae === document.body || list.contains(ae))) anchor.focus();
      },
    },
    h('span', { class: 'mi-ic' }, it.checked ? icon('check', 15) : it.icon ? icon(it.icon, 16) : null),
    h('span', { class: 'mi-text' }, h('span', {}, it.label), it.sub ? h('small', {}, it.sub) : null),
    it.end ? h('span', { class: 'mi-end' }, it.end) : null));
  }
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.menu-item:not(:disabled), .menu-switch input:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    const go = (k) => { e.preventDefault(); items[(k + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1); else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(-1);
    else if (e.key === 'Enter' && e.target.matches('.menu-switch input')) { e.preventDefault(); e.target.click(); }
    else if (e.key === 'Tab') { e.preventDefault(); closePopover(); anchor.focus(); }
  });
  return popover(anchor, list, opts);
}
// A centred dialog for anything that needs more room than a menu.
let sheetN = 0;
export function sheet(title, body, { actions = [], onClose, wide = false } = {}) {
  const back = openPop ? openPop.anchor : menuAnchor || document.activeElement; // where focus returns afterwards
  closePopover();
  const id = 'sheet-title-' + ++sheetN;
  const dlg = h('dialog', { class: 'sheet' + (wide ? ' wide' : ''), 'aria-labelledby': id });
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.append(...[
    h('div', { class: 'sheet-head' }, h('h3', { id }, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 18))),
    h('div', { class: 'sheet-body' }, body),
    actions.length ? h('div', { class: 'sheet-foot' }, ...actions) : null].filter(Boolean));
  dlg.addEventListener('close', () => { dlg.remove(); if (back && back.isConnected && back.focus) back.focus(); onClose && onClose(); });
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) close(); }); // click on the backdrop
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}
export function chipBtn(label, value, { onclick, tone = '', title } = {}) {
  return h('button', { class: 'chip-btn' + (tone ? ' ' + tone : ''), title, onclick, 'aria-haspopup': 'dialog' },
    label ? h('span', { class: 'cl' }, label) : null, h('span', { class: 'cv' }, value));
}
