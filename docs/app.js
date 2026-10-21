'use strict';
/* ӨRLEU BASE — интерфейс. Данные хранятся в базе Supabase (см. data.js), браузер их не хранит. */

const S = { meta: null, assets: [], filters: { q: '', category: '', room: '', condition: '', status: '' } };
let scanner = null;

// ---------- утилиты ----------
const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => S.meta?.user?.role === 'admin';
const money = v => v == null ? '' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const roomName = code => { const r = S.meta.rooms.find(x => x.code === code); return r ? `${r.code}${r.name ? ' — ' + r.name : ''}` : code; };
const roomOptions = (sel, empty = '— не указан —') =>
  `<option value="">${empty}</option>` + S.meta.rooms.map(r => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.code)}${r.name ? ' — ' + esc(r.name) : ''}</option>`).join('');
const empOptions = (sel, empty = '— не закреплено —') =>
  `<option value="">${empty}</option>` + S.meta.employees.map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.full_name)}</option>`).join('');
const opts = (list, sel) => list.map(x => `<option ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');

function toast(text, ms = 2600) {
  const t = $('#toast'); t.textContent = text; t.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.style.display = 'none', ms);
}

async function act(fn, okText) {
  try { const r = await fn(); if (okText) toast(okText); return r; }
  catch (e) { alert(e.message); throw e; }
}

function conditionBadge(c) {
  const cls = { 'Исправна': 'b-ok', 'Неисправна': 'b-bad', 'Требует ремонта': 'b-warn' }[c] || 'b-gray';
  return `<span class="badge ${cls}">${esc(c)}</span>`;
}
function statusBadge(s) {
  const cls = { 'В эксплуатации': 'b-blue', 'На складе': 'b-gray', 'Предлагается к списанию': 'b-warn', 'Списана': 'b-bad' }[s] || 'b-gray';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function download(kind) { act(() => exportReport(kind)); }

// ---------- модальные формы ----------
function field(label, name, value = '', type = 'text', extra = '') {
  return `<label class="${extra.includes('full') ? 'full' : ''}">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra.replace('full', '')}></label>`;
}
function select(label, name, optionsHtml, full = false) {
  return `<label class="${full ? 'full' : ''}">${label}<select name="${name}">${optionsHtml}</select></label>`;
}
function textarea(label, name, value = '') {
  return `<label class="full">${label}<textarea name="${name}">${esc(value)}</textarea></label>`;
}

function dialog(title, body, onSubmit, submitText = 'Сохранить') {
  const d = $('#modal');
  d.innerHTML = `<h2>${title}</h2><form id="dlgform"><div class="form">${body}</div>
    <div class="err" id="dlgErr"></div>
    <div class="actions"><button type="button" onclick="this.closest('dialog').close()">Отмена</button>
    <button class="primary" type="submit">${submitText}</button></div></form>`;
  d.showModal();
  $('#dlgform').onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    try { await onSubmit(v); d.close(); }
    catch (err) { $('#dlgErr').textContent = err.message; }
    finally { btn.disabled = false; }
  };
}
const idOrNull = v => v === '' || v == null ? null : Number(v);
const numOrNull = v => v === '' || v == null ? null : Number(String(v).replace(',', '.'));

// ---------- вход ----------
function showLogin() {
  stopScanner();
  $('#app').classList.add('hidden'); $('#loginView').classList.remove('hidden');
}
async function doLogin(e) {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  try {
    if (!sb) throw new Error('Программа не подключена к базе: заполните config.js (см. README)');
    const { error } = await sb.auth.signInWithPassword({ email: v.email.trim(), password: v.password });
    if (error) throw new Error(/invalid/i.test(error.message) ? 'Неверная почта или пароль' : error.message);
    $('#loginErr').textContent = '';
    await boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
}
async function logout() { await sb?.auth.signOut().catch(() => {}); S.meta = null; showLogin(); }

async function loadMeta() { S.meta = await api('GET', '/api/meta'); }
async function loadAssets() { S.assets = await api('GET', '/api/assets'); }

async function boot() {
  try { await loadMeta(); } catch (e) { if (e.status !== 401) { $('#loginErr').textContent = e.message; } showLogin(); return; }
  await loadAssets();
  $('#loginView').classList.add('hidden'); $('#app').classList.remove('hidden');
  const u = S.meta.user;
  $('#userchip').className = 'user-chip' + (u.role === 'viewer' ? ' role-viewer' : '');
  $('#userchip').textContent = `${u.full_name || u.email} · ${u.role === 'admin' ? 'администратор' : 'только просмотр'}`;
  route();
}

// ---------- навигация ----------
const NAV = [
  ['', '🏠', 'Главная'], ['assets', '🖥️', 'Основные средства (ОС)'], ['rooms', '🚪', 'Кабинеты'],
  ['employees', '👥', 'Сотрудники'], ['stock', '📦', 'ТМЗ и расходники'], ['audits', '📋', 'Инвентаризация'],
  ['scan', '📷', 'Сканер QR'], ['history', '🕘', 'История'], ['reports', '📊', 'Отчёты'], ['settings', '⚙️', 'Настройки'],
];
const SECTION_OF = { a: 'assets', room: 'rooms', emp: 'employees', audit: 'audits' };

function renderNav(section) {
  $('#nav').innerHTML = `<div class="nav-brand"><img src="logo.png" alt="Өрлеу"><span>Акмолинская область</span></div>` + NAV.map(([key, icon, label]) =>
    `<button class="${key === section ? 'active' : ''}" onclick="location.hash='#/${key}'"><span class="menu-icon">${icon}</span>${label}</button>`).join('');
}

async function route() {
  if (!S.meta) return;
  stopScanner();
  const [, name = '', arg] = (location.hash.replace(/^#/, '') || '/').split('/');
  const section = SECTION_OF[name] || name;
  renderNav(section);
  const view = VIEWS[name] || VIEWS[''];
  const main = $('#main');
  try { main.innerHTML = await view(decodeURIComponent(arg || '')); }
  catch (e) { main.innerHTML = `<div class="panel"><h2>Ошибка</h2><p>${esc(e.message)}</p></div>`; return; }
  AFTER[name]?.(decodeURIComponent(arg || ''));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

async function refresh() { await Promise.all([loadMeta(), loadAssets()]); await route(); }

// ---------- таблица ОС ----------
function assetTable(list, { showRoom = true, showEmp = true } = {}) {
  if (!list.length) return '<div class="empty">Нет записей</div>';
  return `<div class="scroll"><table><thead><tr><th>Инв. номер</th><th>Наименование</th>
    ${showRoom ? '<th>Кабинет</th>' : ''}${showEmp ? '<th class="hide-sm">Закреплено за</th>' : ''}
    <th>Состояние</th><th class="hide-sm">Статус</th></tr></thead><tbody>
    ${list.map(a => `<tr class="clickable" onclick="location.hash='#/a/${encodeURIComponent(a.inv)}'">
      <td class="num">${esc(a.inv)}</td><td>${esc(a.name)}</td>
      ${showRoom ? `<td>${a.room ? esc(a.room) : '<span class="badge b-bad">нет</span>'}</td>` : ''}
      ${showEmp ? `<td class="hide-sm">${esc(a.employee || '—')}</td>` : ''}
      <td>${conditionBadge(a.condition)}</td><td class="hide-sm">${statusBadge(a.status)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function filteredAssets() {
  const f = S.filters, q = f.q.trim().toLowerCase();
  return S.assets.filter(a =>
    (!q || [a.inv, a.name, a.room, a.employee, a.serial, a.notes].join(' ').toLowerCase().includes(q)) &&
    (!f.category || a.category === f.category) &&
    (!f.room || (f.room === '__none' ? !a.room : a.room === f.room)) &&
    (!f.condition || a.condition === f.condition) &&
    (!f.status || a.status === f.status));
}

function renderAssetRows() {
  const list = filteredAssets();
  $('#assetCount').textContent = `${list.length} из ${S.assets.length}`;
  $('#assetTable').innerHTML = assetTable(list);
}

function setFilter(k, v) { S.filters[k] = v; renderAssetRows(); }

// ---------- представления ----------
const VIEWS = {};
const AFTER = {};

VIEWS[''] = async () => {
  const A = S.assets, active = A.filter(a => a.status !== 'Списана');
  const stock = await api('GET', '/api/stock');
  const events = await api('GET', '/api/events?limit=6');
  const cnt = c => A.filter(a => a.category === c).length;
  const cat = (icon, name, filter) => `<button class="category" onclick="S.filters={q:'',category:'${filter}',room:'',condition:'',status:''};location.hash='#/assets'"><span class="cat-ico">${icon}</span>${name} <span style="float:right">${cnt(filter)}</span></button>`;
  const q = (icon, name, fn) => `<button onclick="${fn}"><span class="qico">${icon}</span>${name}</button>`;
  return `<section class="hero-new"><h1>Қош келдіңіз!</h1><p>Система учёта компьютерной техники и имущества филиала</p>
    <p style="margin-top:10px;color:#1376df;font-weight:700">Білімге жол – біліктіліктен!</p></section>
  <section class="dashboard-stats">
    <div class="dstat"><div class="di">🖥️</div><div><span>Основные средства</span><b>${active.length}</b><span>Единиц в учёте</span></div></div>
    <div class="dstat"><div class="di">🚪</div><div><span>Без кабинета</span><b>${active.filter(a => !a.room).length}</b><span>Требуют распределения</span></div></div>
    <div class="dstat"><div class="di">🛠️</div><div><span>Неисправно / ремонт</span><b>${A.filter(a => ['Неисправна', 'Требует ремонта'].includes(a.condition)).length}</b><span>По состоянию</span></div></div>
    <div class="dstat"><div class="di">📦</div><div><span>ТМЗ</span><b>${stock.length}</b><span>Позиций расходников</span></div></div>
  </section>
  <section class="dash-two">
    <div class="panel"><h2>🖥️ Основные средства по категориям</h2><div class="category-grid">
      ${cat('🖥️', 'Компьютеры', 'Компьютеры')}${cat('🖥', 'Моноблоки', 'Моноблоки')}${cat('💻', 'Ноутбуки', 'Ноутбуки')}
      ${cat('🖨️', 'Принтеры и МФУ', 'Принтеры и МФУ')}${cat('📺', 'Интерактивные панели', 'Интерактивные панели')}${cat('📽️', 'Проекторы', 'Проекторы')}
      ${cat('🎤', 'Аудио и видео', 'Аудио и видео')}${cat('🤖', 'Робототехника', 'Робототехника')}${cat('🌐', 'Сеть и ИБП', 'Сетевое оборудование')}
    </div></div>
    <div class="panel"><h2>⚡ Быстрые действия</h2><div class="quickgrid">
      ${q('📷', 'Сканер QR', "location.hash='#/scan'")}${q('📋', 'Инвентаризация', "location.hash='#/audits'")}${q('🚪', 'Кабинеты', "location.hash='#/rooms'")}
      ${isAdmin() ? q('➕', 'Добавить ОС', 'editAsset()') : q('🖥️', 'Все ОС', "location.hash='#/assets'")}${q('🛠️', 'Ремонт / списание', "S.filters={q:'',category:'',room:'',condition:'',status:'Предлагается к списанию'};location.hash='#/assets'")}${q('🔳', 'QR-наклейки', "location.hash='#/rooms'")}
    </div></div>
  </section>
  <div class="panel"><h2>🕘 Последние операции</h2>
    ${events.map(e => `<p style="padding:8px 0;border-bottom:1px solid #edf2f8;margin:0"><b>${esc(e.type)}</b> ${esc(e.ref)}<br><small class="muted">${esc(e.at)} · ${esc(e.user)} · ${esc(e.details)}</small></p>`).join('') || '<p class="muted">Операций пока нет.</p>'}
    <div class="btnrow"><button onclick="location.hash='#/history'">Вся история →</button></div></div>`;
};

VIEWS.assets = async () => {
  const f = S.filters, M = S.meta;
  return `<div class="top"><div><h1>Основные средства (ОС)</h1><div class="muted">Показано: <span id="assetCount"></span></div></div>
    <div class="btnrow">${isAdmin() ? `<button class="primary" onclick="editAsset()">＋ Добавить</button>` : ''}
      <button onclick="printFiltered()">🔳 QR-наклейки (по фильтру)</button>
      <button onclick="download('assets')">⇩ Excel</button></div></div>
  <div class="filters">
    <input type="search" placeholder="Инв. номер, название, кабинет, сотрудник…" value="${esc(f.q)}" oninput="setFilter('q',this.value)">
    <select onchange="setFilter('category',this.value)"><option value="">Все категории</option>${opts(M.categories, f.category)}</select>
    <select onchange="setFilter('room',this.value)"><option value="">Все кабинеты</option><option value="__none" ${f.room === '__none' ? 'selected' : ''}>Без кабинета</option>
      ${M.rooms.map(r => `<option value="${esc(r.code)}" ${f.room === r.code ? 'selected' : ''}>${esc(r.code)}</option>`).join('')}</select>
    <select onchange="setFilter('condition',this.value)"><option value="">Любое состояние</option>${opts(M.conditions, f.condition)}</select>
    <select onchange="setFilter('status',this.value)"><option value="">Любой статус</option>${opts(M.statuses, f.status)}</select>
  </div>
  <div class="panel" id="assetTable"></div>`;
};
AFTER.assets = renderAssetRows;

function printFiltered() {
  const list = filteredAssets().filter(a => a.category !== 'Программное обеспечение' && a.status !== 'Списана');
  if (!list.length) return alert('Нет техники для печати');
  if (list.length > 400 && !confirm(`Будет ${list.length} наклеек. Продолжить?`)) return;
  openLabels(list.map(a => a.inv));
}

// ----- карточка ОС -----
VIEWS.a = async inv => {
  const a = await api('GET', '/api/assets/' + encodeURIComponent(inv));
  const open = a.open_audits || [];
  const adm = isAdmin();
  return `<div class="btnrow"><button onclick="history.length>1?history.back():location.hash='#/assets'">← Назад</button></div>
  <div class="panel"><div class="card-head"><div>
    <div class="muted">${esc(a.category)}</div><h1>${esc(a.name)}</h1>
    <div style="font-size:20px;font-weight:700;color:#1559b5">№ ${esc(a.inv)}</div>
    <div class="btnrow">${conditionBadge(a.condition)} ${statusBadge(a.status)}</div></div>
    <div class="qr-box">${qrSvg(assetUrl(a.inv))}<br><small class="muted">постоянный QR</small></div></div>
    <div class="kv">
      <div>Кабинет</div><div><b>${a.room ? esc(roomName(a.room)) : '<span class="badge b-bad">не указан</span>'}</b></div>
      <div>Закреплено за</div><div><b>${esc(a.employee || 'не закреплено')}</b></div>
      <div>МОЛ</div><div>${esc(a.mol || '—')}</div>
      <div>Серийный номер</div><div>${esc(a.serial || '—')}</div>
      <div>Дата поступления</div><div>${esc(a.acquired || '—')}</div>
      <div>Стоимость</div><div>${a.cost != null ? money(a.cost) + ' ₸' : '—'}${a.residual != null ? ` · остаточная ${money(a.residual)} ₸` : ''}</div>
      <div>Примечание</div><div>${esc(a.notes || '—')}</div>
      <div>Источник</div><div class="muted">${esc(a.source)} · изменено ${esc(a.updated_at)}</div>
    </div>
    ${adm ? `<div class="btnrow">
      <button class="primary" onclick="moveAsset('${esc(a.inv)}')">🔄 Переместить</button>
      <button onclick="editAsset('${esc(a.inv)}')">✎ Изменить</button>
      <button onclick="quickCondition('${esc(a.inv)}')">🛠️ Состояние</button>
      <button onclick="openLabels(['${esc(a.inv)}'])">🔳 Печать QR</button>
      <button class="danger" onclick="deleteAsset('${esc(a.inv)}')">Удалить</button></div>` :
      `<div class="btnrow"><button onclick="openLabels(['${esc(a.inv)}'])">🔳 Печать QR</button></div>`}
    ${adm && open.length ? `<div class="note">Идёт инвентаризация: ${open.map(o => o.scanned
      ? `<span class="badge b-ok">✓ отмечено в «${esc(o.name)}»</span>`
      : `<button class="primary" onclick="markInAudit(${o.id},'${esc(a.inv)}')">✓ Отметить в «${esc(o.name)}»</button>`).join(' ')}</div>` : ''}
  </div>
  <div class="panel"><h2>История перемещений</h2>${a.movements.length ? `<div class="scroll"><table><tr><th>Дата</th><th>Откуда</th><th>Куда</th><th>Основание</th><th class="hide-sm">Кто</th></tr>
    ${a.movements.map(m => `<tr><td class="num">${esc(m.at)}</td><td>${esc(m.from_room || '—')}<br><small class="muted">${esc(m.from_employee)}</small></td>
      <td>${esc(m.to_room || '—')}<br><small class="muted">${esc(m.to_employee)}</small></td><td>${esc(m.reason)}</td><td class="hide-sm">${esc(m.user)}</td></tr>`).join('')}</table></div>`
    : '<div class="empty">Перемещений ещё не было</div>'}</div>
  <div class="panel"><h2>Журнал изменений</h2>${a.events.map(e => `<p style="margin:0;padding:7px 0;border-bottom:1px solid #edf2f8"><b>${esc(e.type)}</b> · ${esc(e.details)}<br><small class="muted">${esc(e.at)} · ${esc(e.user)}</small></p>`).join('') || '<div class="empty">Записей нет</div>'}</div>`;
};

function editAsset(inv) {
  const M = S.meta;
  const a = inv ? S.assets.find(x => x.inv === inv) : null;
  const v = a || { inv: '', name: '', category: 'Прочая техника', room_id: null, employee_id: null, mol: '', condition: 'Не проверено', status: 'В эксплуатации', serial: '', acquired: '', cost: null, residual: null, notes: '' };
  dialog(a ? 'Изменить ОС' : 'Новое основное средство',
    field('Инвентарный номер *', 'inv', v.inv, 'text', 'required') + field('Наименование *', 'name', v.name, 'text', 'required') +
    select('Категория', 'category', opts(M.categories, v.category)) + select('Кабинет', 'room_id', roomOptions(v.room_id)) +
    select('Закреплено за', 'employee_id', empOptions(v.employee_id)) + field('МОЛ', 'mol', v.mol) +
    select('Состояние', 'condition', opts(M.conditions, v.condition)) + select('Статус', 'status', opts(M.statuses, v.status)) +
    field('Серийный номер', 'serial', v.serial) + field('Дата поступления', 'acquired', v.acquired) +
    field('Первоначальная стоимость', 'cost', v.cost ?? '') + field('Остаточная стоимость', 'residual', v.residual ?? '') +
    textarea('Примечание', 'notes', v.notes) + (a ? field('Основание перемещения (если меняете кабинет/сотрудника)', 'reason', '', 'text', 'full') : ''),
    async f => {
      const body = { ...f, room_id: idOrNull(f.room_id), employee_id: idOrNull(f.employee_id), cost: numOrNull(f.cost), residual: numOrNull(f.residual) };
      const saved = a ? await api('PUT', '/api/assets/' + encodeURIComponent(inv), body) : await api('POST', '/api/assets', body);
      toast('Сохранено');
      await loadAssets(); await loadMeta();
      if (location.hash === '#/a/' + encodeURIComponent(saved.inv)) route(); else location.hash = '#/a/' + encodeURIComponent(saved.inv);
    });
}

function moveAsset(inv) {
  const a = S.assets.find(x => x.inv === inv);
  dialog(`Переместить: ${esc(a.name)}`,
    `<div class="full note">Сейчас: кабинет <b>${esc(a.room || '—')}</b>, закреплено за <b>${esc(a.employee || '—')}</b></div>` +
    select('Новый кабинет', 'room_id', roomOptions(a.room_id), true) + select('Закрепить за сотрудником', 'employee_id', empOptions(a.employee_id), true) +
    field('Основание / комментарий', 'reason', '', 'text', 'full placeholder="например: служебная записка, ремонт"'),
    async f => {
      await api('POST', `/api/assets/${encodeURIComponent(inv)}/move`, { room_id: idOrNull(f.room_id), employee_id: idOrNull(f.employee_id), reason: f.reason });
      toast('Перемещение сохранено'); await refresh();
    }, 'Переместить');
}

function quickCondition(inv) {
  const a = S.assets.find(x => x.inv === inv), M = S.meta;
  dialog('Состояние и статус', select('Состояние', 'condition', opts(M.conditions, a.condition)) + select('Статус', 'status', opts(M.statuses, a.status)) + textarea('Примечание', 'notes', a.notes),
    async f => {
      await api('PUT', '/api/assets/' + encodeURIComponent(inv), { ...a, ...f, reason: '' });
      toast('Сохранено'); await refresh();
    });
}

async function deleteAsset(inv) {
  if (!confirm(`Удалить ${inv} из базы полностью? Для списанной техники лучше поставить статус «Списана» — тогда история сохранится.`)) return;
  await act(() => api('DELETE', '/api/assets/' + encodeURIComponent(inv)), 'Удалено');
  await loadAssets(); location.hash = '#/assets';
}

async function markInAudit(auditId, inv) {
  const r = await act(() => api('POST', `/api/audits/${auditId}/scan`, { code: inv }));
  toast(r.message); route();
}

// ----- кабинеты -----
VIEWS.rooms = async () => {
  const counts = {};
  for (const a of S.assets) counts[a.room || ''] = (counts[a.room || ''] || 0) + 1;
  const bad = r => S.assets.filter(a => a.room === r.code && ['Неисправна', 'Требует ремонта'].includes(a.condition)).length;
  return `<div class="top"><div><h1>Кабинеты</h1><div class="muted">Нажмите на кабинет, чтобы увидеть технику, сотрудников и напечатать наклейки</div></div>
    ${isAdmin() ? '<button class="primary" onclick="editRoom()">＋ Кабинет</button>' : ''}</div>
  ${counts[''] ? `<div class="note">Без кабинета: <b>${counts['']}</b> ед. — <a href="#/assets" onclick="S.filters.room='__none'">распределить</a></div>` : ''}
  <div class="panel">${S.meta.rooms.map(r => `<button class="room" onclick="location.hash='#/room/${r.id}'">
    <strong>🚪 ${esc(r.code)}</strong><small>${esc(r.name || '')}</small>
    <small>${counts[r.code] || 0} ед. ОС${r.stock ? ` · ${r.stock} ТМЗ` : ''}${bad(r) ? ` · <span class="warn">${bad(r)} неиспр.</span>` : ''}</small></button>`).join('')}</div>`;
};

VIEWS.room = async id => {
  const r = S.meta.rooms.find(x => x.id === Number(id));
  if (!r) throw new Error('Кабинет не найден');
  const list = S.assets.filter(a => a.room === r.code);
  const stock = (await api('GET', '/api/stock')).filter(s => s.room === r.code);
  const people = S.meta.employees.filter(e => e.room === r.code);
  const groups = {};
  for (const a of list) (groups[a.employee || 'Не закреплено за сотрудником'] ||= []).push(a);
  return `<div class="btnrow"><button onclick="location.hash='#/rooms'">← Все кабинеты</button></div>
  <div class="top"><div><h1>Кабинет ${esc(r.code)}</h1><div class="muted">${esc(r.name)}</div></div>
    <div class="btnrow"><button onclick="openLabels(S.assets.filter(a => a.room_id === ${r.id}).map(a => a.inv))">🔳 Наклейки кабинета</button>
    ${isAdmin() ? `<button class="primary" onclick="startAudit(${r.id})">📋 Инвентаризация кабинета</button>
    <button onclick="editRoom(${r.id})">✎ Изменить</button>` : ''}</div></div>
  ${people.length ? `<div class="note">Сотрудники кабинета: ${people.map(p => `<a href="#/emp/${p.id}">${esc(p.full_name)}</a>`).join(', ')}</div>` : ''}
  <div class="panel"><h2>Основные средства — ${list.length}</h2>
    ${Object.entries(groups).map(([who, arr]) => `<h3>👤 ${esc(who)} — ${arr.length} ед.</h3>${assetTable(arr, { showRoom: false, showEmp: false })}`).join('') || '<div class="empty">Техники нет</div>'}</div>
  ${stock.length ? `<div class="panel"><h2>ТМЗ в кабинете</h2><table><tr><th>Наименование</th><th>Остаток</th><th>Примечание</th></tr>
    ${stock.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.qty} ${esc(s.unit)}</td><td>${esc(s.notes)}</td></tr>`).join('')}</table></div>` : ''}`;
};

