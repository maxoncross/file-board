'use strict';

/* =========================================================
   Панель-проводник слева: просмотр папок, перетаскивание на доску,
   копирование / перемещение / переименование / удаление в Корзину
   ========================================================= */

const sideEl = $('#side');
const sideListEl = $('#sideList');
const crumbsEl = $('#crumbs');
const sideFilterEl = $('#sideFilter');
const placesEl = $('#places');
const sideFootEl = $('#sideFoot');
const ghostEl = $('#ghost');
const splitterEl = $('#splitter');

// у этих типов у каждого файла своя иконка; у остальных — общая на расширение
const PER_FILE_ICON = /\.(exe|lnk|ico|url|msi|scr|cpl|appref-ms|cur|ani)$/i;

const side = {
  path: '',
  entries: [],
  view: [],
  rows: new Map(),   // путь (нижний регистр) -> строка
  sel: new Set(),    // выделенные пути (нижний регистр)
  anchor: null,
  back: [],
  fwd: [],
  places: [],
  error: '',
  cut: new Set(),
  loadSeq: 0,
};
let focusArea = 'board';

const lc = (s) => (s || '').toLowerCase();
const trimSlash = (p) => p.replace(/[\\/]+$/, '');

function fmtSize(n) {
  if (n < 1024) return n + ' Б';
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? Math.round(n) : n.toFixed(1).replace('.', ',')) + ' ' + u[i];
}

function fmtDate(ms) {
  return ms ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function parentOf(p) {
  if (!p) return '';
  const t = trimSlash(p);
  if (/^[a-zA-Z]:$/.test(t)) return '';
  if (/^\\\\[^\\]+\\[^\\]+$/.test(t)) return '';
  const i = t.lastIndexOf('\\');
  if (i < 0) return '';
  const par = t.slice(0, i);
  return /^[a-zA-Z]:$/.test(par) ? par + '\\' : par;
}

const joinPath = (dir, name) => (dir.endsWith('\\') ? dir + name : dir + '\\' + name);

function nameOf(p) {
  const t = trimSlash(p);
  return /^[a-zA-Z]:$/.test(t) ? t : t.split('\\').pop();
}

const samePath = (a, b) => lc(trimSlash(a)) === lc(trimSlash(b));

function boardPathSet() {
  return new Set(board.items.filter((i) => i.type === 'file').map((i) => lc(i.path)));
}

/* ---------------- иконки (лениво, только для видимых строк) ---------------- */

const sideIconCache = new Map();
const sideIconUrl = new Map();

const isGrid = () => state.ui.sideView === 'grid';
const THUMB_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|avif|ico|svg|mp4|mkv|mov|avi|webm|wmv|pdf)$/i;

// в режиме значков — крупнее, а у картинок и видео превью вместо иконки
function sideIconKey(e) {
  const g = isGrid() ? 'G' : 'L';
  if (e.is_dir) return g + 'p:' + lc(e.path);
  if (g === 'G' && THUMB_EXT.test(e.name)) return 'Gt:' + lc(e.path) + ':' + e.modified;
  const m = /\.([^.\\]+)$/.exec(e.name);
  if (!m || PER_FILE_ICON.test(e.name)) return g + 'p:' + lc(e.path);
  return g + 'x:' + lc(m[1]);
}

function sideIcon(e) {
  const k = sideIconKey(e);
  if (!sideIconCache.has(k)) {
    const grid = k[0] === 'G';
    const thumb = k.startsWith('Gt:');
    sideIconCache.set(k, invoke('get_icon', { path: e.path, size: grid ? 96 : 32, iconOnly: !thumb })
      .then((url) => { sideIconUrl.set(k, url); return url; })
      .catch(() => null));
  }
  return sideIconCache.get(k);
}

const iconObserver = new IntersectionObserver((list) => {
  for (const en of list) {
    if (!en.isIntersecting) continue;
    const row = en.target;
    iconObserver.unobserve(row);
    sideIcon(row._entry).then((url) => {
      if (!url) return;
      row.firstChild.src = url;
      if (sideIconKey(row._entry).startsWith('Gt:')) row.firstChild.classList.add('thumb');
    });
  }
}, { root: sideListEl, rootMargin: '300px' });

/* ---------------- загрузка и навигация ---------------- */

async function loadPlaces() {
  try { side.places = await invoke('places'); } catch { side.places = []; }
  renderPlaces();
}

function sortEntries(list) {
  // как в Проводнике: цифры, латиница, потом кириллица; file2 < file10
  const coll = new Intl.Collator(['en', 'ru'], { numeric: true, sensitivity: 'base' });
  return list.sort((a, b) => (b.is_dir - a.is_dir) || coll.compare(a.name, b.name));
}

async function sideLoad(path) {
  const seq = ++side.loadSeq;
  let entries = [];
  let error = '';
  if (path === '') {
    if (!side.places.length) await loadPlaces();
    entries = side.places
      .filter((p) => /^[a-zA-Z]:\\$/.test(p.path))
      .map((p) => ({ name: p.name, path: p.path, is_dir: true, size: 0, modified: 0, drive: true }));
  } else {
    try {
      entries = sortEntries(await invoke('list_dir', { path, showHidden: !!state.ui.showHidden }));
    } catch (err) {
      error = String(err);
    }
  }
  if (seq !== side.loadSeq) return false;
  side.path = path;
  side.entries = entries;
  side.error = error;
  return true;
}

