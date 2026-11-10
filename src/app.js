'use strict';

/* =========================================================
   FileBoard — доска для файлов, папок, ссылок и заметок
   ========================================================= */

const TAURI = window.__TAURI__;
// вне программы (в обычном браузере для проверки интерфейса) можно подставить window.mockInvoke
const invoke = TAURI
  ? TAURI.core.invoke
  : async (cmd, args) => { if (window.mockInvoke) return window.mockInvoke(cmd, args); throw new Error('no tauri'); };

const $ = (s) => document.querySelector(s);
const boardEl = $('#board');
const worldEl = $('#world');
const framesEl = $('#frames');
const itemsEl = $('#items');
const tabsEl = $('#tabs');
const menuEl = $('#menu');
const statusEl = $('#status');
const searchEl = $('#search');

const NOTE_COLORS = ['#ffe27a', '#ffb3c7', '#b5f0c5', '#b3dcff', '#d9c2ff', '#ffc98a', '#f1f1f1'];
const FRAME_COLORS = ['#6c8cff', '#4fd1a1', '#f5b83d', '#ff6b8a', '#b07cff', '#3fc3e6', '#8b8fa3'];
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

let state = null;          // { version, active, boards: [...] }
let board = null;          // текущая доска
const els = new Map();     // id -> DOM-элемент
let selected = new Set();  // id выделенных
const iconCache = new Map(); // путь -> dataURL | null
const iconPending = new Map();
const missing = new Map(); // путь -> true, если файла нет
let undoStack = [];
let redoStack = [];
let draggingOut = false;
let spaceDown = false;
let lastMouse = null;      // последняя позиция мыши над доской (client)
let searchMatches = [];
let searchIndex = -1;

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const byId = (id) => board.items.find((i) => i.id === id);
const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- данные ---------------- */

function newBoard(name) {
  return { id: uid(), name, view: { x: 60, y: 40, zoom: 1 }, items: [] };
}

function defaultState() {
  const b = newBoard('Главная');
  return { version: 1, active: b.id, boards: [b] };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await invoke('save_data', { json: JSON.stringify(state) });
  } catch (e) {
    toast('Не удалось сохранить: ' + e);
  }
}

function snapshot() {
  undoStack.push(JSON.stringify(board.items));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function undo() {
  if (!undoStack.length) return toast('Нечего отменять');
  redoStack.push(JSON.stringify(board.items));
  board.items = JSON.parse(undoStack.pop());
  selected.clear();
  renderAll();
  save();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(board.items));
  board.items = JSON.parse(redoStack.pop());
  selected.clear();
  renderAll();
  save();
}

/* ---------------- утилиты путей и ссылок ---------------- */

function baseName(p) {
  const clean = p.replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(clean)) return clean + ' (диск)';
  const name = clean.split(/[\\/]/).pop() || p;
  return name.replace(/\.(lnk|url)$/i, '');
}

function itemLabel(it) {
  if (it.type === 'file') return it.label || baseName(it.path);
  if (it.type === 'link') return it.title || hostOf(it.url);
  if (it.type === 'note') return it.text || '';
  if (it.type === 'frame') return it.title || '';
  return '';
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function normalizeUrl(s) {
  s = s.trim();
  if (!s) return '';
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(s)) return 'https://' + s;
  return '';
}

const FOLDER_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M6 16a5 5 0 0 1 5-5h14l6 6h22a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z" fill="#f5b83d"/><path d="M6 24h52v24a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z" fill="#ffcf5c"/></svg>');
const FILE_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 6h22l12 12v38a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z" fill="#c9cdd9"/><path d="M38 6v10a2 2 0 0 0 2 2h10z" fill="#9aa0b2"/></svg>');

const PC_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="10" width="52" height="34" rx="4" fill="#6c8cff"/><rect x="10" y="14" width="44" height="26" rx="2" fill="#bcd0ff"/><rect x="22" y="48" width="20" height="5" rx="2" fill="#8b8fa3"/></svg>');
const DRIVE_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="20" width="52" height="24" rx="5" fill="#9aa0b2"/><rect x="10" y="34" width="30" height="4" rx="2" fill="#5b6070"/><circle cx="49" cy="36" r="3" fill="#4fd1a1"/></svg>');

function loadIcon(path) {
  if (iconCache.has(path)) return Promise.resolve(iconCache.get(path));
  if (iconPending.has(path)) return iconPending.get(path);
  const p = invoke('get_icon', { path, size: 96 })
    .then((url) => { iconCache.set(path, url); return url; })
    .catch(() => null)
    .finally(() => iconPending.delete(path));
  iconPending.set(path, p);
  return p;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|avif|mp4|mkv|mov|avi|webm)$/i;

/* ---------------- отрисовка ---------------- */

function applyView() {
  const v = board.view;
  worldEl.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
  const g = 24 * v.zoom;
  boardEl.style.backgroundSize = `${g}px ${g}px`;
  boardEl.style.backgroundPosition = `${v.x}px ${v.y}px`;
  boardEl.style.backgroundImage = v.zoom < 0.35 ? 'none' : '';
  $('#zoomVal').textContent = Math.round(v.zoom * 100) + '%';
}

function renderAll() {
  framesEl.textContent = '';
  itemsEl.textContent = '';
  els.clear();
  for (const it of board.items) syncItem(it);
  for (const id of [...selected]) if (!els.has(id)) selected.delete(id);
  refreshSelection();
  applyView();
  updateEmpty();
  if (searchEl.value) runSearch();
}

function updateEmpty() {
  $('#empty').classList.toggle('show', board.items.length === 0);
  sideMarkOnBoard();
}