function editRoom(id) {
  const r = id ? S.meta.rooms.find(x => x.id === id) : { code: '', name: '' };
  dialog(id ? 'Кабинет' : 'Новый кабинет', field('Номер или название *', 'code', r.code, 'text', 'required') + field('Назначение', 'name', r.name) +
    (id ? `<div class="full"><button type="button" class="danger" onclick="deleteRoom(${id})">Удалить кабинет</button></div>` : ''),
    async f => {
      if (id) await api('PUT', '/api/rooms/' + id, f); else await api('POST', '/api/rooms', f);
      toast('Сохранено'); await refresh();
    });
}
async function deleteRoom(id) {
  if (!confirm('Удалить кабинет?')) return;
  await act(() => api('DELETE', '/api/rooms/' + id), 'Кабинет удалён');
  $('#modal').close(); await refresh(); location.hash = '#/rooms';
}

// ----- сотрудники -----
VIEWS.employees = async () => {
  const deps = {};
  for (const e of S.meta.employees) (deps[e.department || 'Без подразделения'] ||= []).push(e);
  return `<div class="top"><div><h1>Сотрудники</h1><div class="muted">Всего: ${S.meta.employees.length}</div></div>
    ${isAdmin() ? '<button class="primary" onclick="editEmployee()">＋ Сотрудник</button>' : ''}</div>
  ${Object.entries(deps).sort().map(([d, list]) => `<div class="panel"><h2>${esc(d)}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
    ${list.map(e => `<button class="room" style="max-width:none" onclick="location.hash='#/emp/${e.id}'"><strong>👤 ${esc(e.full_name)}</strong>
      <small>${esc(e.position || 'Должность не указана')}${e.room ? ' · каб. ' + esc(e.room) : ''}</small><small>${e.assets} ед. техники</small></button>`).join('')}</div></div>`).join('')}`;
};

