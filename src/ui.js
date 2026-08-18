// ui.js — the default UI adapter: everything the headless engine refuses to
// inject. The bottom-right hub bar (a toggle pill and a × clear per tool, the
// include-checkboxes, COPY JSON), the fixed #laNotes list, and the global cmd+Z
// that routes to the engine's stroke undo.
//
// Each tool registers once and gets uniform chrome. Turning a tool on turns the
// others off: an active tool owns the pointer, so only one can be live at a time.
//
//   import { register } from './ui.js';
//   const handle = register({ id, label, labelOn, getOn, setOn, clear, getData });
//   handle.setOn(v)   // toggle from outside; keeps the pill in sync

import { resolve } from './identify.js';
import { mark, chrome } from './mark.js';

const INK = '#17110C', FILL = '#FDFDFC';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

const pillStyle = {
  font: `600 11px/1 ${MONO}`,
  letterSpacing: '0.12em',
  padding: '9px 14px',
  border: '1px solid ' + INK,
  borderRadius: '999px',
  background: FILL,
  color: INK,
  cursor: 'pointer',
};

const PANEL_CSS = `
  #laNotes { position: fixed; top: 16px; left: 16px; width: 258px; box-sizing: border-box; z-index: 99993;
    background: rgba(20, 20, 20, .9); color: #F2F2F0; border-radius: 8px; padding: 14px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  #laNotes h2 { font-size: 12px; margin: 0 0 4px; letter-spacing: .04em; text-transform: uppercase; opacity: .7; }
  #laNotes .hint { margin: 0; opacity: .6; }
  #laNoteList:not(:empty) { margin-top: 10px; }
  .laNoteRow { display: grid; grid-template-columns: 18px 1fr 20px; gap: 6px; align-items: center; margin: 5px 0; }
  .laNoteRow .num { color: #e5484d; font-weight: 700; text-align: center; }
  .laNoteRow input { width: 100%; box-sizing: border-box; background: #0d0d0d; color: #F2F2F0;
    border: 1px solid #2c2c2c; border-radius: 4px; padding: 4px 6px; font: inherit; }
  .laNoteRow button { background: none; border: 0; color: #e5484d; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; }
  .laNoteRow.stale { opacity: .45; }
  #laNotes.failed { outline: 2px solid #e5484d; }
  #laNotes .laSaveWarn { display: none; margin: 10px 0 0; padding-top: 8px;
    border-top: 1px solid #4a2326; color: #ff9ea1; }
  #laNotes.failed .laSaveWarn { display: block; }
`;

// ---------- hub ----------

export const tools = [];
let copyRow = null, toolRow = null, copyBtn = null;

function ensureUI() {
  if (toolRow) return;
  const bar = chrome(document.createElement('div'));
  Object.assign(bar.style, {
    position: 'fixed', right: '14px', bottom: '14px', zIndex: 99995,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
  });
  copyRow = document.createElement('div');
  Object.assign(copyRow.style, { display: 'flex', gap: '10px', alignItems: 'center' });
  toolRow = document.createElement('div');
  Object.assign(toolRow.style, { display: 'flex', gap: '8px', alignItems: 'center' });
  copyBtn = document.createElement('button');
  copyBtn.textContent = 'COPY JSON';
  Object.assign(copyBtn.style, pillStyle, { background: INK, color: FILL });
  copyBtn.addEventListener('click', () => {
    const flash = t => {
      copyBtn.textContent = t;
      setTimeout(() => { copyBtn.textContent = 'COPY JSON'; }, 1200);
    };
    if (!navigator.clipboard) return flash('COPY FAILED');
    navigator.clipboard.writeText(json()).then(() => flash('COPIED ✓'), () => flash('COPY FAILED'));
  });
  copyRow.appendChild(copyBtn);
  bar.append(copyRow, toolRow);
  document.body.appendChild(bar);
}

export function register(tool) {
  ensureUI();
  const entry = { ...tool, checked: true };
  tools.push(entry);

  const pick = document.createElement('label');
  Object.assign(pick.style, {
    display: 'flex', alignItems: 'center', gap: '4px',
    font: `600 10px/1 ${MONO}`, letterSpacing: '0.1em', color: INK, cursor: 'pointer',
  });
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  Object.assign(cb.style, { accentColor: INK, margin: '0' });
  cb.addEventListener('change', () => { entry.checked = cb.checked; });
  pick.append(cb, document.createTextNode(entry.label));
  copyRow.insertBefore(pick, copyBtn);

  const clearBtn = document.createElement('button');
  clearBtn.textContent = '×';
  clearBtn.title = 'clear ' + entry.label.toLowerCase();
  Object.assign(clearBtn.style, pillStyle, {
    padding: '0', width: '31px', height: '31px', fontSize: '15px', letterSpacing: '0',
  });
  clearBtn.addEventListener('click', () => entry.clear());

  entry.pill = document.createElement('button');
  Object.assign(entry.pill.style, pillStyle);
  entry.pill.addEventListener('click', () => setActive(entry, !entry.getOn()));
  toolRow.append(clearBtn, entry.pill);
  syncPill(entry);

  return { setOn: v => setActive(entry, v) };
}

