// Theory: short lessons on music theory, guitar and DJing, each with something to play.
// renderTheory(root, path) draws the hub (''), a section ('guitar') or a lesson ('guitar/tuner').
// Lessons link to each other through location.hash ('#theory/...').
import { h } from './ui.js';
import { stopAll } from './theory-audio.js';
import { Scope, ic, linkList } from './theory-ui.js';
import { BASICS } from './theory-basics.js';
import { GUITAR } from './theory-guitar.js';
import { DJ } from './theory-dj.js';

const SECTIONS = [BASICS, GUITAR, DJ];
const COURSES = [
  { t: 'Learning Music', by: 'Ableton · a free, hands-on course in the browser', url: 'https://learningmusic.ableton.com/' },
  { t: 'Music theory lessons', by: 'musictheory.net · short illustrated lessons and exercises', url: 'https://www.musictheory.net/lessons' },
  { t: 'JustinGuitar', by: 'YouTube · a complete free guitar course, from the first chord', url: 'https://www.youtube.com/@justinguitar' },
];

let scope = null;

// Stop everything the current page started: sound, clocks, animation frames, mic listeners.
export function stopTheory() {
  if (scope) scope.dispose();
  scope = null;
  stopAll();
}

export function renderTheory(root, path = '') {
  stopTheory();
  scope = new Scope();
  root.replaceChildren();
  root.classList.add('th');
  const [sid, lid] = String(path || '').split('/').filter(Boolean);
  const sec = SECTIONS.find((s) => s.id === sid);
  const idx = sec ? sec.lessons.findIndex((l) => l.id === lid) : -1;
  if (sec && idx >= 0) renderLesson(root, sec, idx);
  else if (sec) renderSection(root, sec);
  else renderHub(root);
}

// ---------------------------------------------------------------------------
const back = (href, label) => h('a', { class: 'back', href }, ic('back', 18), label);

// **bold** inside lesson text.
function rich(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('strong', {}, m[1]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const block = (b) => (typeof b === 'string' ? h('p', {}, ...rich(b)) : h('ul', {}, ...b.list.map((x) => h('li', {}, ...rich(x)))));

function renderHub(root) {
  document.title = 'Theory · Swara Lab';
  const tile = (s, hero) => h('a', { class: 'tile' + (hero ? ' hero' : ''), href: '#theory/' + s.id },
    h('span', { class: 't-ic' }, ic(s.icon, 20)),
    h('span', { class: 't-body' }, h('span', { class: 't-title' }, s.title), h('span', { class: 't-sub' }, s.sub), h('span', { class: 't-sub th-count' }, `${s.lessons.length} lessons`)),
    h('span', { class: 't-go' }, ic('chevron', 18)));
  root.append(
    h('div', { class: 'page-head' }, h('div', { class: 'eyebrow' }, 'Theory'), h('h1', {}, 'Music, explained by ear'),
      h('p', { class: 'lead' }, 'Short lessons, each with something to play. Start anywhere.')),
    h('div', { class: 'grid3' }, ...SECTIONS.map((s, i) => tile(s, i === 0))),
    h('div', { class: 'section' }, h('h2', {}, 'For singers')),
    h('div', { class: 'list' },
      h('a', { href: '#learn' }, h('span', { class: 'li-ic' }, ic('mic', 18)),
        h('span', { class: 'li-text' }, h('strong', {}, 'Singing guide'), h('small', {}, 'How to practise on your own, fixes for common problems, and Indian music terms.')),
        h('span', { class: 'li-end' }, ic('chevron', 16))),
      h('a', { href: '#theory/basics/singing' }, h('span', { class: 'li-ic' }, ic('ear', 18)),
        h('span', { class: 'li-text' }, h('strong', {}, 'Theory for singers'), h('small', {}, 'Scale degrees and sargam, with a ladder that shows where your voice lands.')),
        h('span', { class: 'li-end' }, ic('chevron', 16)))),
    h('div', { class: 'section' }, h('h2', {}, 'Free courses')),
    linkList(COURSES));
}

function renderSection(root, sec) {
  document.title = `${sec.title} · Theory · Swara Lab`;
  root.append(
    back('#theory', 'Theory'),
    h('div', { class: 'page-head' }, h('div', { class: 'eyebrow' }, `${sec.lessons.length} lessons`), h('h1', {}, sec.title), h('p', { class: 'lead' }, sec.lead)),
    h('div', { class: 'list th-lessons' }, ...sec.lessons.map((l, i) => h('a', { href: `#theory/${sec.id}/${l.id}` },
      h('span', { class: 'li-ic th-num' }, String(i + 1)),
      h('span', { class: 'li-text' }, h('strong', {}, l.title), h('small', {}, l.sub)),
      h('span', { class: 'li-end' }, ic('chevron', 16))))));
  const others = SECTIONS.filter((s) => s !== sec);
  root.append(h('nav', { class: 'th-also', 'aria-label': 'Other sections' }, h('span', {}, 'Also'),
    ...others.map((s) => h('a', { class: 'btn small', href: '#theory/' + s.id }, ic(s.icon, 16), s.title))));
}

function renderLesson(root, sec, idx) {
  const l = sec.lessons[idx];
  document.title = `${l.title} · Swara Lab`;
  const demo = h('section', { class: 'card th-demo', 'aria-label': 'Try it' }, h('div', { class: 'th-demo-label' }, 'Try it'));
  root.append(
    back(`#theory/${sec.id}`, sec.title),
    h('header', { class: 'page-head' },
      h('div', { class: 'eyebrow' }, `${sec.title} · ${idx + 1} of ${sec.lessons.length}`),
      h('h1', {}, l.title), h('p', { class: 'lead' }, l.lead)),
    h('div', { class: 'th-text' }, ...l.body.map(block), l.tip ? h('p', { class: 'th-tip' }, ic('sparkle', 16), h('span', {}, l.tip)) : null),
    demo);
  if (l.practice) root.append(h('h2', { class: 'th-h' }, 'Practise it'), linkList(l.practice));
  root.append(h('h2', { class: 'th-h' }, 'Watch and read'), linkList(l.links), pager(sec, idx));
  try {
    l.demo(demo, scope);
  } catch (e) {
    console.error(e);
    demo.append(h('p', { class: 'th-note' }, 'This demo could not start in this browser.'));
  }
}

function pager(sec, idx) {
  const prev = sec.lessons[idx - 1], next = sec.lessons[idx + 1];
  const link = (l, label, cls) => h('a', { class: 'th-pg ' + cls, href: `#theory/${sec.id}/${l.id}` }, h('small', {}, label), h('strong', {}, l.title));
  return h('nav', { class: 'th-pager', 'aria-label': 'Lessons' },
    prev ? link(prev, 'Previous', 'is-prev') : h('span'),
    next ? link(next, 'Next', 'is-next') : h('a', { class: 'th-pg is-next', href: `#theory/${sec.id}` }, h('small', {}, 'Done'), h('strong', {}, `All ${sec.title} lessons`)));
}