VIEWS.emp = async id => {
  const e = S.meta.employees.find(x => x.id === Number(id));
  if (!e) throw new Error('Сотрудник не найден');
  const list = S.assets.filter(a => a.employee_id === e.id);
  return `<div class="btnrow"><button onclick="location.hash='#/employees'">← Все сотрудники</button></div>
  <div class="panel"><div class="top"><div><h1>${esc(e.full_name)}</h1><div class="muted">${esc(e.department)}${e.position ? ' · ' + esc(e.position) : ''}</div></div>
    ${isAdmin() ? `<div class="btnrow"><button onclick="editEmployee(${e.id})">✎ Изменить</button><button onclick="assignToEmployee(${e.id})">＋ Закрепить технику</button></div>` : ''}</div>
    <div class="kv"><div>Кабинет</div><div>${esc(e.room ? roomName(e.room) : '—')}</div><div>Телефон</div><div>${esc(e.phone || '—')}</div></div></div>
  <div class="panel"><h2>Закреплённая техника — ${list.length}</h2>${assetTable(list, { showEmp: false })}</div>`;
};

function editEmployee(id) {
  const e = id ? S.meta.employees.find(x => x.id === id) : { full_name: '', department: '', position: '', room_id: null, phone: '' };
  dialog(id ? 'Сотрудник' : 'Новый сотрудник',
    field('ФИО *', 'full_name', e.full_name, 'text', 'required full') + field('Подразделение', 'department', e.department) +
    field('Должность', 'position', e.position) + select('Кабинет', 'room_id', roomOptions(e.room_id)) + field('Телефон', 'phone', e.phone) +
    (id ? `<div class="full"><button type="button" class="danger" onclick="deleteEmployee(${id})">Удалить сотрудника</button></div>` : ''),
    async f => {
      const body = { ...f, room_id: idOrNull(f.room_id) };
      if (id) await api('PUT', '/api/employees/' + id, body); else await api('POST', '/api/employees', body);
      toast('Сохранено'); await refresh();
    });
}
async function deleteEmployee(id) {
  if (!confirm('Удалить сотрудника?')) return;
  await act(() => api('DELETE', '/api/employees/' + id), 'Удалено');
  $('#modal').close(); await refresh(); location.hash = '#/employees';
}