async function sideNavigate(path, opts = {}) {
  const changed = !samePath(path, side.path) || (path === '') !== (side.path === '');
  if (opts.push !== false && changed) {
    side.back.push(side.path);
    if (side.back.length > 60) side.back.shift();
    side.fwd = [];
  }
  if (changed) sideFilterEl.value = '';
  const select = opts.select ? [].concat(opts.select).map(lc) : [];
  if (!(await sideLoad(path))) return;
  side.sel = new Set(select);
  side.anchor = select[0] || null;
  state.ui.sidePath = path;
  save();
  renderSide();
  if (select.length) scrollToRow(select[0], 'center');
  else if (changed) sideListEl.scrollTop = 0;
}

async function sideRefresh() {
  const sel = [...side.sel];
  const st = sideListEl.scrollTop;
  if (!(await sideLoad(side.path))) return;
  const exist = new Set(side.entries.map((e) => lc(e.path)));
  side.sel = new Set(sel.filter((s) => exist.has(s)));
  renderSide();
  sideListEl.scrollTop = st;
}

function sideBack() {
  if (!side.back.length) return;
  side.fwd.push(side.path);
  sideNavigate(side.back.pop(), { push: false });
}
function sideForward() {
  if (!side.fwd.length) return;
  side.back.push(side.path);
  sideNavigate(side.fwd.pop(), { push: false });
}
function sideUp() {
  if (side.path === '') return;
  sideNavigate(parentOf(side.path), { select: side.path });
}

/* Клик по карточке на доске — показать её в панели */
function sideReveal(it) {
  if (!state.ui.side || !it || it.type !== 'file' || missing.get(it.path)) return;
  if (it.isDir) {
    if (!samePath(it.path, side.path)) sideNavigate(it.path);
  } else {
    const par = parentOf(it.path);
    if (samePath(par, side.path) && side.rows.has(lc(it.path))) {
      side.sel = new Set([lc(it.path)]);
      side.anchor = lc(it.path);
      updateSideSel();
      scrollToRow(lc(it.path), 'nearest');
    } else {
      sideNavigate(par, { select: it.path });
    }
  }
}

/* ---------------- отрисовка ---------------- */

function renderPlaces() {
  placesEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'places-head';
  head.innerHTML = '<span>Быстрый доступ</span><span class="chev"></span>';
  head.onclick = () => { state.ui.placesOpen = !state.ui.placesOpen; placesEl.classList.toggle('closed', !state.ui.placesOpen); save(); };
  placesEl.appendChild(head);
  placesEl.classList.toggle('closed', !state.ui.placesOpen);
  const list = document.createElement('div');
  list.className = 'places-list';
  const pcRow = { name: 'Этот компьютер', path: '', kind: 'pc' };
  for (const p of [pcRow, ...side.places]) {
    const d = document.createElement('div');
    d.className = 'place';
    d.dataset.path = p.path;
    d.innerHTML = '<img alt=""><span></span>';
    d.firstChild.src = p.kind === 'pc' ? PC_SVG : FOLDER_SVG;
    d.lastChild.textContent = p.name;
    d.title = p.path || 'Все диски';
    if (p.path) {
      invoke('get_icon', { path: p.path, size: 32, iconOnly: true }).then((u) => { if (u) d.firstChild.src = u; }).catch(() => {});
    }
    d.onclick = () => { focusArea = 'side'; sideNavigate(p.path); };
    d.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!p.path) return;
      showMenu(e.clientX, e.clientY, [
        { label: 'Открыть здесь', action: () => sideNavigate(p.path) },
        { label: 'Открыть в Проводнике', action: () => invoke('open_path', { path: p.path }).catch((er) => toast(String(er))) },
        { label: 'Положить на доску', action: () => putOnBoard([p.path]) },
      ]);
    };
    list.appendChild(d);
  }
  placesEl.appendChild(list);
  updateActivePlace();
}

function updateActivePlace() {
  for (const d of placesEl.querySelectorAll('.place')) {
    d.classList.toggle('active', d.dataset.path === '' ? side.path === '' : side.path !== '' && samePath(d.dataset.path, side.path));
  }
}

function crumbsOf(path) {
  const out = [{ label: 'Этот компьютер', path: '' }];
  if (!path) return out;
  let acc;
  let parts;
  if (path.startsWith('\\\\')) {
    const m = path.slice(2).split('\\').filter(Boolean);
    acc = '\\\\' + m.slice(0, 2).join('\\');
    out.push({ label: acc, path: acc });
    parts = m.slice(2);
  } else {
    const m = path.split('\\').filter(Boolean);
    acc = m[0] + '\\';
    const drive = side.places.find((p) => samePath(p.path, acc));
    out.push({ label: drive ? drive.name : m[0], path: acc });
    parts = m.slice(1);
  }
  for (const p of parts) {
    acc = joinPath(acc, p);
    out.push({ label: p, path: acc });
  }
  return out;
}

function renderCrumbs() {
  crumbsEl.textContent = '';
  crumbsEl.classList.remove('editing');
  const cs = crumbsOf(side.path);
  cs.forEach((c, i) => {
    if (i > 0) crumbsEl.appendChild(Object.assign(document.createElement('span'), { className: 'csep', textContent: '›' }));
    const b = document.createElement('span');
    b.className = 'crumb' + (i === cs.length - 1 ? ' last' : '');
    b.textContent = c.label;
    b.dataset.path = c.path;
    b.title = c.path || 'Все диски';
    b.onclick = (e) => { e.stopPropagation(); sideNavigate(c.path); };
    crumbsEl.appendChild(b);
  });
  crumbsEl.scrollLeft = crumbsEl.scrollWidth;
  $('#sBack').disabled = !side.back.length;
  $('#sFwd').disabled = !side.fwd.length;
  $('#sUp').disabled = side.path === '';
  updateActivePlace();
}