function createEl(it) {
  const el = document.createElement('div');
  el.dataset.id = it.id;
  if (it.type === 'file') {
    el.className = 'item file';
    el.innerHTML = '<div class="icon"><img alt=""><div class="badge">!</div></div><div class="label"></div>';
    const img = el.querySelector('img');
    img.src = it.isDir ? FOLDER_SVG : FILE_SVG;
    loadIcon(it.path).then((url) => {
      if (url) {
        img.src = url;
        img.classList.toggle('thumb', !it.isDir && IMAGE_EXT.test(it.path));
      }
    });
  } else if (it.type === 'link') {
    el.className = 'item link';
    el.innerHTML = '<div class="fav"></div><div class="ltext"><div class="ltitle"></div><div class="lurl"></div></div>';
    const fav = el.querySelector('.fav');
    const host = hostOf(it.url);
    fav.textContent = (host[0] || '?').toUpperCase();
    try {
      const u = new URL(it.url);
      if (u.protocol.startsWith('http')) {
        const img = new Image();
        img.onload = () => { if (img.naturalWidth > 1) { fav.textContent = ''; fav.appendChild(img); } };
        img.src = `${u.origin}/favicon.ico`;
      }
    } catch {}
  } else if (it.type === 'note') {
    el.className = 'item note';
    el.innerHTML = '<div class="ntext"></div><div class="resize"></div>';
  } else if (it.type === 'frame') {
    el.className = 'frame';
    el.innerHTML = '<div class="ftitle"></div><div class="resize"></div>';
  }
  return el;
}

function syncItem(it) {
  let el = els.get(it.id);
  if (!el) {
    el = createEl(it);
    els.set(it.id, el);
    (it.type === 'frame' ? framesEl : itemsEl).appendChild(el);
  }
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  if (it.type === 'file') {
    el.querySelector('.label').textContent = itemLabel(it);
    el.title = it.path;
    el.classList.toggle('missing', !!missing.get(it.path));
  } else if (it.type === 'link') {
    el.querySelector('.ltitle').textContent = itemLabel(it);
    el.querySelector('.lurl').textContent = it.url.replace(/^https?:\/\/(www\.)?/, '');
    el.title = it.url;
  } else if (it.type === 'note') {
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
    el.style.setProperty('--nc', it.color);
    const t = el.querySelector('.ntext');
    if (!t.isContentEditable) t.textContent = it.text || '';
  } else if (it.type === 'frame') {
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
    el.style.setProperty('--fc', it.color);
    el.querySelector('.ftitle').textContent = it.title || 'Без названия';
  }
}

function removeItems(ids) {
  const set = new Set(ids);
  board.items = board.items.filter((i) => !set.has(i.id));
  for (const id of set) {
    els.get(id)?.remove();
    els.delete(id);
    selected.delete(id);
  }
  refreshSelection();
  updateEmpty();
}

function bringToFront(ids) {
  const set = new Set(ids);
  const moved = board.items.filter((i) => set.has(i.id) && i.type !== 'frame');
  if (!moved.length) return;
  board.items = board.items.filter((i) => !set.has(i.id) || i.type === 'frame').concat(moved);
  for (const it of moved) itemsEl.appendChild(els.get(it.id));
}

function refreshSelection() {
  for (const [id, el] of els) el.classList.toggle('selected', selected.has(id));
  updateStatus();
}

function updateStatus() {
  statusEl.textContent = '';
  if (selected.size === 1) {
    const it = byId([...selected][0]);
    if (!it) return;
    if (it.type === 'file') {
      const span = document.createElement('span');
      span.className = 'path';
      span.textContent = it.path;
      span.title = 'Показать в Проводнике';
      span.onclick = () => reveal(it);
      statusEl.append(missing.get(it.path) ? '⚠ Не найден: ' : '', span);
    } else if (it.type === 'link') {
      const span = document.createElement('span');
      span.className = 'path';
      span.textContent = it.url;
      span.onclick = () => activate(it);
      statusEl.append(span);
    } else {
      statusEl.textContent = it.type === 'note' ? 'Заметка' : 'Рамка: ' + (it.title || '');
    }
  } else if (selected.size > 1) {
    statusEl.textContent = `Выбрано: ${selected.size}`;
  } else {
    const n = board.items.filter((i) => i.type !== 'frame').length;
    statusEl.textContent = n ? `Элементов на доске: ${n}` : '';
  }
}

/* ---------------- вкладки досок ---------------- */

function renderTabs() {
  tabsEl.textContent = '';
  for (const b of state.boards) {
    const t = document.createElement('div');
    t.className = 'tab' + (b.id === state.active ? ' active' : '');
    t.textContent = b.name;
    t.title = b.name;
    t.onclick = () => switchBoard(b.id);
    t.ondblclick = () => renameBoard(b);
    t.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Переименовать', action: () => renameBoard(b) },
        { label: 'Сдвинуть влево', action: () => moveBoard(b, -1), disabled: state.boards[0] === b },
        { label: 'Сдвинуть вправо', action: () => moveBoard(b, 1), disabled: state.boards.at(-1) === b },
        { sep: true },
        { label: 'Удалить доску', danger: true, action: () => deleteBoard(b), disabled: state.boards.length < 2 },
      ]);
    };
    tabsEl.appendChild(t);
  }
  tabsEl.querySelector('.active')?.scrollIntoView({ inline: 'nearest' });
}

function switchBoard(id) {
  const b = state.boards.find((x) => x.id === id) || state.boards[0];
  if (board && b === board) return;
  finishEditing();
  board = b;
  state.active = b.id;
  selected.clear();
  undoStack = [];
  redoStack = [];
  renderTabs();
  renderAll();
  refreshMissing();
  save();
}

async function addBoard() {
  const name = await promptDialog({ title: 'Новая доска', fields: [{ label: 'Название', value: 'Доска ' + (state.boards.length + 1) }] });
  if (!name) return;
  const b = newBoard(name[0].trim() || 'Без названия');
  state.boards.push(b);
  switchBoard(b.id);
}

async function renameBoard(b) {
  const r = await promptDialog({ title: 'Переименовать доску', fields: [{ label: 'Название', value: b.name }] });
  if (!r) return;
  b.name = r[0].trim() || b.name;
  renderTabs();
  save();
}