function assignToEmployee(empId) {
  const e = S.meta.employees.find(x => x.id === empId);
  dialog(`Закрепить за: ${esc(e.full_name)}`,
    field('Инвентарные номера (через запятую или пробел) *', 'invs', '', 'text', 'required full') +
    select('Переместить в кабинет', 'room_id', roomOptions(e.room_id, '— оставить как есть —'), true) +
    field('Основание', 'reason', '', 'text', 'full'),
    async f => {
      const invs = f.invs.split(/[\s,;]+/).filter(Boolean);
      for (const inv of invs) {
        const a = S.assets.find(x => x.inv === inv);
        if (!a) throw new Error(`Номер ${inv} не найден`);
        await api('POST', `/api/assets/${encodeURIComponent(inv)}/move`, { room_id: f.room_id ? Number(f.room_id) : a.room_id, employee_id: empId, reason: f.reason });
      }
      toast(`Закреплено: ${invs.length}`); await refresh();
    });
}

// ----- ТМЗ -----
VIEWS.stock = async () => {
  const items = await api('GET', '/api/stock');
  S.stock = items;
  return `<div class="top"><div><h1>ТМЗ и расходные материалы</h1><div class="muted">Количественный учёт: приход, выдача, остатки. Отдельно от основных средств.</div></div>
    <div class="btnrow">${isAdmin() ? '<button class="primary" onclick="editStock()">＋ Позиция</button>' : ''}<button onclick="download('stock')">⇩ Excel</button></div></div>
  <div class="filters" style="grid-template-columns:1fr"><input type="search" placeholder="Поиск по названию" oninput="document.querySelectorAll('#stockT tr[data-n]').forEach(r=>r.style.display=r.dataset.n.includes(this.value.toLowerCase())?'':'none')"></div>
  <div class="panel scroll"><table id="stockT"><tr><th>Наименование</th><th>Остаток</th><th class="hide-sm">Мин.</th><th>Где</th><th class="hide-sm">Примечание</th><th></th></tr>
  ${items.map(s => `<tr data-n="${esc(s.name.toLowerCase())}"><td>${esc(s.name)}</td>
    <td class="num ${s.qty <= s.min_qty ? 'bad' : 'ok'}"><b>${s.qty}</b> ${esc(s.unit)}</td><td class="hide-sm num">${s.min_qty}</td>
    <td>${esc(s.room || '—')}</td><td class="hide-sm">${esc(s.notes)}</td>
    <td style="white-space:nowrap">${isAdmin() ? `<button onclick="stockMove(${s.id},-1)">Выдать</button> <button onclick="stockMove(${s.id},1)">Приход</button> <button onclick="editStock(${s.id})">✎</button>` : ''}
      <button onclick="stockHistory(${s.id})">🕘</button></td></tr>`).join('')}</table>
  ${items.length ? '' : '<div class="empty">Позиций нет</div>'}</div>`;
};