/* клик по пустому месту строки пути — можно вписать путь вручную */
crumbsEl.addEventListener('click', () => {
  if (crumbsEl.classList.contains('editing')) return;
  crumbsEl.classList.add('editing');
  crumbsEl.textContent = '';
  const inp = Object.assign(document.createElement('input'), { value: side.path, spellcheck: false, placeholder: 'Вставьте путь к папке' });
  crumbsEl.appendChild(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (go) => {
    if (done) return;
    done = true;
    const v = inp.value.trim().replace(/^"(.*)"$/, '$1');
    if (go && v && !samePath(v, side.path)) {
      let info = null;
      try { info = (await invoke('path_info', { paths: [v] }))[0]; } catch {}
      if (info?.exists && !info.is_dir) return sideNavigate(parentOf(v), { select: v });
      if (info?.exists) return sideNavigate(/^[a-zA-Z]:$/.test(v) ? v + '\\' : v);
      toast('Путь не найден');
    }
    renderCrumbs();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(false));
});

function renderSide() {
  renderCrumbs();
  const q = lc(sideFilterEl.value.trim());
  side.view = q ? side.entries.filter((e) => lc(e.name).includes(q)) : side.entries;
  sideListEl.textContent = '';
  sideListEl.classList.toggle('grid', isGrid());
  updateViewButton();
  $('#sPin').disabled = !side.path;
  side.rows.clear();
  iconObserver.disconnect();

  if (side.error || !side.view.length) {
    const msg = document.createElement('div');
    msg.className = 'side-msg';
    msg.textContent = side.error || (q ? 'Ничего не найдено' : 'Папка пуста');
    if (side.error && side.path) {
      const up = Object.assign(document.createElement('button'), { className: 'dbtn', textContent: 'Вверх' });
      up.onclick = sideUp;
      msg.appendChild(document.createElement('br'));
      msg.appendChild(up);
    }
    sideListEl.appendChild(msg);
    updateSideFoot();
    return;
  }

  const onBoard = boardPathSet();
  const frag = document.createDocumentFragment();
  for (const e of side.view) {
    const key = lc(e.path);
    const row = document.createElement('div');
    row.className = 'row'
      + (side.sel.has(key) ? ' sel' : '')
      + (side.cut.has(key) ? ' cut' : '')
      + (onBoard.has(key) ? ' onboard' : '')
      + (e.hidden ? ' hid' : '');
    row.dataset.path = e.path;
    row._entry = e;
    row.innerHTML = '<img class="ri" alt=""><span class="rn"></span><span class="rdot" title="Уже есть на доске"></span><span class="rm"></span>';
    const key2 = sideIconKey(e);
    row.firstChild.src = sideIconUrl.get(key2) || (e.drive ? DRIVE_SVG : e.is_dir ? FOLDER_SVG : FILE_SVG);
    if (key2.startsWith('Gt:') && sideIconUrl.get(key2)) row.firstChild.classList.add('thumb');
    // как в Проводнике: у ярлыков окончание .lnk / .url не показываем
    row.children[1].textContent = e.is_dir ? e.name : e.name.replace(/\.(lnk|url)$/i, '');
    row.children[3].textContent = e.is_dir ? '' : fmtSize(e.size);
    row.title = e.name + (e.modified ? '\nИзменён: ' + fmtDate(e.modified) : '') + (e.is_dir ? '' : '\nРазмер: ' + fmtSize(e.size));
    side.rows.set(key, row);
    frag.appendChild(row);
  }
  sideListEl.appendChild(frag);
  for (const row of side.rows.values()) {
    if (!sideIconUrl.has(sideIconKey(row._entry))) iconObserver.observe(row);
  }
  updateSideFoot();
}

function updateSideSel() {
  for (const [k, row] of side.rows) row.classList.toggle('sel', side.sel.has(k));
  updateSideFoot();
}

function sideMarkOnBoard() {
  if (!side.rows.size) return;
  const set = boardPathSet();
  for (const [k, row] of side.rows) row.classList.toggle('onboard', set.has(k));
}

function updateSideFoot() {
  const n = side.view.length;
  let t = side.error ? '' : `Объектов: ${n}`;
  const sel = selectedSideEntries();
  if (sel.length) {
    t += ` · выбрано ${sel.length}`;
    const files = sel.filter((e) => !e.is_dir);
    if (files.length) t += ` (${fmtSize(files.reduce((s, e) => s + e.size, 0))})`;
  }
  sideFootEl.textContent = t;
}

function scrollToRow(key, block = 'nearest') {
  const row = side.rows.get(lc(key));
  if (row) row.scrollIntoView({ block });
}

function selectedSideEntries() {
  return side.view.filter((e) => side.sel.has(lc(e.path)));
}

/* ---------------- действия ---------------- */

function putOnBoard(paths) {
  if (!paths.length) return;
  const c = viewCenterClient();
  addFiles(paths, c.x, c.y);
  toast(paths.length === 1 ? 'Положено на доску' : `Положено на доску: ${paths.length}`);
}

function sideOpen(entries) {
  if (!entries.length) return;
  if (entries.length === 1 && entries[0].is_dir) return sideNavigate(entries[0].path);
  for (const e of entries) {
    if (!e.is_dir) invoke('open_path', { path: e.path }).catch((er) => toast(String(er)));
  }
}

/* карточки на доске следуют за переименованными / перемещёнными файлами */
function remapPaths(oldPath, newPath) {
  const o = lc(trimSlash(oldPath));
  let touched = false;
  for (const b of state.boards) {
    for (const it of b.items) {
      if (it.type !== 'file') continue;
      const p = lc(it.path);
      if (p === o) {
        it.path = newPath;
        touched = true;
      } else if (p.startsWith(o + '\\')) {
        it.path = trimSlash(newPath) + it.path.slice(o.length);
        touched = true;
      }
    }
  }
  if (touched) {
    renderAll();
    save();
  }
  for (const s of [side.back, side.fwd]) {
    for (let i = 0; i < s.length; i++) {
      const p = lc(s[i]);
      if (p === o || p.startsWith(o + '\\')) s[i] = trimSlash(newPath) + s[i].slice(o.length);
    }
  }
}

async function transferTo(paths, dest, mode) {
  if (!dest) { toast('Сюда нельзя положить файлы — откройте папку'); return false; }
  const d = lc(trimSlash(dest));
  if (paths.some((p) => d === lc(trimSlash(p)) || d.startsWith(lc(trimSlash(p)) + '\\'))) {
    toast('Нельзя поместить папку внутрь самой себя');
    return false;
  }
  if (mode === 'move') {
    paths = paths.filter((p) => lc(trimSlash(parentOf(p))) !== d);
    if (!paths.length) return false;
  }
  let ok = false;
  try {
    ok = await invoke('file_op', { op: mode, paths, dest });
  } catch (err) {
    toast(String(err));
  }
  if (mode === 'move') {
    const targets = paths.map((p) => joinPath(dest, nameOf(p)));
    try {
      const [olds, news] = await Promise.all([
        invoke('path_info', { paths }),
        invoke('path_info', { paths: targets }),
      ]);
      paths.forEach((p, i) => { if (!olds[i].exists && news[i].exists) remapPaths(p, targets[i]); });
    } catch {}
  }
  await sideRefresh();
  refreshMissing();
  return ok;
}

async function sideCopy(cut) {
  const sel = selectedSideEntries().filter((e) => !e.drive);
  if (!sel.length) return;
  try {
    await invoke('clipboard_set_files', { paths: sel.map((e) => e.path), cut });
  } catch (err) {
    return toast(String(err));
  }
  side.cut = cut ? new Set(sel.map((e) => lc(e.path))) : new Set();
  for (const [k, row] of side.rows) row.classList.toggle('cut', side.cut.has(k));
  toast(cut ? `Вырезано: ${sel.length} — откройте нужную папку и нажмите Ctrl+V` : `Скопировано: ${sel.length}`);
}

async function sidePaste(destOverride) {
  const dest = destOverride || side.path;
  if (!dest) return toast('Откройте папку, чтобы вставить');
  let clip;
  try { clip = await invoke('clipboard_get_files'); } catch (err) { return toast(String(err)); }
  if (!clip.paths.length) return toast('В буфере обмена нет файлов');
  const before = new Set(side.entries.map((e) => lc(e.path)));
  await transferTo(clip.paths, dest, clip.cut ? 'move' : 'copy');
  if (clip.cut) {
    invoke('clipboard_clear').catch(() => {});
    side.cut.clear();
    for (const row of side.rows.values()) row.classList.remove('cut');
  }
  if (samePath(dest, side.path)) {
    const fresh = side.entries.filter((e) => !before.has(lc(e.path))).map((e) => lc(e.path));
    if (fresh.length) {
      side.sel = new Set(fresh);
      updateSideSel();
      scrollToRow(fresh[0]);
    }
  }
}

async function deletePaths(paths) {
  paths = paths.filter((p) => !/^[a-zA-Z]:\\?$/.test(p));
  if (!paths.length) return false;
  let infos = [];
  try { infos = await invoke('path_info', { paths }); } catch {}
  const dirs = infos.filter((i) => i.is_dir).length;
  let title, text;
  if (paths.length === 1) {
    title = `Удалить ${dirs ? 'папку' : 'файл'} «${nameOf(paths[0])}»?`;
    text = dirs
      ? 'Папка вместе со всем содержимым будет перемещена в Корзину. При необходимости её можно восстановить оттуда.'
      : 'Файл будет перемещён в Корзину. При необходимости его можно восстановить оттуда.';
  } else {
    title = `Удалить выбранные объекты (${paths.length})?`;
    text = 'Они будут перемещены в Корзину' + (dirs ? ', папки — вместе со всем содержимым' : '')
      + '. При необходимости их можно восстановить оттуда.';
  }
  const ok = await confirmDialog(title, text, 'Удалить в Корзину');
  if (!ok) return false;
  let done = false;
  try {
    done = await invoke('file_op', { op: 'delete', paths });
  } catch (err) {
    toast(String(err));
  }
  await sideRefresh();
  await refreshMissing();
  if (done) toast(paths.length === 1 ? 'Перемещено в Корзину' : `Перемещено в Корзину: ${paths.length}`);
  return done;
}

function sideRename(path) {
  const row = side.rows.get(lc(path));
  if (!row) return;
  const e = row._entry;
  if (e.drive) return;
  const span = row.children[1];
  const inp = Object.assign(document.createElement('input'), { className: 'rename', value: e.name, spellcheck: false });
  span.replaceWith(inp);
  inp.focus();
  const dot = e.is_dir ? -1 : e.name.lastIndexOf('.');
  inp.setSelectionRange(0, dot > 0 ? dot : e.name.length);
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    if (!commit || !v || v === e.name) {
      inp.replaceWith(span);
      return;
    }
    try {
      const np = await invoke('rename_path', { path: e.path, newName: v });
      remapPaths(e.path, np);
      await sideRefresh();
      side.sel = new Set([lc(np)]);
      side.anchor = lc(np);
      updateSideSel();
      scrollToRow(np);
    } catch (err) {
      toast(String(err));
      inp.replaceWith(span);
    }
  };
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
}