function moveBoard(b, dir) {
  const i = state.boards.indexOf(b);
  const j = i + dir;
  if (j < 0 || j >= state.boards.length) return;
  [state.boards[i], state.boards[j]] = [state.boards[j], state.boards[i]];
  renderTabs();
  save();
}

async function deleteBoard(b) {
  if (state.boards.length < 2) return;
  const n = b.items.length;
  const ok = await confirmDialog('Удалить доску «' + b.name + '»?',
    n ? `На ней ${n} элемент(ов). Сами файлы на компьютере не пострадают — удалятся только карточки.` : 'Доска пустая.',
    'Удалить');
  if (!ok) return;
  const i = state.boards.indexOf(b);
  state.boards.splice(i, 1);
  if (board === b) {
    board = null;
    switchBoard(state.boards[Math.max(0, i - 1)].id);
  } else {
    renderTabs();
    save();
  }
}

/* ---------------- координаты и масштаб ---------------- */

function boardRect() { return boardEl.getBoundingClientRect(); }

function toWorld(cx, cy) {
  const r = boardRect();
  const v = board.view;
  return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
}

function viewCenterClient() {
  const r = boardRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function zoomAt(cx, cy, z) {
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  const r = boardRect();
  const p = toWorld(cx, cy);
  const v = board.view;
  v.zoom = z;
  v.x = cx - r.left - p.x * z;
  v.y = cy - r.top - p.y * z;
  applyView();
  save();
}

function zoomStep(dir) {
  const c = viewCenterClient();
  zoomAt(c.x, c.y, board.view.zoom * (dir > 0 ? 1.2 : 1 / 1.2));
}

function itemBounds(it) {
  const el = els.get(it.id);
  const w = it.w || (el ? el.offsetWidth : 104);
  const h = it.h || (el ? el.offsetHeight : 100);
  return { x: it.x, y: it.y, w, h };
}

let anim = null;
function animateView(target, ms = 260) {
  cancelAnimationFrame(anim);
  const from = { ...board.view };
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    board.view.x = from.x + (target.x - from.x) * e;
    board.view.y = from.y + (target.y - from.y) * e;
    board.view.zoom = from.zoom + (target.zoom - from.zoom) * e;
    applyView();
    if (k < 1) anim = requestAnimationFrame(step);
    else save();
  };
  anim = requestAnimationFrame(step);
}

function fitAll() {
  const list = board.items;
  if (!list.length) return animateView({ x: 60, y: 40, zoom: 1 });
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of list) {
    const b = itemBounds(it);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y - (it.type === 'frame' ? 16 : 0));
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  const r = boardRect();
  const pad = 50;
  const z = clamp(Math.min((r.width - pad * 2) / (x2 - x1), (r.height - pad * 2) / (y2 - y1)), MIN_ZOOM, 1.25);
  animateView({ x: (r.width - (x2 - x1) * z) / 2 - x1 * z, y: (r.height - (y2 - y1) * z) / 2 - y1 * z, zoom: z });
}

function flyTo(it) {
  const b = itemBounds(it);
  const r = boardRect();
  const z = Math.max(board.view.zoom, 0.9);
  animateView({ x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z, zoom: z });
}

/* ---------------- действия с элементами ---------------- */

async function activate(it) {
  if (!it) return;
  try {
    if (it.type === 'file') {
      await invoke('open_path', { path: it.path });
    } else if (it.type === 'link') {
      await invoke('open_url', { url: it.url });
    } else if (it.type === 'note') {
      editNote(it);
    } else if (it.type === 'frame') {
      renameFrame(it);
    }
  } catch (e) {
    toast(String(e));
    if (it.type === 'file') refreshMissing();
  }
}

async function reveal(it) {
  try { await invoke('reveal_path', { path: it.path }); } catch (e) { toast(String(e)); }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Скопировано');
}

function selectedItems() {
  return board.items.filter((i) => selected.has(i.id));
}

function deleteSelected() {
  if (!selected.size) return;
  snapshot();
  removeItems([...selected]);
  save();
}

async function addFiles(paths, cx, cy) {
  if (!paths.length) return;
  let infos = [];
  try { infos = await invoke('path_info', { paths }); } catch {}
  snapshot();
  const p = toWorld(cx, cy);
  const n = paths.length;
  const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(n * 1.6))));
  const W = 116, H = 120;
  const startX = p.x - (Math.min(cols, n) * W) / 2 + 6;
  const startY = p.y - 50;
  const added = [];
  paths.forEach((path, i) => {
    const it = {
      id: uid(),
      type: 'file',
      path,
      isDir: !!infos[i]?.is_dir,
      x: Math.round(startX + (i % cols) * W),
      y: Math.round(startY + Math.floor(i / cols) * H),
    };
    board.items.push(it);
    syncItem(it);
    added.push(it.id);
  });
  selected = new Set(added);
  refreshSelection();
  updateEmpty();
  save();
}

function addNote(wx, wy, text = '') {
  snapshot();
  const it = { id: uid(), type: 'note', x: Math.round(wx), y: Math.round(wy), w: 200, h: 150, color: NOTE_COLORS[0], text };
  board.items.push(it);
  syncItem(it);
  selected = new Set([it.id]);
  refreshSelection();
  updateEmpty();
  save();
  return it;
}

function addLinkItem(url, title, wx, wy) {
  snapshot();
  const it = { id: uid(), type: 'link', url, title: title || '', x: Math.round(wx), y: Math.round(wy) };
  board.items.push(it);
  syncItem(it);
  selected = new Set([it.id]);
  refreshSelection();
  updateEmpty();
  save();
  return it;
}

async function addLinkDialog(wx, wy, preset = '') {
  const r = await promptDialog({
    title: 'Добавить ссылку',
    fields: [
      { label: 'Адрес сайта', value: preset, placeholder: 'например, youtube.com' },
      { label: 'Название (необязательно)', value: '' },
    ],
  });
  if (!r) return;
  const url = normalizeUrl(r[0]);
  if (!url) return toast('Это не похоже на адрес сайта');
  addLinkItem(url, r[1].trim(), wx, wy);
}

