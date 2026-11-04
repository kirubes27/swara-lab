// Tiny DOM helpers shared by all pages.
import { mic } from './audio.js';
import { settings } from './store.js';

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
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
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
    toast(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it from the address bar (🔒 icon) and try again.' : 'Could not start the microphone: ' + e.message, 'bad', 7000);
    return false;
  }
}

export function tipList(tips) {
  const ul = h('ul', { class: 'tips' });
  for (const t of tips) {
    const li = h('li', { class: 'tip ' + (t.level || 'info') }, h('strong', {}, t.title), h('p', {}, t.detail));
    if (t.drill) li.append(h('a', { class: 'tip-link', href: '#drills/' + t.drill }, 'Open drill →'));
    ul.append(li);
  }
  return ul;
}

export function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}