async function sideNewFolder() {
  if (!side.path) return toast('Откройте папку');
  try {
    const p = await invoke('create_folder', { parent: side.path });
    sideFilterEl.value = '';
    await sideRefresh();
    side.sel = new Set([lc(p)]);
    side.anchor = lc(p);
    updateSideSel();
    scrollToRow(p);
    sideRename(p);
  } catch (err) {
    toast(String(err));
  }
}

function setSideView(mode) {
  state.ui.sideView = mode;
  save();
  const st = sideListEl.scrollTop;
  renderSide();
  if (side.anchor) scrollToRow(side.anchor, 'center');
  else sideListEl.scrollTop = st;
}

function updateViewButton() {
  const b = $('#sView');
  const grid = isGrid();
  b.title = grid ? 'Показать списком' : 'Показать крупными значками';
  b.innerHTML = grid
    ? '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
}

function setShowHidden(v) {
  state.ui.showHidden = v;
  save();
  sideRefresh();
}

/* ---------------- мышь в списке ---------------- */

function hitRow(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el ? el.closest('#sideList .row') : null;
}

sideEl.addEventListener('pointerdown', () => {
  focusArea = 'side';
  document.body.classList.add('side-focus');
}, true);
boardEl.addEventListener('pointerdown', () => {
  focusArea = 'board';
  document.body.classList.remove('side-focus');
}, true);

