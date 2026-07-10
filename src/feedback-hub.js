// feedback-hub.js — shared chrome + copy registry for the redpen review tools.
// Each tool registers once and gets uniform UI: a toggle pill and a × clear in the
// bottom-right bar, a checkbox in the copy row, and its own namespace in the JSON
// block that COPY JSON puts on the clipboard. Turning a tool on turns the others
// off: an active tool owns the pointer, so only one can be live at a time.
//
//   import { register } from './feedback-hub.js';
//   const handle = register({ id, label, labelOn, getOn, setOn, clear, getData });
//   handle.setOn(v)   // toggle from outside; keeps the pill in sync

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

const tools = [];
let copyRow = null, toolRow = null, copyBtn = null;

function ensureUI() {
  if (toolRow) return;
  const bar = document.createElement('div');
  bar.dataset.laUi = '1';
  bar.setAttribute('sap-ignore', '');
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

export function json() {
  const out = { file: location.pathname.split('/').pop() || location.pathname };
  for (const t of tools) if (t.checked) out[t.id] = t.getData();
  return JSON.stringify(out, null, 2);
}

export function off() {
  for (const t of tools) if (t.getOn()) { t.setOn(false); syncPill(t); }
}

// a second bundle evaluation must not replace the live registry with an empty one
if (!window.FeedbackHub) window.FeedbackHub = { register, json, off, tools };