function editStock(id) {
  const s = id ? S.stock.find(x => x.id === id) : { name: '', unit: 'шт.', qty: 0, min_qty: 0, room_id: null, notes: '' };
  dialog(id ? 'Позиция ТМЗ' : 'Новая позиция ТМЗ',
    field('Наименование *', 'name', s.name, 'text', 'required full') + field('Единица', 'unit', s.unit) +
    field('Остаток', 'qty', s.qty, 'number', 'step="any" min="0"') + field('Минимальный остаток', 'min_qty', s.min_qty, 'number', 'step="any" min="0"') +
    select('Где хранится', 'room_id', roomOptions(s.room_id)) + textarea('Примечание', 'notes', s.notes) +
    (id ? `<div class="full"><button type="button" class="danger" onclick="deleteStock(${id})">Удалить позицию</button></div>` : ''),
    async f => {
      const body = { ...f, qty: Number(f.qty), min_qty: Number(f.min_qty), room_id: idOrNull(f.room_id) };
      if (id) await api('PUT', '/api/stock/' + id, body); else await api('POST', '/api/stock', body);
      toast('Сохранено'); route();
    });
}
async function deleteStock(id) {
  if (!confirm('Удалить позицию ТМЗ?')) return;
  await act(() => api('DELETE', '/api/stock/' + id), 'Удалено'); $('#modal').close(); route();
}
function stockMove(id, sign) {
  const s = S.stock.find(x => x.id === id);
  dialog(`${sign < 0 ? 'Выдача' : 'Приход'}: ${esc(s.name)}`,
    `<div class="full note">Остаток: <b>${s.qty} ${esc(s.unit)}</b></div>` +
    field('Количество *', 'qty', '1', 'number', 'step="any" min="0" required') +
    field(sign < 0 ? 'Кому (сотрудник / кабинет)' : 'От кого / поставщик', 'counterpart', '') + field('Примечание', 'note', '', 'text', 'full'),
    async f => {
      const q = Number(f.qty);
      if (!(q > 0)) throw new Error('Количество должно быть больше нуля');
      await api('POST', `/api/stock/${id}/move`, { delta: sign * q, counterpart: f.counterpart, note: f.note });
      toast('Сохранено'); route();
    }, sign < 0 ? 'Выдать' : 'Оприходовать');
}
async function stockHistory(id) {
  const s = S.stock.find(x => x.id === id), moves = await api('GET', `/api/stock/${id}/moves`);
  const d = $('#modal');
  d.innerHTML = `<h2>Движение: ${esc(s.name)}</h2><div class="scroll"><table><tr><th>Дата</th><th>Кол-во</th><th>Кому / от кого</th><th>Кто</th></tr>
    ${moves.map(m => `<tr><td class="num">${esc(m.at)}</td><td class="num ${m.delta < 0 ? 'bad' : 'ok'}">${m.delta > 0 ? '+' : ''}${m.delta}</td><td>${esc(m.counterpart)} ${esc(m.note)}</td><td>${esc(m.user)}</td></tr>`).join('')}</table>
    ${moves.length ? '' : '<div class="empty">Движений нет</div>'}</div><div class="actions"><button onclick="this.closest('dialog').close()">Закрыть</button></div>`;
  d.showModal();
}

// ----- инвентаризация -----
VIEWS.audits = async () => {
  const list = await api('GET', '/api/audits');
  return `<div class="top"><div><h1>Инвентаризация</h1><div class="muted">Создайте проверку для кабинета или всего филиала и сканируйте QR-коды телефоном</div></div>
    ${isAdmin() ? '<button class="primary" onclick="startAudit()">＋ Начать инвентаризацию</button>' : ''}</div>
  <div class="panel">${list.map(au => `<div class="aitem ${au.closed_at ? '' : 'found'}" style="cursor:pointer;margin-bottom:8px" onclick="location.hash='#/audit/${au.id}'">
    <div class="grow"><b>${esc(au.name)}</b><br><small>${au.room ? 'Кабинет ' + esc(au.room) : 'Все кабинеты'} · начата ${esc(au.created_at)} · ${esc(au.created_by)}</small></div>
    <span class="badge ${au.found === au.total ? 'b-ok' : 'b-warn'}">${au.found} / ${au.total}</span>
    <span class="badge ${au.closed_at ? 'b-gray' : 'b-blue'}">${au.closed_at ? 'завершена' : 'идёт'}</span></div>`).join('') || '<div class="empty">Проверок пока нет</div>'}</div>`;
};

function startAudit(roomId) {
  const today = new Date().toLocaleDateString('ru-RU');
  const r = roomId ? S.meta.rooms.find(x => x.id === roomId) : null;
  dialog('Новая инвентаризация',
    select('Кабинет', 'room_id', roomOptions(roomId ?? null, '— все кабинеты (весь филиал) —'), true) +
    field('Название *', 'name', r ? `Кабинет ${r.code} — ${today}` : `Инвентаризация ${today}`, 'text', 'required full'),
    async f => {
      const { id } = await api('POST', '/api/audits', { name: f.name, room_id: idOrNull(f.room_id) });
      location.hash = '#/audit/' + id;
    }, 'Начать');
}