sideListEl.addEventListener('pointerdown', (e) => {
  if (e.button === 3) { e.preventDefault(); return sideBack(); }
  if (e.button === 4) { e.preventDefault(); return sideForward(); }
  if (e.button !== 0 || e.target.closest('input, button')) return;
  const row = e.target.closest('.row');
  if (!row) {
    if (!e.ctrlKey && !e.shiftKey && side.sel.size) { side.sel.clear(); updateSideSel(); }
    return;
  }
  const key = lc(row.dataset.path);
  let wasSel = side.sel.has(key);
  if (e.shiftKey && side.anchor) {
    const a = side.view.findIndex((x) => lc(x.path) === side.anchor);
    const b = side.view.findIndex((x) => lc(x.path) === key);
    if (!e.ctrlKey) side.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 0) side.sel.add(lc(side.view[i].path));
    wasSel = false;
  } else if (e.ctrlKey) {
    if (wasSel) side.sel.delete(key); else side.sel.add(key);
    side.anchor = key;
    wasSel = false;
  } else {
    if (!wasSel) side.sel = new Set([key]);
    side.anchor = key;
  }
  updateSideSel();
  if (side.sel.has(key)) startSideDrag(e, row, wasSel);
});

sideListEl.addEventListener('dblclick', (e) => {
  const row = hitRow(e);
  if (row) sideOpen([row._entry]);
});

sideEl.addEventListener('mouseup', (e) => {
  if (e.button === 3) sideBack();
  else if (e.button === 4) sideForward();
});