function addFrame(wx, wy, around) {
  snapshot();
  let x = wx, y = wy, w = 480, h = 320;
  if (around && around.length) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of around) {
      const b = itemBounds(it);
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    x = x1 - 24; y = y1 - 34; w = x2 - x1 + 48; h = y2 - y1 + 58;
  }
  const used = new Set(board.items.filter((i) => i.type === 'frame').map((i) => i.color));
  const color = FRAME_COLORS.find((c) => !used.has(c)) || FRAME_COLORS[0];
  const it = { id: uid(), type: 'frame', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), color, title: 'Новая группа' };
  board.items.unshift(it);
  syncItem(it);
  selected = new Set([it.id]);
  refreshSelection();
  updateEmpty();
  save();
  renameFrame(it, true);
}

async function renameFrame(it, fresh) {
  const r = await promptDialog({ title: fresh ? 'Название рамки' : 'Переименовать рамку', fields: [{ label: 'Название', value: it.title }] });
  if (!r) return;
  if (!fresh) snapshot();
  it.title = r[0].trim();
  syncItem(it);
  save();
}

async function renameFile(it) {
  const r = await promptDialog({
    title: 'Подпись карточки',
    text: 'Меняется только подпись на доске — сам файл не переименовывается.',
    fields: [{ label: 'Подпись', value: itemLabel(it) }],
  });
  if (!r) return;
  snapshot();
  const v = r[0].trim();
  it.label = v && v !== baseName(it.path) ? v : '';
  syncItem(it);
  save();
}

async function renameRealFile(it) {
  const name = baseName(it.path);
  const full = it.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const r = await promptDialog({
    title: 'Переименовать файл',
    text: 'Файл переименуется на диске. Карточка на доске останется связанной с ним.',
    fields: [{ label: 'Новое имя', value: full }],
  });
  if (!r || !r[0].trim() || r[0].trim() === full) return;
  try {
    const np = await invoke('rename_path', { path: it.path, newName: r[0] });
    if (it.label === name) it.label = '';
    remapPaths(it.path, np);
    sideRefresh();
  } catch (e) {
    toast(String(e));
  }
}

async function deleteBoardFiles(files) {
  const paths = files.filter((i) => !missing.get(i.path)).map((i) => i.path);
  if (!paths.length) return toast('Файлов уже нет на диске');
  const ids = files.map((i) => i.id);
  if (await deletePaths(paths)) {
    snapshot();
    removeItems(ids);
    save();
  }
}

async function copyBoardFiles(files) {
  const paths = files.filter((i) => !missing.get(i.path)).map((i) => i.path);
  if (!paths.length) return;
  try {
    await invoke('clipboard_set_files', { paths, cut: false });
    toast(paths.length === 1 ? 'Файл скопирован — можно вставить в папку или мессенджер' : `Скопировано файлов: ${paths.length}`);
  } catch (e) {
    toast(String(e));
  }
}

async function editLink(it) {
  const r = await promptDialog({
    title: 'Изменить ссылку',
    fields: [{ label: 'Адрес', value: it.url }, { label: 'Название', value: it.title || '' }],
  });
  if (!r) return;
  const url = normalizeUrl(r[0]);
  if (!url) return toast('Это не похоже на адрес сайта');
  snapshot();
  const changedUrl = url !== it.url;
  it.url = url;
  it.title = r[1].trim();
  if (changedUrl) { els.get(it.id)?.remove(); els.delete(it.id); }
  syncItem(it);
  refreshSelection();
  save();
}

let editingNote = null;
function editNote(it) {
  finishEditing();
  const el = els.get(it.id);
  if (!el) return;
  const t = el.querySelector('.ntext');
  editingNote = { it, before: it.text || '' };
  t.contentEditable = 'plaintext-only';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  t.onblur = finishEditing;
}
function finishEditing() {
  if (!editingNote) return;
  const { it, before } = editingNote;
  editingNote = null;
  const el = els.get(it.id);
  if (!el) return;
  const t = el.querySelector('.ntext');
  t.onblur = null;
  t.contentEditable = 'false';
  t.removeAttribute('contenteditable');
  const text = t.innerText.replace(/\n$/, '');
  if (text !== before) {
    undoStack.push(JSON.stringify(board.items));
    redoStack = [];
    it.text = text;
    save();
  }
  syncItem(it);
}

function setColor(items, color) {
  snapshot();
  for (const it of items) { it.color = color; syncItem(it); }
  save();
}

/* ---------------- проверка, существуют ли файлы ---------------- */

async function refreshMissing() {
  const files = board.items.filter((i) => i.type === 'file');
  if (!files.length) return;
  const paths = [...new Set(files.map((i) => i.path))];
  let infos;
  try { infos = await invoke('path_info', { paths }); } catch { return; }
  let changed = false;
  paths.forEach((p, i) => {
    const m = !infos[i].exists;
    if (!!missing.get(p) !== m) changed = true;
    if (m) missing.set(p, true); else missing.delete(p);
    if (!m && !iconCache.get(p)) iconCache.delete(p);
  });
  for (const it of files) {
    const el = els.get(it.id);
    if (!el) continue;
    el.classList.toggle('missing', !!missing.get(it.path));
    if (!missing.get(it.path) && !iconCache.get(it.path)) {
      loadIcon(it.path).then((url) => { if (url) el.querySelector('img').src = url; });
    }
  }
  if (changed) updateStatus();
}

/* ---------------- перетаскивание наружу ---------------- */

function dragOut(items) {
  const files = items.filter((i) => i.type === 'file' && !missing.get(i.path));
  if (!files.length) return;
  dragOutPaths(files.map((i) => i.path), iconCache.get(files[0].path) || null);
}