function setActive(entry, v) {
  if (v) for (const t of tools) if (t !== entry && t.getOn()) { t.setOn(false); syncPill(t); }
  entry.setOn(v);
  syncPill(entry);
}

function syncPill(t) {
  const on = t.getOn();
  t.pill.textContent = on ? (t.labelOn || t.label) : t.label;
  t.pill.style.background = on ? INK : FILL;
  t.pill.style.color = on ? FILL : INK;
}

export function syncPills() {
  for (const t of tools) if (t.pill) syncPill(t);
}

// The engine's projection is grouped by target, so COPY JSON asks it for one
// blob and lets the include-checkboxes drop the sections the user unticked.
let dataSource = null;
export function setDataSource(fn) { dataSource = fn; }

export function json() {
  const out = { file: location.pathname.split('/').pop() || location.pathname };
  if (dataSource) {
    Object.assign(out, dataSource(Object.fromEntries(tools.map(t => [t.id, t.checked]))));
  }
  for (const t of tools) if (t.checked && t.getData) out[t.id] = t.getData();
  return JSON.stringify(out, null, 2);
}

export function off() {
  for (const t of tools) if (t.getOn()) { t.setOn(false); syncPill(t); }
}

// ---------- the notes panel ----------

export function attachNotesPanel(pen) {
  if (!document.getElementById('laPanelStyle')) {
    const style = mark(document.createElement('style'));
    style.id = 'laPanelStyle';
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);
  }

  const panel = chrome(document.createElement('aside'));
  panel.id = 'laNotes';
  panel.innerHTML = `<h2>Notes</h2>
  <p class="hint">Toggle NOTES, then click an element or drag a box across an area. COPY JSON sends it all back.</p>
  <div id="laNoteList"></div>
  <p class="laSaveWarn">Not saving. Storage is full or unavailable, so these notes only exist in this tab. COPY JSON before you close it.</p>`;
  document.body.appendChild(panel);
  const list = panel.querySelector('#laNoteList');

  const rowEls = new Map();

  function renderRows() {
    list.innerHTML = '';
    rowEls.clear();
    for (const it of pen.items()) {
      const row = document.createElement('div');
      row.className = 'laNoteRow';
      row.title = (it.target && it.target.selector) || it.target_id;
      const num = document.createElement('span'); num.className = 'num'; num.textContent = it.id;
      const input = document.createElement('input');
      input.value = it.text;
      input.placeholder = "what's wrong here";
      input.addEventListener('input', () => pen.setNote(it.id, input.value));
      const del = document.createElement('button'); del.textContent = '×'; del.title = 'delete';
      del.addEventListener('click', () => pen.remove(it.id));
      row.append(num, input, del);
      list.appendChild(row);
      rowEls.set(it.id, { row, item: it });
    }
    markStale();
  }

  function markStale() {
    for (const { row, item } of rowEls.values()) row.classList.toggle('stale', !!item.target && !resolve(item.target));
  }

  pen.addEventListener('change', e => {
    const { action, item } = e.detail;
    if (action === 'note') return;
    // `load` is the stored feedback arriving: the store hydrates asynchronously,
    // so the first render is of an empty list and this is the one that fills it
    if (action === 'add' || action === 'remove' || action === 'clear' || action === 'load') {
      renderRows();
      if (action === 'add') rowEls.get(item.id)?.row.querySelector('input').focus();
    }
  });
  pen.addEventListener('layout', markStale);
  // sticky on purpose: it stays for the rest of the session
  pen.addEventListener('save:error', () => panel.classList.add('failed'));
  // sticky means sticky: a panel attached after the failure starts red too
  if (pen.saveFailed?.()) panel.classList.add('failed');

  renderRows();
  return { panel, renderRows };
}

// ---------- global keys ----------
// The engine binds no keyboard; the standalone host does. cmd/ctrl+Z undoes the
// last stroke while the draw tool is live.

export function attachKeys(pen) {
  const onKey = e => {
    if (pen.mode() !== 'draw') return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      pen.undoStroke();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