VIEWS.audit = async id => {
  const au = await api('GET', '/api/audits/' + id);
  S.audit = au;
  const open = !au.closed_at, adm = isAdmin();
  return `<div class="btnrow"><button onclick="location.hash='#/audits'">← Все проверки</button></div>
  <div class="top"><div><h1>${esc(au.name)}</h1><div class="muted">${au.room ? 'Кабинет ' + esc(roomName(au.room)) : 'Все кабинеты'} · ${open ? 'идёт' : 'завершена ' + esc(au.closed_at)}</div></div>
    <div class="btnrow"><button onclick="act(() => exportAudit(${au.id}))">⇩ Отчёт Excel</button>
    ${adm && open ? `<button onclick="closeAudit(${au.id})">✓ Завершить</button>` : ''}
    ${adm ? `<button class="danger" onclick="deleteAudit(${au.id})">Удалить</button>` : ''}</div></div>
  <div class="panel" id="auditSummary"></div>
  ${adm && open ? `<div class="panel scanbox"><h2>📷 Сканирование</h2>
    ${au.room ? '' : `<label class="muted">Где вы сейчас находитесь:<br><select id="scanRoom">${roomOptions(null, '— кабинет не выбран —')}</select></label>`}
    <div class="btnrow"><button class="primary" id="camBtn" onclick="toggleCamera()">Включить камеру</button></div>
    <div id="reader"></div><div id="scanFlash"></div>
    <div class="toolbar"><input id="manualCode" placeholder="Номер вручную или USB-сканер" onkeydown="if(event.key==='Enter')manualScan()" style="flex:1"><button onclick="manualScan()">✓ Отметить</button></div>
    <small class="muted">Камера работает по адресу https://… (см. Настройки). Можно также сканировать QR обычной камерой телефона — откроется карточка с кнопкой «Отметить».</small></div>` : ''}
  <div class="panel"><div class="top"><h2>Список</h2><div class="seg" id="auditSeg">
    <button class="on" data-f="all">Все</button><button data-f="missing">Не найдено</button><button data-f="found">Найдено</button><button data-f="foreign">Лишнее / чужое</button></div></div>
    <div class="alist" id="auditList"></div></div>`;
};
AFTER.audit = () => {
  renderAudit();
  document.querySelectorAll('#auditSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#auditSeg button').forEach(x => x.classList.toggle('on', x === b));
    S.auditFilter = b.dataset.f; renderAudit();
  });
  S.auditFilter = 'all';
};

function auditItems() {
  const au = S.audit;
  const items = au.expected.map(x => ({ ...x, state: !x.scanned_at ? 'missing' : (au.room_id && x.found_room && x.found_room !== x.room ? 'foreign' : 'found') }));
  return items.concat(au.extra.map(x => ({ ...x, state: 'foreign', extra: true })));
}

function renderAudit() {
  const au = S.audit, items = auditItems(), f = S.auditFilter || 'all';
  const pct = au.total ? Math.round(au.found / au.total * 100) : 0;
  $('#auditSummary').innerHTML = `<div class="top"><div><b style="font-size:26px;color:#11724a">${au.found}</b> из <b>${au.total}</b> найдено
    · <span class="bad">не найдено: ${au.total - au.found}</span> · <span style="color:#9a5b00">лишних: ${au.extra.length}</span></div><b>${pct}%</b></div>
    <div class="audit-progress"><div style="width:${pct}%"></div></div>`;
  const shown = items.filter(x => f === 'all' || x.state === f);
  // сначала не найденные, затем по кабинетам
  shown.sort((a, b) => (a.state === 'missing' ? 0 : 1) - (b.state === 'missing' ? 0 : 1));
  $('#auditList').innerHTML = shown.map(x => `<div class="aitem ${x.state}">
    <span class="dot"></span><div class="grow"><b>${esc(x.name)}</b><br><small>№ ${esc(x.inv)} · каб. ${esc(x.room || '—')}${x.employee ? ' · ' + esc(x.employee) : ''}
    ${x.scanned_at ? ` · ✓ ${esc(x.scanned_at.slice(11, 16))}` : ''}${x.state === 'foreign' ? ` · <b>найдено в ${esc(x.found_room || '—')}</b>` : ''}</small></div>
    ${isAdmin() && !au.closed_at && x.state === 'foreign' && x.found_room ? `<button onclick="moveHere('${esc(x.inv)}','${esc(x.found_room)}')">Переместить сюда</button>` : ''}
    ${isAdmin() && !au.closed_at && x.scanned_at ? `<button title="Снять отметку" onclick="unscan('${esc(x.inv)}')">↺</button>` : ''}
    <button onclick="location.hash='#/a/${encodeURIComponent(x.inv)}'">›</button></div>`).join('') || '<div class="empty">Пусто</div>';
}

async function reloadAudit() { S.audit = await api('GET', '/api/audits/' + S.audit.id); renderAudit(); }

let lastScan = { code: '', at: 0 };
async function submitScan(code) {
  code = code.trim();
  if (!code) return;
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.at < 3000) return;  // камера видит один и тот же QR несколько раз подряд
  lastScan = { code, at: now };
  const roomSel = $('#scanRoom');
  try {
    const r = await api('POST', `/api/audits/${S.audit.id}/scan`, { code, room_id: roomSel && roomSel.value ? Number(roomSel.value) : null });
    flash(r.result, `${r.result === 'found' ? '✓' : r.result === 'repeat' ? '↺' : '⚠'} ${r.name || r.inv}: ${r.message}`);
    await reloadAudit();
  } catch (e) { flash('error', e.message); }
}
function manualScan() { const i = $('#manualCode'); submitScan(i.value); i.value = ''; i.focus(); }

function flash(kind, text) {
  const el = $('#scanFlash'); if (!el) return;
  el.innerHTML = `<div class="flash ${kind}">${esc(text)}</div>`;
  beep(kind === 'found' ? 880 : kind === 'repeat' ? 520 : 240, kind === 'found' ? 120 : 300);
  navigator.vibrate?.(kind === 'found' ? 80 : [80, 60, 80]);
}

let audioCtx;
function beep(freq, ms) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.15; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* звук необязателен */ }
}

async function toggleCamera(onCode = submitScan) {
  if (scanner) { stopScanner(); return; }
  if (!window.isSecureContext) {
    alert('Камера в браузере работает только по защищённому адресу https://');
    return;
  }
  if (typeof Html5Qrcode === 'undefined') { alert('Модуль сканера не загрузился'); return; }
  scanner = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      text => onCode(text), () => {});
    const b = $('#camBtn'); if (b) b.textContent = 'Выключить камеру';
  } catch (e) {
    scanner = null;
    alert('Не удалось включить камеру: ' + (e?.message || e) + '\nРазрешите доступ к камере в настройках браузера.');
  }
}
function stopScanner() {
  if (!scanner) return;
  const s = scanner; scanner = null;
  s.stop().catch(() => {}).finally(() => { try { s.clear(); } catch { } });
  const b = $('#camBtn'); if (b) b.textContent = 'Включить камеру';
}

async function unscan(inv) { await act(() => api('DELETE', `/api/audits/${S.audit.id}/scan/${encodeURIComponent(inv)}`)); reloadAudit(); }
async function moveHere(inv, roomCode) {
  const room = S.meta.rooms.find(r => r.code === roomCode), a = S.assets.find(x => x.inv === inv);
  if (!confirm(`Переместить ${a.name} (${inv}) в кабинет ${roomCode}?`)) return;
  await act(() => api('POST', `/api/assets/${encodeURIComponent(inv)}/move`, { room_id: room.id, employee_id: a.employee_id, reason: 'По итогам инвентаризации: ' + S.audit.name }), 'Перемещено');
  await loadAssets(); reloadAudit();
}
async function closeAudit(id) {
  const missing = S.audit.total - S.audit.found;
  if (!confirm(`Завершить инвентаризацию?${missing ? ` Не найдено: ${missing}.` : ''} После завершения отметки менять нельзя.`)) return;
  await act(() => api('POST', `/api/audits/${id}/close`), 'Инвентаризация завершена'); route();
}
async function deleteAudit(id) {
  if (!confirm('Удалить инвентаризацию со всеми отметками?')) return;
  await act(() => api('DELETE', '/api/audits/' + id), 'Удалено'); location.hash = '#/audits';
}

// ----- сканер для поиска (вне инвентаризации) -----
VIEWS.scan = async () => `<h1>Сканер QR</h1>
  <div class="panel scanbox"><p class="muted">Наведите камеру на наклейку — откроется карточка техники.</p>
  <div class="btnrow"><button class="primary" id="camBtn" onclick="toggleCamera(openScanned)">Включить камеру</button></div>
  <div id="reader"></div>
  <div class="toolbar"><input id="lookup" placeholder="или введите инвентарный номер" onkeydown="if(event.key==='Enter')openScanned(this.value)" style="flex:1"><button onclick="openScanned($('#lookup').value)">Найти</button></div></div>`;
AFTER.scan = () => { if (window.isSecureContext) toggleCamera(openScanned); };

function openScanned(text) {
  const m = String(text).match(/\/a\/([^/?#\s]+)/);
  const inv = (m ? m[1] : String(text)).trim();
  if (!inv) return;
  if (!S.assets.some(a => a.inv === inv)) { beep(240, 300); toast('Номер ' + inv + ' не найден в базе'); return; }
  beep(880, 120); stopScanner(); location.hash = '#/a/' + encodeURIComponent(inv);
}

// ----- история -----
VIEWS.history = async () => {
  const [events, moves] = await Promise.all([api('GET', '/api/events?limit=1000'), api('GET', '/api/movements')]);
  S.histEvents = events;
  return `<div class="top"><h1>История</h1><button onclick="download('history')">⇩ Excel</button></div>
  <div class="panel"><h2>Перемещения техники</h2><div class="scroll"><table><tr><th>Дата</th><th>Инв. №</th><th>Наименование</th><th>Откуда</th><th>Куда</th><th class="hide-sm">Основание</th><th class="hide-sm">Кто</th></tr>
    ${moves.slice(0, 300).map(m => `<tr class="clickable" onclick="location.hash='#/a/${encodeURIComponent(m.inv)}'"><td class="num">${esc(m.at)}</td><td class="num">${esc(m.inv)}</td><td>${esc(m.name)}</td>
      <td>${esc(m.from_room || '—')} <small class="muted">${esc(m.from_employee)}</small></td><td>${esc(m.to_room || '—')} <small class="muted">${esc(m.to_employee)}</small></td>
      <td class="hide-sm">${esc(m.reason)}</td><td class="hide-sm">${esc(m.user)}</td></tr>`).join('')}</table>
    ${moves.length ? '' : '<div class="empty">Перемещений пока нет</div>'}</div></div>
  <div class="panel"><h2>Журнал всех операций</h2><input type="search" placeholder="Фильтр…" style="width:100%" oninput="filterEvents(this.value)">
    <div class="scroll"><table><thead><tr><th>Дата</th><th>Операция</th><th>Объект</th><th>Подробности</th><th class="hide-sm">Кто</th></tr></thead><tbody id="evRows"></tbody></table></div></div>`;
};
AFTER.history = () => filterEvents('');
function filterEvents(q) {
  q = q.toLowerCase();
  $('#evRows').innerHTML = S.histEvents.filter(e => !q || [e.type, e.ref, e.details, e.user].join(' ').toLowerCase().includes(q)).slice(0, 500)
    .map(e => `<tr><td class="num">${esc(e.at)}</td><td>${esc(e.type)}</td><td>${esc(e.ref)}</td><td>${esc(e.details)}</td><td class="hide-sm">${esc(e.user)}</td></tr>`).join('');
}

// ----- отчёты -----
VIEWS.reports = async () => {
  const A = S.assets, by = k => A.reduce((m, a) => (m[a[k] || '—'] = (m[a[k] || '—'] || 0) + 1, m), {});
  const tbl = (title, obj) => `<div class="panel"><h3>${title}</h3><table>${Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num"><b>${v}</b></td></tr>`).join('')}</table></div>`;
  const rep = (kind, icon, name, desc) => `<button style="min-height:96px;text-align:left" onclick="download('${kind}')"><span class="qico">${icon}</span><b>${name}</b><br><small class="muted">${desc}</small></button>`;
  return `<h1>Отчёты</h1>
  <div class="panel"><h2>Выгрузка в Excel</h2><div class="quickgrid">
    ${rep('assets', '📄', 'Реестр ОС', 'Вся техника со всеми полями')}${rep('rooms', '🚪', 'По кабинетам', 'Отдельный лист на каждый кабинет')}
    ${rep('employees', '👥', 'По сотрудникам', 'Что за кем закреплено')}${rep('writeoff', '🛠️', 'Списание и неисправные', 'Кандидаты на списание')}
    ${rep('stock', '📦', 'ТМЗ', 'Остатки и движение')}${rep('history', '🕘', 'История', 'Перемещения и журнал')}</div></div>
  <div class="dash-two">${tbl('По состоянию', by('condition'))}${tbl('По статусу', by('status'))}</div>
  <div class="dash-two">${tbl('По категориям', by('category'))}${tbl('По кабинетам', by('room'))}</div>`;
};

// ----- настройки -----
VIEWS.settings = async () => {
  const adm = isAdmin();
  const users = adm ? await api('GET', '/api/users') : [];
  return `<h1>Настройки</h1>
  <div class="panel"><h2>📱 Как пользоваться с телефона</h2>
    <ol><li>Откройте на телефоне <b>${esc(siteUrl())}</b> и войдите.</li>
    <li>В меню браузера выберите <b>«Добавить на главный экран» / «Установить приложение»</b> — появится иконка ӨRLEU BASE.</li>
    <li>Наклейки можно сканировать встроенным сканером (раздел «Сканер QR») или обычной камерой телефона — откроется карточка техники.</li></ol></div>
  ${adm ? `<div class="panel"><h2>🔳 Адрес в QR-кодах</h2>
    <p>QR-код на наклейке ведёт на <b>${esc(assetUrl('<инв. номер>'))}</b>. Адрес совпадает с адресом сайта. Не переименовывайте репозиторий и аккаунт GitHub после печати наклеек.</p></div>
  <div class="panel"><h2>👤 Пользователи</h2>
    <p class="muted"><b>Администратор</b> — всё: перемещение, изменение, инвентаризация, удаление. <b>Просмотр</b> — только смотреть, где что находится.</p>
    <div class="scroll"><table><tr><th>Почта</th><th>Имя</th><th>Роль</th><th></th></tr>${users.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.full_name)}</td>
      <td>${u.role === 'admin' ? '<span class="badge b-blue">администратор</span>' : '<span class="badge b-gray">просмотр</span>'}</td>
      <td><button onclick="editUser('${esc(u.id)}')">✎</button></td></tr>`).join('')}</table></div>
    <div class="note"><b>Как добавить пользователя:</b> Supabase → Authentication → Users → <b>Add user → Create new user</b>: почта, пароль, галочка «Auto Confirm User».
      Новый пользователь появится здесь с ролью «просмотр» — нажмите ✎, чтобы дать права администратора.
      Почта может быть условной, например <code>ivanov@orleu.kz</code>.</div></div>
  <div class="panel"><h2>💾 Резервная копия</h2><p>Скачивает все данные (технику, кабинеты, сотрудников, ТМЗ, историю, инвентаризации) в один Excel-файл. Делайте копию хотя бы раз в неделю и храните на флешке или в облаке.</p>
    <div class="btnrow"><button class="primary" onclick="act(backupAll)">⬇ Скачать копию базы</button></div></div>` :
  `<div class="panel"><h2>Доступ</h2><p>У вас доступ <b>только для просмотра</b>. Для изменений обратитесь к администратору.</p></div>`}
  <div class="panel"><h2>🔑 Мой пароль</h2><button onclick="changeMyPassword()">Сменить пароль</button></div>`;
};

async function editUser(id) {
  const u = (await api('GET', '/api/users')).find(x => x.id === id);
  dialog('Пользователь ' + esc(u.email),
    field('Имя', 'full_name', u.full_name || '') +
    select('Роль', 'role', `<option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Просмотр</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option>`),
    async f => { await api('PUT', '/api/users/' + u.id, f); toast('Сохранено'); await loadMeta(); route(); });
}
function changeMyPassword() {
  dialog('Смена пароля', field('Новый пароль (от 6 символов) *', 'password', '', 'password', 'required minlength="6" full'),
    async f => {
      const { error } = await sb.auth.updateUser({ password: f.password });
      if (error) throw new Error(error.message);
      toast('Пароль изменён');
    });
}

// ---------- QR-коды и наклейки ----------
function assetUrl(inv) { return siteUrl() + '#/a/' + inv; }

function qrSvg(text, cell = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 1, scalable: true });
}

function openLabels(invs) {
  const set = new Set(invs);
  S.labelItems = S.assets.filter(a => set.has(a.inv) && a.category !== 'Программное обеспечение' && a.status !== 'Списана');
  if (!S.labelItems.length) return alert('Нет техники для печати');
  location.hash = '#/labels';
}

VIEWS.labels = async () => {
  const items = S.labelItems || [];
  const size = S.labelSize || 'm';
  const [w, qrmm, cols] = { s: [48, 22, 4], m: [63, 30, 3], l: [95, 45, 2] }[size];
  return `<div class="btnrow no-print"><button onclick="history.back()">← Назад</button>
    <button class="primary" onclick="print()">🖨 Печать (${items.length} шт.)</button>
    <span class="seg">${[['s', 'мелкие'], ['m', 'средние'], ['l', 'крупные']].map(([k, n]) =>
      `<button class="${k === size ? 'on' : ''}" onclick="S.labelSize='${k}';route()">${n}</button>`).join('')}</span></div>
  <p class="muted no-print">В окне печати выберите масштаб 100% и отключите колонтитулы. QR ведёт на ${esc(assetUrl('…'))}</p>
  <div class="labels" style="grid-template-columns:repeat(${cols},${w}mm)">${items.map(a => `<div class="label">
    <div class="lqr" style="width:${qrmm}mm;height:${qrmm}mm">${qrSvg(assetUrl(a.inv))}</div>
    <div class="ltxt ${size}"><div class="lorg">ӨРЛЕУ · Акмолинская обл.</div><div class="linv">${esc(a.inv)}</div>
    <div class="lname">${esc(a.name)}</div><div class="lroom">${a.room ? 'Каб. ' + esc(a.room) : ''}</div></div></div>`).join('')}</div>`;
};
AFTER.labels = () => document.body.classList.add('printing-labels');
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/labels')) document.body.classList.remove('printing-labels'); });

// ---------- Excel ----------
function xlsxDownload(sheets, filename) {
  if (typeof XLSX === 'undefined') throw new Error('Модуль Excel ещё загружается, попробуйте через секунду');
  const wb = XLSX.utils.book_new();
  for (const [name, rows, colWidths] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (colWidths) ws['!cols'] = colWidths.map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  }
  XLSX.writeFile(wb, filename);
}
const today = () => new Date().toISOString().slice(0, 10);
const REPORT_COLS = [['inv', 'Инв. номер', 16], ['name', 'Наименование', 42], ['category', 'Категория', 20], ['room', 'Кабинет', 12],
  ['employee', 'Закреплено за', 30], ['condition', 'Состояние', 16], ['status', 'Статус', 22], ['serial', 'Серийный №', 16],
  ['acquired', 'Дата поступления', 14], ['cost', 'Первонач. стоимость', 16], ['residual', 'Остаточная стоимость', 16], ['mol', 'МОЛ', 28], ['notes', 'Примечание', 40]];
const toRows = (cols, list) => [cols.map(c => c[1]), ...list.map(x => cols.map(c => x[c[0]] ?? ''))];
const widthsOf = cols => cols.map(c => c[2]);

async function exportReport(kind) {
  await loadAssets();
  const A = S.assets;
  if (kind === 'assets') return xlsxDownload([['Реестр ОС', toRows(REPORT_COLS, A), widthsOf(REPORT_COLS)]], `Реестр ОС ${today()}.xlsx`);
  if (kind === 'rooms') {
    const codes = [...new Set(A.map(a => a.room || 'Без кабинета'))].sort((x, y) => byRoom({ code: x }, { code: y }));
    const cols = REPORT_COLS.filter(c => !['room', 'mol'].includes(c[0]));
    return xlsxDownload([['Сводка', [['Кабинет', 'Единиц ОС'], ...codes.map(c => [c, A.filter(a => (a.room || 'Без кабинета') === c).length])], [18, 12]],
      ...codes.map(c => ['Каб ' + c, toRows(cols, A.filter(a => (a.room || 'Без кабинета') === c)), widthsOf(cols)])], `ОС по кабинетам ${today()}.xlsx`);
  }
  if (kind === 'employees') {
    const cols = [['employee', 'Сотрудник', 32], ...REPORT_COLS.filter(c => !['employee', 'mol'].includes(c[0]))];
    const list = A.filter(a => a.employee).sort((x, y) => x.employee.localeCompare(y.employee) || x.inv.localeCompare(y.inv));
    return xlsxDownload([['По сотрудникам', toRows(cols, list), widthsOf(cols)]], `ОС по сотрудникам ${today()}.xlsx`);
  }
  if (kind === 'writeoff') {
    const list = A.filter(a => ['Предлагается к списанию', 'Списана'].includes(a.status) || a.condition === 'Неисправна');
    return xlsxDownload([['К списанию и неисправные', toRows(REPORT_COLS, list), widthsOf(REPORT_COLS)]], `Списание и неисправные ${today()}.xlsx`);
  }
  if (kind === 'stock') {
    const items = await api('GET', '/api/stock');
    const moves = withAt(await q(sb.from('stock_moves').select('*, stock_items(name)').order('id', { ascending: false }).limit(1000)))
      .map(m => ({ ...m, name: m.stock_items?.name }));
    const c1 = [['name', 'Наименование', 50], ['unit', 'Ед.', 8], ['qty', 'Остаток', 10], ['min_qty', 'Мин. остаток', 12], ['room', 'Где хранится', 14], ['notes', 'Примечание', 40]];
    const c2 = [['at', 'Дата', 18], ['name', 'Наименование', 44], ['delta', 'Количество', 12], ['counterpart', 'Кому / от кого', 30], ['note', 'Примечание', 30], ['user', 'Кто', 22]];
    return xlsxDownload([['ТМЗ', toRows(c1, items), widthsOf(c1)], ['Движение ТМЗ', toRows(c2, moves), widthsOf(c2)]], `ТМЗ ${today()}.xlsx`);
  }
  if (kind === 'history') {
    const [moves, events] = await Promise.all([api('GET', '/api/movements'), api('GET', '/api/events?limit=1000')]);
    const c1 = [['at', 'Дата', 18], ['inv', 'Инв. номер', 16], ['name', 'Наименование', 40], ['from_room', 'Из кабинета', 12], ['to_room', 'В кабинет', 12],
      ['from_employee', 'От кого', 28], ['to_employee', 'Кому', 28], ['reason', 'Основание', 30], ['user', 'Кто', 22]];
    const c2 = [['at', 'Дата', 18], ['type', 'Операция', 28], ['ref', 'Объект', 30], ['details', 'Подробности', 60], ['user', 'Кто', 22]];
    return xlsxDownload([['Перемещения', toRows(c1, moves), widthsOf(c1)], ['Журнал', toRows(c2, events), widthsOf(c2)]], `История ${today()}.xlsx`);
  }
}

async function exportAudit(id) {
  const st = await api('GET', '/api/audits/' + id);
  const rows = st.expected.map(x => ({ ...x, result: !x.scanned_at ? 'Не найдено' : (st.room_id && x.found_room && x.found_room !== x.room ? 'Найдено в каб. ' + x.found_room : 'Найдено') }))
    .concat(st.extra.map(x => ({ ...x, result: 'Лишнее: числится в каб. ' + (x.room || '—') })));
  const cols = [['inv', 'Инв. номер', 16], ['name', 'Наименование', 42], ['room', 'Кабинет по учёту', 14], ['employee', 'Закреплено за', 28],
    ['result', 'Результат', 28], ['scanned_at', 'Когда отмечено', 18], ['scanned_by', 'Кто отметил', 22]];
  const head = [[`${st.name} — кабинет: ${st.room || 'все'}; найдено ${st.found} из ${st.total}, лишних ${st.extra.length}`], []];
  xlsxDownload([['Результат', [...head, ...toRows(cols, rows)], widthsOf(cols)],
    ['Не найдено', toRows(cols, rows.filter(r => r.result === 'Не найдено')), widthsOf(cols)]], `Инвентаризация ${st.id} ${today()}.xlsx`);
}

async function backupAll() {
  const tables = ['assets', 'rooms', 'employees', 'movements', 'stock_items', 'stock_moves', 'audits', 'audit_scans', 'events', 'profiles'];
  const data = await Promise.all(tables.map(t => all(t)));
  xlsxDownload(tables.map((t, i) => {
    const rows = data[i];
    const keys = rows.length ? Object.keys(rows[0]) : ['(пусто)'];
    return [t, [keys, ...rows.map(r => keys.map(k => r[k] ?? ''))]];
  }), `ORLEU BASE резервная копия ${today()}.xlsx`);
}

// ---------- старт ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
sb?.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') showLogin(); });
boot();