async function dragOutPaths(paths, icon) {
  if (!paths.length) return;
  draggingOut = true;
  try {
    await invoke('drag_out', { paths, icon: icon || null });
  } catch (e) {
    toast(String(e));
  } finally {
    setTimeout(() => { draggingOut = false; }, 400);
  }
}

/* ---------------- мышь на доске ---------------- */

boardEl.addEventListener('pointerdown', (e) => {
  hideMenu();
  if (e.target.closest('[contenteditable]')) return;
  if (editingNote) finishEditing();

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    return startPan(e, false);
  }
  if (e.button !== 0) return;

  const resize = e.target.closest('.resize');
  const itemEl = e.target.closest('.item, .frame');
  if (resize && itemEl) return startResize(e, byId(itemEl.dataset.id));

  if (itemEl) {
    const id = itemEl.dataset.id;
    let clickedSelected = selected.has(id);
    if (e.shiftKey || e.ctrlKey) {
      if (clickedSelected) selected.delete(id); else selected.add(id);
      clickedSelected = false;
    } else if (!clickedSelected) {
      selected = new Set([id]);
    }
    refreshSelection();
    if (selected.has(id)) startDragItems(e, id, clickedSelected);
  } else if (e.shiftKey || e.ctrlKey) {
    startMarquee(e);
  } else {
    startPan(e, true);
  }
});

boardEl.addEventListener('pointermove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; });

function startPan(e, clickClears) {
  const sx = e.clientX, sy = e.clientY;
  const vx = board.view.x, vy = board.view.y;
  let moved = false;
  boardEl.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    if (!moved) { moved = true; boardEl.classList.add('panning'); cancelAnimationFrame(anim); }
    board.view.x = vx + ev.clientX - sx;
    board.view.y = vy + ev.clientY - sy;
    applyView();
  };
  const up = () => {
    boardEl.removeEventListener('pointermove', move);
    boardEl.removeEventListener('pointerup', up);
    boardEl.removeEventListener('pointercancel', up);
    boardEl.classList.remove('panning');
    if (moved) save();
    else if (clickClears && selected.size) { selected.clear(); refreshSelection(); }
  };
  boardEl.addEventListener('pointermove', move);
  boardEl.addEventListener('pointerup', up);
  boardEl.addEventListener('pointercancel', up);
}

function startDragItems(e, clickedId, wasSelected) {
  const sx = e.clientX, sy = e.clientY;
  const z = board.view.zoom;
  const base = selectedItems();
  // рамка тянет за собой всё, что внутри неё
  const moving = new Map(base.map((i) => [i.id, i]));
  for (const f of base.filter((i) => i.type === 'frame')) {
    for (const it of board.items) {
      if (moving.has(it.id) || it.type === 'frame') continue;
      const b = itemBounds(it);
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) moving.set(it.id, it);
    }
  }
  const list = [...moving.values()];
  const start = list.map((i) => ({ it: i, x: i.x, y: i.y }));
  const hasFiles = list.some((i) => i.type === 'file');
  let started = false;
  let done = false;

  boardEl.setPointerCapture(e.pointerId);

  const restore = () => { for (const s of start) { s.it.x = s.x; s.it.y = s.y; syncItem(s.it); } };

  const finish = () => {
    done = true;
    boardEl.removeEventListener('pointermove', move);
    boardEl.removeEventListener('pointerup', up);
    boardEl.removeEventListener('pointercancel', up);
    try { boardEl.releasePointerCapture(e.pointerId); } catch {}
  };

  const goOut = () => {
    if (started) { restore(); undoStack.pop(); }
    finish();
    dragOut(base.length ? list : []);
  };

  const move = (ev) => {
    if (done) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!started) {
      if (Math.hypot(dx, dy) < 4) return;
      if (ev.altKey && hasFiles) return goOut();
      started = true;
      snapshot();
      bringToFront(list.map((i) => i.id));
    }
    // ушли за край окна — передаём файлы в систему (Проводник, мессенджер, браузер…)
    const out = ev.clientX <= 1 || ev.clientY <= 1 || ev.clientX >= window.innerWidth - 2 || ev.clientY >= window.innerHeight - 2;
    if (out && hasFiles) return goOut();
    for (const s of start) {
      s.it.x = Math.round(s.x + dx / z);
      s.it.y = Math.round(s.y + dy / z);
      const el = els.get(s.it.id);
      el.style.left = s.it.x + 'px';
      el.style.top = s.it.y + 'px';
    }
  };
  const up = (ev) => {
    finish();
    if (started) save();
    else {
      if (wasSelected && !ev.shiftKey && !ev.ctrlKey && selected.size > 1) {
        selected = new Set([clickedId]);
        refreshSelection();
      }
      // простой клик по файлу/папке — показать его в панели слева
      if (!ev.shiftKey && !ev.ctrlKey) sideReveal(byId(clickedId));
    }
  };
  boardEl.addEventListener('pointermove', move);
  boardEl.addEventListener('pointerup', up);
  boardEl.addEventListener('pointercancel', up);
}

function startResize(e, it) {
  e.stopPropagation();
  const sx = e.clientX, sy = e.clientY;
  const w0 = it.w, h0 = it.h;
  const z = board.view.zoom;
  const min = it.type === 'frame' ? [160, 100] : [100, 60];
  let started = false;
  boardEl.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!started) { started = true; snapshot(); }
    it.w = Math.round(Math.max(min[0], w0 + (ev.clientX - sx) / z));
    it.h = Math.round(Math.max(min[1], h0 + (ev.clientY - sy) / z));
    syncItem(it);
  };
  const up = () => {
    boardEl.removeEventListener('pointermove', move);
    boardEl.removeEventListener('pointerup', up);
    if (started) save();
  };
  boardEl.addEventListener('pointermove', move);
  boardEl.addEventListener('pointerup', up);
}