/* перетаскивание из панели: на доску, в папку, или за окно — в другую программу */
function startSideDrag(e, row, wasSel) {
  const sx = e.clientX, sy = e.clientY;
  const entries = selectedSideEntries();
  if (!entries.length) return;
  const paths = entries.map((x) => x.path);
  let started = false;
  let done = false;
  let target = null;
  sideListEl.setPointerCapture(e.pointerId);

  const setTarget = (t) => {
    if (target?.el) target.el.classList.remove('drop-into');
    boardEl.classList.toggle('dropping', t?.kind === 'board');
    if (t?.el) t.el.classList.add('drop-into');
    target = t;
  };

  const cleanup = () => {
    done = true;
    sideListEl.removeEventListener('pointermove', move);
    sideListEl.removeEventListener('pointerup', up);
    sideListEl.removeEventListener('pointercancel', cancel);
    try { sideListEl.releasePointerCapture(e.pointerId); } catch {}
    ghostEl.style.display = 'none';
    setTarget(null);
  };

  const resolve = (ev) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!under) return null;
    if (boardEl.contains(under)) return { kind: 'board' };
    const r = under.closest('#sideList .row');
    if (r && r._entry.is_dir && !side.sel.has(lc(r.dataset.path))) return { kind: 'folder', path: r._entry.path, el: r };
    const pl = under.closest('.place, .crumb');
    if (pl && pl.dataset.path && !samePath(pl.dataset.path, side.path)) return { kind: 'folder', path: pl.dataset.path, el: pl };
    return null;
  };

  const move = (ev) => {
    if (done) return;
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = true;
      const img = row.firstChild.src;
      ghostEl.innerHTML = '<img alt=""><span></span>';
      ghostEl.firstChild.src = img;
      ghostEl.lastChild.textContent = entries.length === 1 ? entries[0].name : `${entries.length} объект(ов)`;
      ghostEl.style.display = 'flex';
    }
    const out = ev.clientX <= 1 || ev.clientY <= 1 || ev.clientX >= window.innerWidth - 2 || ev.clientY >= window.innerHeight - 2;
    if (out) {
      cleanup();
      const icon = row.firstChild.src.startsWith('data:image/png') ? row.firstChild.src : null;
      dragOutPaths(paths.filter((p) => !/^[a-zA-Z]:\\$/.test(p)), icon);
      return;
    }
    ghostEl.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`;
    ghostEl.classList.toggle('copy', ev.ctrlKey);
    setTarget(resolve(ev));
  };

  const up = (ev) => {
    const t = target;
    cleanup();
    if (!started) {
      if (wasSel && !ev.ctrlKey && !ev.shiftKey && side.sel.size > 1) {
        side.sel = new Set([lc(row.dataset.path)]);
        updateSideSel();
      }
      return;
    }
    if (!t) return;
    if (t.kind === 'board') addFiles(paths, ev.clientX, ev.clientY);
    else if (t.kind === 'folder' && !entries.some((x) => x.drive)) transferTo(paths, t.path, ev.ctrlKey ? 'copy' : 'move');
  };
  const cancel = () => cleanup();

  sideListEl.addEventListener('pointermove', move);
  sideListEl.addEventListener('pointerup', up);
  sideListEl.addEventListener('pointercancel', cancel);
}

/* ---------------- контекстное меню панели ---------------- */

function sideMenuEmpty(x, y) {
  const has = !!side.path;
  showMenu(x, y, [
    { label: 'Вставить', kbd: 'Ctrl+V', action: () => sidePaste(), disabled: !has },
    { label: 'Новая папка', kbd: 'Ctrl+Shift+N', action: sideNewFolder, disabled: !has },
    { label: 'Обновить', kbd: 'F5', action: sideRefresh },
    { sep: true },
    { label: 'Положить эту папку на доску', action: () => putOnBoard([side.path]), disabled: !has },
    { label: 'Открыть в Проводнике', action: () => invoke('open_path', { path: side.path }).catch((er) => toast(String(er))), disabled: !has },
    { label: 'Копировать путь', action: () => copyText(side.path), disabled: !has },
    { sep: true },
    { label: (isGrid() ? '' : '✓ ') + 'Вид: список', action: () => setSideView('list') },
    { label: (isGrid() ? '✓ ' : '') + 'Вид: крупные значки', action: () => setSideView('grid') },
    { label: (state.ui.showHidden ? '✓ ' : '') + 'Показывать скрытые файлы', action: () => setShowHidden(!state.ui.showHidden) },
  ]);
}

/* ---------------- архивы (WinRAR, без него — встроенный в Windows tar) ---------------- */

const ARCHIVE_RE = /\.(rar|zip|7z|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|cab|iso|arj|lzh|lz|001)$/i;
let archiver = null; // { winrar: путь | null }
let archiveBusy = false;

async function loadArchiver() {
  try { archiver = await invoke('archiver_info'); } catch { archiver = { winrar: null }; }
}

function isArchive(path) { return ARCHIVE_RE.test(path); }

function archiveStem(path) {
  let n = baseName(path);
  const m = n.match(/^(.*?)(\.part\d+)?\.(tar\.(gz|bz2|xz|zst)|[^.]+)$/i);
  return (m && m[1]) || n;
}

/* entries: [{ path, isDir }] — общие пункты меню для панели и для доски */
function archiveMenuItems(entries) {
  if (!entries.length || entries.some((e) => !e.path || /^[a-z]:\\?$/i.test(e.path))) return [];
  const out = [{ sep: true }];
  const paths = entries.map((e) => e.path);
  const arcs = entries.filter((e) => !e.isDir && isArchive(e.path));
  if (arcs.length === entries.length) {
    const one = arcs.length === 1;
    out.push(
      { label: one ? `Распаковать в «${archiveStem(arcs[0].path)}\\»` : `Распаковать каждый в свою папку (${arcs.length})`, action: () => unpackArchives(arcs.map((a) => a.path), true) },
      { label: 'Распаковать сюда', action: () => unpackArchives(arcs.map((a) => a.path), false) },
    );
  }
  const par = parentOf(paths[0]);
  if (arcs.length < entries.length && paths.every((p) => samePath(parentOf(p), par))) {
    let stem;
    if (entries.length > 1) stem = baseName(par) || 'Архив';
    else stem = entries[0].isDir ? baseName(paths[0]) : baseName(paths[0]).replace(/\.[^.]*$/, '') || baseName(paths[0]);
    if (archiver?.winrar) out.push({ label: `Добавить в архив «${stem}.rar»`, action: () => packArchive(paths, 'rar') });
    out.push({ label: `Добавить в архив «${stem}.zip»`, action: () => packArchive(paths, 'zip') });
  }
  return out.length > 1 ? out : [];
}

async function afterArchive(dir, select) {
  if (samePath(dir, side.path)) {
    sideFilterEl.value = '';
    await sideRefresh();
    if (select) {
      side.sel = new Set([lc(select)]);
      side.anchor = lc(select);
      updateSideSel();
      scrollToRow(lc(select), 'center');
    }
  }
}

async function packArchive(paths, format) {
  if (archiveBusy) return toast('Подождите, архиватор ещё работает');
  archiveBusy = true;
  toast('Упаковка…');
  try {
    const out = await invoke('archive_pack', { paths, format });
    if (out) {
      toast(`Готово: ${baseName(out)}`);
      await afterArchive(parentOf(out), out);
    } else toast('Отменено');
  } catch (err) {
    toast(String(err));
    sideRefresh();
  } finally {
    archiveBusy = false;
  }
}

async function unpackArchives(paths, intoFolder) {
  if (archiveBusy) return toast('Подождите, архиватор ещё работает');
  archiveBusy = true;
  let last = null, done = 0;
  try {
    for (const p of paths) {
      toast(paths.length > 1 ? `Распаковка ${done + 1} из ${paths.length}…` : 'Распаковка…');
      const dest = await invoke('archive_unpack', { path: p, intoFolder });
      if (!dest) { toast('Отменено'); break; }
      last = dest;
      done++;
    }
    if (done) {
      toast(done > 1 ? `Распаковано архивов: ${done}` : 'Распаковано');
      await afterArchive(parentOf(paths[0]), intoFolder && done === 1 ? last : null);
    }
  } catch (err) {
    toast(String(err));
    sideRefresh();
  } finally {
    archiveBusy = false;
  }
}

sideListEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  focusArea = 'side';
  const row = e.target.closest('.row');
  if (!row) {
    if (side.sel.size) { side.sel.clear(); updateSideSel(); }
    return sideMenuEmpty(e.clientX, e.clientY);
  }
  const key = lc(row.dataset.path);
  if (!side.sel.has(key)) {
    side.sel = new Set([key]);
    side.anchor = key;
    updateSideSel();
  }
  const items = selectedSideEntries();
  const paths = items.map((i) => i.path);
  const one = items.length === 1 ? items[0] : null;
  const drives = items.some((i) => i.drive);
  showMenu(e.clientX, e.clientY, [
    { label: one?.is_dir ? 'Открыть' : items.length > 1 ? `Открыть (${items.length})` : 'Открыть', kbd: 'Enter', action: () => sideOpen(items) },
    one && !one.is_dir ? { label: 'Открыть с помощью…', action: () => invoke('open_with', { path: one.path }).catch((er) => toast(String(er))) } : null,
    one?.is_dir ? { label: 'Открыть в Проводнике', action: () => invoke('open_path', { path: one.path }).catch((er) => toast(String(er))) } : null,
    { label: 'Показать в Проводнике', action: () => invoke('reveal_path', { path: paths[0] }).catch((er) => toast(String(er))) },
    { label: 'Положить на доску', action: () => putOnBoard(paths) },
    { sep: true },
    { label: 'Вырезать', kbd: 'Ctrl+X', action: () => sideCopy(true), disabled: drives },
    { label: 'Копировать', kbd: 'Ctrl+C', action: () => sideCopy(false), disabled: drives },
    one?.is_dir ? { label: 'Вставить в эту папку', action: () => sidePaste(one.path) } : null,
    { label: items.length > 1 ? 'Копировать пути' : 'Копировать путь', action: () => copyText(paths.join('\n')) },
    ...(drives ? [] : archiveMenuItems(items.map((i) => ({ path: i.path, isDir: i.is_dir })))),
    { sep: true },
    { label: 'Переименовать', kbd: 'F2', action: () => sideRename(one.path), disabled: !one || drives },
    { label: 'Удалить', kbd: 'Del', danger: true, action: () => deletePaths(paths), disabled: drives },
  ]);
});

/* ---------------- клавиатура (когда активна панель) ---------------- */

function sideKeydown(e) {
  if (isTyping(e.target)) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const sel = selectedSideEntries();
  const k = e.key;

  const moveSel = (delta) => {
    if (!side.view.length) return;
    let i = side.view.findIndex((x) => lc(x.path) === side.anchor);
    i = i < 0 ? (delta > 0 ? 0 : side.view.length - 1) : clamp(i + delta, 0, side.view.length - 1);
    const key = lc(side.view[i].path);
    if (e.shiftKey) side.sel.add(key); else side.sel = new Set([key]);
    side.anchor = key;
    updateSideSel();
    scrollToRow(key);
  };

  // сколько значков в одном ряду (для стрелок вверх/вниз в режиме значков)
  const cols = () => {
    if (!isGrid()) return 1;
    const rows = [...side.rows.values()];
    if (!rows.length) return 1;
    const top = rows[0].offsetTop;
    let n = 0;
    while (n < rows.length && rows[n].offsetTop === top) n++;
    return Math.max(1, n);
  };

  if (e.altKey && k === 'ArrowLeft') sideBack();
  else if (e.altKey && k === 'ArrowRight') sideForward();
  else if ((e.altKey && k === 'ArrowUp') || k === 'Backspace') sideUp();
  else if (k === 'ArrowDown') moveSel(cols());
  else if (k === 'ArrowUp') moveSel(-cols());
  else if (k === 'ArrowRight' && isGrid()) moveSel(1);
  else if (k === 'ArrowLeft' && isGrid()) moveSel(-1);
  else if (k === 'PageDown') moveSel(15 * cols());
  else if (k === 'PageUp') moveSel(-15 * cols());
  else if (k === 'Home') moveSel(-1e9);
  else if (k === 'End') moveSel(1e9);
  else if (k === 'Enter') sideOpen(sel);
  else if (k === 'F2') { if (sel.length === 1) sideRename(sel[0].path); }
  else if (k === 'Delete') deletePaths(sel.map((x) => x.path));
  else if (k === 'F5') sideRefresh();
  else if (k === 'Escape') { side.sel.clear(); updateSideSel(); }
  else if (ctrl && e.shiftKey && e.code === 'KeyN') sideNewFolder();
  else if (ctrl && e.code === 'KeyC') sideCopy(false);
  else if (ctrl && e.code === 'KeyX') sideCopy(true);
  else if (ctrl && e.code === 'KeyV') sidePaste();
  else if (ctrl && e.code === 'KeyA') { side.sel = new Set(side.view.map((x) => lc(x.path))); updateSideSel(); }
  else if (!ctrl && !e.altKey && k.length === 1 && k !== ' ') {
    // переход к первому объекту на эту букву
    const ch = lc(k);
    const start = side.view.findIndex((x) => lc(x.path) === side.anchor);
    const n = side.view.length;
    for (let j = 1; j <= n; j++) {
      const it = side.view[(start + j + n) % n];
      if (lc(it.name).startsWith(ch)) {
        side.sel = new Set([lc(it.path)]);
        side.anchor = lc(it.path);
        updateSideSel();
        scrollToRow(it.path);
        break;
      }
    }
  } else return false;
  e.preventDefault();
  return true;
}

/* ---------------- перетаскивание из Проводника Windows в панель ---------------- */

let extTargetEl = null;
function sideDragOver(cx, cy) {
  if (extTargetEl) extTargetEl.classList.remove('drop-into');
  extTargetEl = null;
  sideListEl.classList.remove('drop-here');
  if (!state.ui.side) return false;
  const r = sideEl.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return false;
  const under = document.elementFromPoint(cx, cy);
  const row = under?.closest('#sideList .row');
  const pl = under?.closest('.place');
  if (row && row._entry.is_dir) extTargetEl = row;
  else if (pl && pl.dataset.path) extTargetEl = pl;
  if (extTargetEl) extTargetEl.classList.add('drop-into');
  else if (side.path) sideListEl.classList.add('drop-here');
  return true;
}

function sideDragClear() {
  if (extTargetEl) extTargetEl.classList.remove('drop-into');
  extTargetEl = null;
  sideListEl.classList.remove('drop-here');
}

async function sideExternalDrop(paths, cx, cy) {
  sideDragOver(cx, cy);
  const dest = extTargetEl ? (extTargetEl._entry?.path || extTargetEl.dataset.path) : side.path;
  sideDragClear();
  if (!dest) return toast('Откройте папку, чтобы скопировать в неё файлы');
  await transferTo(paths, dest, 'copy');
}

/* ---------------- панель: показать / скрыть, ширина ---------------- */

function setSideOpen(open) {
  state.ui.side = open;
  document.body.classList.toggle('side-hidden', !open);
  save();
  if (open && !side.entries.length && !side.error) initSideContent();
  if (!open && focusArea === 'side') focusArea = 'board';
}

splitterEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  splitterEl.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => {
    const w = clamp(ev.clientX, 200, Math.max(260, window.innerWidth * 0.6));
    sideEl.style.width = w + 'px';
  };
  const up = () => {
    splitterEl.removeEventListener('pointermove', move);
    splitterEl.removeEventListener('pointerup', up);
    document.body.classList.remove('resizing');
    state.ui.sideW = Math.round(sideEl.getBoundingClientRect().width);
    save();
  };
  splitterEl.addEventListener('pointermove', move);
  splitterEl.addEventListener('pointerup', up);
});
splitterEl.addEventListener('dblclick', () => { sideEl.style.width = '300px'; state.ui.sideW = 300; save(); });

$('#toggleSide').onclick = () => setSideOpen(!state.ui.side);
$('#sBack').onclick = sideBack;
$('#sFwd').onclick = sideForward;
$('#sUp').onclick = sideUp;
loadArchiver();
$('#sPin').onclick = () => { if (side.path) putOnBoard([side.path]); };
$('#sView').onclick = () => setSideView(isGrid() ? 'list' : 'grid');
$('#sMore').onclick =(e) => { const r = e.currentTarget.getBoundingClientRect(); sideMenuEmpty(r.left, r.bottom + 4); };
sideFilterEl.addEventListener('input', () => renderSide());
sideFilterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { sideFilterEl.value = ''; renderSide(); sideFilterEl.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    sideFilterEl.blur();
    focusArea = 'side';
    if (side.view.length) {
      const key = lc(side.view[0].path);
      side.sel = new Set([key]);
      side.anchor = key;
      updateSideSel();
      if (e.key === 'Enter' && side.view.length === 1) sideOpen(side.view);
    }
  }
});

async function initSideContent() {

  await loadPlaces();
  let start = state.ui.sidePath;
  if (start === undefined || start === null) {
    start = side.places.find((p) => p.kind === 'desktop')?.path || '';
  }
  await sideNavigate(start, { push: false });
  if (side.error) {
    await sideNavigate(side.places.find((p) => p.kind === 'desktop')?.path || '', { push: false });
  }
}

function initSide() {
  state.ui ||= {};
  const ui = state.ui;
  ui.side ??= true;
  ui.sideW ??= 300;
  ui.placesOpen ??= true;
  ui.showHidden ??= false;
  ui.sideView ??= 'list';
  updateViewButton();
  sideEl.style.width = ui.sideW + 'px';
  document.body.classList.toggle('side-hidden', !ui.side);
  if (ui.side) initSideContent();
}

init();