function startMarquee(e) {
  const r = boardRect();
  const sx = e.clientX, sy = e.clientY;
  const m = $('#marquee');
  const base = new Set(selected);
  boardEl.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY);
    const x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
    Object.assign(m.style, { display: 'block', left: x1 - r.left + 'px', top: y1 - r.top + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
    const a = toWorld(x1, y1), b = toWorld(x2, y2);
    selected = new Set(base);
    for (const it of board.items) {
      const bb = itemBounds(it);
      const inside = it.type === 'frame'
        ? bb.x >= a.x && bb.y >= a.y && bb.x + bb.w <= b.x && bb.y + bb.h <= b.y
        : bb.x < b.x && bb.x + bb.w > a.x && bb.y < b.y && bb.y + bb.h > a.y;
      if (inside) selected.add(it.id);
    }
    refreshSelection();
  };
  const up = () => {
    m.style.display = 'none';
    boardEl.removeEventListener('pointermove', move);
    boardEl.removeEventListener('pointerup', up);
  };
  boardEl.addEventListener('pointermove', move);
  boardEl.addEventListener('pointerup', up);
}

boardEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  hideMenu();
  // тачпад (дробные значения / горизонталь) — двигаем; колесо мыши и щипок — масштаб
  const touchpadPan = !e.ctrlKey && (e.deltaX !== 0 || (e.deltaMode === 0 && Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)));
  if (touchpadPan) {
    board.view.x -= e.deltaX;
    board.view.y -= e.deltaY;
    applyView();
    save();
    return;
  }
  const k = e.ctrlKey ? 0.01 : 0.0018;
  zoomAt(e.clientX, e.clientY, board.view.zoom * Math.exp(-e.deltaY * k));
}, { passive: false });

// элемент под курсором. Берём по координатам, а не e.target: после захвата
// указателя (setPointerCapture) click/dblclick приходят на саму доску
function hitItemEl(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el && boardEl.contains(el) ? el.closest('.item, .frame') : null;
}

boardEl.addEventListener('dblclick', (e) => {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (under?.closest('[contenteditable]')) return;
  const itemEl = hitItemEl(e);
  if (!itemEl) {
    const p = toWorld(e.clientX, e.clientY);
    const it = addNote(p.x - 100, p.y - 30);
    editNote(it);
    return;
  }
  activate(byId(itemEl.dataset.id));
});

boardEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('[contenteditable]')) return;
  const itemEl = e.target.closest('.item, .frame');
  const p = toWorld(e.clientX, e.clientY);
  if (!itemEl) {
    const sel = selectedItems().filter((i) => i.type !== 'frame');
    showMenu(e.clientX, e.clientY, [
      { label: 'Заметка', kbd: 'двойной клик', action: () => editNote(addNote(p.x - 100, p.y - 30)) },
      { label: 'Ссылка на сайт…', action: () => addLinkDialog(p.x - 115, p.y - 25) },
      { label: 'Рамка', action: () => addFrame(p.x - 240, p.y - 160) },
      sel.length ? { label: 'Рамка вокруг выделенного', action: () => addFrame(0, 0, sel) } : null,
      { sep: true },
      { label: 'Показать всё', kbd: 'Ctrl+0', action: fitAll },
      { label: 'Выделить всё', kbd: 'Ctrl+A', action: selectAll },
      { label: 'Отменить', kbd: 'Ctrl+Z', action: undo, disabled: !undoStack.length },
    ]);
    return;
  }
  const id = itemEl.dataset.id;
  if (!selected.has(id)) { selected = new Set([id]); refreshSelection(); }
  const items = selectedItems();
  const it = byId(id);
  const many = items.length > 1;
  const entries = [];
  const files = items.filter((i) => i.type === 'file');

  if (it.type === 'file') {
    entries.push(
      { label: many ? `Открыть (${files.length})` : 'Открыть', kbd: 'Enter', action: () => files.forEach(activate) },
      { label: 'Показать в папке', action: () => reveal(it) },
      { label: 'Открыть с помощью…', action: () => invoke('open_with', { path: it.path }).catch((er) => toast(String(er))), disabled: many },
      { label: 'Показать в панели слева', action: () => { if (!state.ui.side) setSideOpen(true); setTimeout(() => sideReveal(it), 50); } },
      { sep: true },
      { label: 'Копировать файл', kbd: 'Ctrl+C', action: () => copyBoardFiles(files) },
      { label: many ? 'Копировать пути' : 'Копировать путь', action: () => copyText(files.map((i) => i.path).join('\n')) },
      { label: 'Изменить подпись…', kbd: 'F2', action: () => renameFile(it), disabled: many },
      ...(files.some((f) => missing.get(f.path)) ? [] : archiveMenuItems(files.map((f) => ({ path: f.path, isDir: !!f.isDir })))),
      { sep: true },
      { label: 'Переименовать файл…', action: () => renameRealFile(it), disabled: many || !!missing.get(it.path) },
      { label: many ? `Удалить файлы в Корзину… (${files.length})` : 'Удалить файл в Корзину…', danger: true, action: () => deleteBoardFiles(files) },
    );
  } else if (it.type === 'link') {
    entries.push(
      { label: 'Открыть в браузере', kbd: 'Enter', action: () => activate(it) },
      { label: 'Копировать адрес', action: () => copyText(it.url) },
      { label: 'Изменить…', kbd: 'F2', action: () => editLink(it), disabled: many },
    );
  } else if (it.type === 'note') {
    entries.push(
      { label: 'Редактировать', kbd: 'Enter', action: () => editNote(it), disabled: many },
      { label: 'Копировать текст', action: () => copyText(it.text || '') },
      { swatches: NOTE_COLORS, action: (c) => setColor(items.filter((i) => i.type === 'note'), c) },
    );
  } else if (it.type === 'frame') {
    entries.push(
      { label: 'Переименовать…', kbd: 'F2', action: () => renameFrame(it), disabled: many },
      { swatches: FRAME_COLORS, action: (c) => setColor(items.filter((i) => i.type === 'frame'), c) },
    );
  }
  if (many && it.type !== 'frame') {
    const nonFrames = items.filter((i) => i.type !== 'frame');
    entries.push({ label: 'Рамка вокруг выделенного', action: () => addFrame(0, 0, nonFrames) });
  }
  entries.push(
    { sep: true },
    {
      label: it.type === 'frame' && !many ? 'Удалить рамку (содержимое останется)' : many ? `Убрать с доски (${items.length})` : 'Убрать с доски',
      kbd: 'Del',
      danger: true,
      action: deleteSelected,
    },
  );
  showMenu(e.clientX, e.clientY, entries);
});

/* ---------------- контекстное меню ---------------- */

function showMenu(x, y, entries) {
  menuEl.textContent = '';
  for (const en of entries) {
    if (!en) continue;
    if (en.sep) {
      if (menuEl.lastChild && !menuEl.lastChild.classList.contains('msep')) {
        menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'msep' }));
      }
      continue;
    }
    if (en.swatches) {
      const row = document.createElement('div');
      row.className = 'mswatches';
      for (const c of en.swatches) {
        const s = document.createElement('div');
        s.className = 'sw';
        s.style.background = c;
        s.onclick = () => { hideMenu(); en.action(c); };
        row.appendChild(s);
      }
      menuEl.appendChild(row);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'mi' + (en.danger ? ' danger' : '') + (en.disabled ? ' disabled' : '');
    mi.innerHTML = '<span></span><span class="kbd"></span>';
    mi.firstChild.textContent = en.label;
    mi.lastChild.textContent = en.kbd || '';
    mi.onclick = () => { hideMenu(); en.action(); };
    menuEl.appendChild(mi);
  }
  menuEl.classList.add('show');
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
}
function hideMenu() { menuEl.classList.remove('show'); }

document.addEventListener('pointerdown', (e) => { if (!menuEl.contains(e.target)) hideMenu(); });
document.addEventListener('contextmenu', (e) => { if (!isTyping(e.target)) e.preventDefault(); });
window.addEventListener('blur', hideMenu);

/* ---------------- диалоги ---------------- */

function openDialog(build) {
  return new Promise((resolve) => {
    const back = $('#dialogBack');
    const dlg = $('#dialog');
    dlg.textContent = '';
    const close = (v) => {
      back.classList.remove('show');
      back.onpointerdown = null;
      dlg.onkeydown = null;
      resolve(v);
    };
    build(dlg, close);
    back.classList.add('show');
    back.onpointerdown = (e) => { if (e.target === back) close(null); };
    dlg.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    (dlg.querySelector('input') || dlg.querySelector('.primary, .danger'))?.focus();
    dlg.querySelector('input')?.select();
  });
}

function promptDialog({ title, text, fields }) {
  return openDialog((dlg, close) => {
    dlg.appendChild(Object.assign(document.createElement('h3'), { textContent: title }));
    if (text) dlg.appendChild(Object.assign(document.createElement('p'), { textContent: text }));
    const inputs = fields.map((f) => {
      dlg.appendChild(Object.assign(document.createElement('label'), { textContent: f.label }));
      const inp = Object.assign(document.createElement('input'), { value: f.value || '', placeholder: f.placeholder || '', spellcheck: false });
      dlg.appendChild(inp);
      return inp;
    });
    const ok = () => close(inputs.map((i) => i.value));
    inputs.forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); }));
    const btns = document.createElement('div');
    btns.className = 'dbtns';
    btns.append(
      Object.assign(document.createElement('button'), { className: 'dbtn', textContent: 'Отмена', onclick: () => close(null) }),
      Object.assign(document.createElement('button'), { className: 'dbtn primary', textContent: 'Готово', onclick: ok }),
    );
    dlg.appendChild(btns);
  });
}

function confirmDialog(title, text, okLabel) {
  return openDialog((dlg, close) => {
    dlg.appendChild(Object.assign(document.createElement('h3'), { textContent: title }));
    if (text) dlg.appendChild(Object.assign(document.createElement('p'), { textContent: text }));
    const btns = document.createElement('div');
    btns.className = 'dbtns';
    btns.append(
      Object.assign(document.createElement('button'), { className: 'dbtn', textContent: 'Отмена', onclick: () => close(false) }),
      Object.assign(document.createElement('button'), { className: 'dbtn danger', textContent: okLabel, onclick: () => close(true) }),
    );
    dlg.appendChild(btns);
  });
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- поиск ---------------- */

function runSearch() {
  const q = searchEl.value.trim().toLowerCase();
  searchMatches = [];
  searchIndex = -1;
  for (const it of board.items) {
    const el = els.get(it.id);
    if (!el) continue;
    if (!q) { el.classList.remove('dim', 'match'); continue; }
    const hay = (itemLabel(it) + ' ' + (it.path || '') + ' ' + (it.url || '')).toLowerCase();
    const hit = hay.includes(q);
    el.classList.toggle('dim', !hit);
    el.classList.toggle('match', hit && it.type !== 'frame');
    if (hit && it.type !== 'frame') searchMatches.push(it);
  }
  $('#searchCount').textContent = q ? `${searchMatches.length}` : '';
}

searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!searchMatches.length) return;
    searchIndex = (searchIndex + (e.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length;
    const it = searchMatches[searchIndex];
    selected = new Set([it.id]);
    refreshSelection();
    flyTo(it);
    $('#searchCount').textContent = `${searchIndex + 1}/${searchMatches.length}`;
  } else if (e.key === 'Escape') {
    searchEl.value = '';
    runSearch();
    searchEl.blur();
  }
});

/* ---------------- клавиатура ---------------- */

function selectAll() {
  selected = new Set(board.items.map((i) => i.id));
  refreshSelection();
}

document.addEventListener('keydown', (e) => {
  if ($('#dialogBack').classList.contains('show')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.code === 'KeyF') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  if (ctrl && e.code === 'KeyB') { e.preventDefault(); setSideOpen(!state.ui.side); return; }
  if (focusArea === 'side' && state.ui.side && sideKeydown(e)) return;
  if (isTyping(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.code === 'Space') { if (!spaceDown) { spaceDown = true; boardEl.classList.add('space-pan'); } e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') { hideMenu(); selected.clear(); refreshSelection(); return; }
  if (e.key === 'Enter') {
    const items = selectedItems().filter((i) => i.type !== 'frame');
    if (items.length === 1) activate(items[0]);
    else items.filter((i) => i.type === 'file' || i.type === 'link').forEach(activate);
    return;
  }
  if (e.key === 'F2') {
    const it = selectedItems()[0];
    if (!it) return;
    if (it.type === 'file') renameFile(it);
    else if (it.type === 'link') editLink(it);
    else if (it.type === 'note') editNote(it);
    else renameFrame(it);
    e.preventDefault();
    return;
  }
  if (!ctrl) return;
  if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redo(); }
  else if (e.code === 'KeyA') { e.preventDefault(); selectAll(); }
  else if (e.code === 'Digit0' || e.code === 'Numpad0') { e.preventDefault(); fitAll(); }
  else if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); zoomStep(1); }
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomStep(-1); }
  else if (e.code === 'KeyT') { e.preventDefault(); addBoard(); }
  else if (e.code === 'Tab') {
    e.preventDefault();
    const i = state.boards.indexOf(board);
    const n = state.boards.length;
    switchBoard(state.boards[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
  } else if (e.code === 'KeyC' && selected.size) {
    const items = selectedItems();
    const files = items.filter((i) => i.type === 'file');
    if (files.length === items.length) { e.preventDefault(); copyBoardFiles(files); return; }
    const text = items.map((i) => i.path || i.url || i.text || '').filter(Boolean).join('\n');
    if (text) { e.preventDefault(); copyText(text); }
  } else if (e.code === 'KeyR' || e.code === 'KeyP') {
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; boardEl.classList.remove('space-pan'); }
});

/* вставка: ссылка -> карточка ссылки, текст -> заметка */
document.addEventListener('paste', (e) => {
  if (isTyping(e.target) || $('#dialogBack').classList.contains('show')) return;
  const text = (e.clipboardData?.getData('text') || '').trim();
  e.preventDefault();
  const r = boardRect();
  const pt = lastMouse && lastMouse.x >= r.left && lastMouse.y >= r.top && lastMouse.x <= r.right && lastMouse.y <= r.bottom
    ? lastMouse : viewCenterClient();
  pasteOnBoard(text, pt);
});

async function pasteOnBoard(text, pt) {
  // файлы, скопированные в Проводнике (Ctrl+C), — кладём карточками
  try {
    const clip = await invoke('clipboard_get_files');
    if (clip.paths.length) return addFiles(clip.paths, pt.x, pt.y);
  } catch {}
  if (!text) return;
  const p = toWorld(pt.x, pt.y);

  // пути к файлам (например, «Копировать как путь» в Проводнике)
  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (lines.every((l) => /^[a-zA-Z]:[\\/]|^\\\\/.test(l))) {
    addFiles(lines, pt.x, pt.y);
    return;
  }
  const url = !/\s/.test(text) ? normalizeUrl(text) : '';
  if (url) addLinkItem(url, '', p.x - 115, p.y - 25);
  else addNote(p.x - 100, p.y - 30, text);
}

/* ---------------- перетаскивание из Проводника ---------------- */

function setupDrop() {
  if (!TAURI) return;
  TAURI.webview.getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    const dpr = window.devicePixelRatio || 1;
    const px = p.position ? p.position.x / dpr : 0;
    const py = p.position ? p.position.y / dpr : 0;
    if (p.type === 'enter' || p.type === 'over') {
      if (draggingOut) return;
      // над панелью слева — копировать в папку, над доской — положить карточки
      const overSide = sideDragOver(px, py);
      boardEl.classList.toggle('dropping', !overSide);
    } else if (p.type === 'leave') {
      boardEl.classList.remove('dropping');
      sideDragClear();
    } else if (p.type === 'drop') {
      boardEl.classList.remove('dropping');
      if (draggingOut || !p.paths?.length) { sideDragClear(); return; }
      if (sideDragOver(px, py)) {
        sideExternalDrop(p.paths, px, py);
        return;
      }
      const r = boardRect();
      addFiles(p.paths, clamp(px, r.left + 20, r.right - 20), clamp(py, r.top + 20, r.bottom - 20));
    }
  });

  const win = TAURI.window.getCurrentWindow();
  win.onFocusChanged(({ payload }) => {
    if (!payload) return;
    refreshMissing();
    if (state.ui.side && side.path !== undefined) sideRefresh();
  });
  win.onCloseRequested(async () => { finishEditing(); await flushSave(); });
}

/* ---------------- кнопки ---------------- */

$('#addBoard').onclick = addBoard;
$('#zoomIn').onclick = () => zoomStep(1);
$('#zoomOut').onclick = () => zoomStep(-1);
$('#zoomVal').onclick = () => { const c = viewCenterClient(); animateViewToZoom(c, 1); };
$('#fit').onclick = fitAll;

function animateViewToZoom(c, z) {
  const r = boardRect();
  const p = toWorld(c.x, c.y);
  animateView({ x: c.x - r.left - p.x * z, y: c.y - r.top - p.y * z, zoom: z });
}

/* ---------------- запуск ---------------- */

async function init() {
  let raw = '';
  try { raw = await invoke('load_data'); } catch {}
  try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
  if (!state || !Array.isArray(state.boards) || !state.boards.length) state = defaultState();
  for (const b of state.boards) {
    b.view ||= { x: 60, y: 40, zoom: 1 };
    b.items ||= [];
  }
  state.ui ||= {};
  switchBoard(state.active);
  initSide();
  setupDrop();
}
// init() вызывается в конце side.js, когда загружены обе части
