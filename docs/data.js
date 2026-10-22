'use strict';
/* Слой данных: те же запросы, что раньше обслуживал сервер, теперь выполняются в базе Supabase.
   Права проверяет сама база (RLS + функции в supabase/schema.sql), а не браузер. */

const CFG = window.ORLEU_CONFIG || {};
const sb = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY
  ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const CONDITIONS = ['Не проверено', 'Исправна', 'Неисправна', 'Требует ремонта'];
const STATUSES = ['В эксплуатации', 'На складе', 'Предлагается к списанию', 'Списана'];
const CATEGORIES = ['Компьютеры', 'Моноблоки', 'Ноутбуки', 'Принтеры и МФУ', 'Мониторы', 'Интерактивные панели', 'Проекторы',
  'Сетевое оборудование', 'Аудио и видео', 'Робототехника', 'Программное обеспечение', 'Прочая техника'];

class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function pgMessage(error) {
  if (!error) return '';
  const m = error.message || String(error);
  if (error.code === '23505') return 'Такая запись уже есть (номер или название повторяется)';
  if (error.code === '23514') return 'Недопустимое значение поля';
  if (error.code === '23503') return 'Запись используется в других данных — сначала уберите связи';
  if (error.code === '42501' || /row-level security/i.test(m)) return 'Недостаточно прав: доступ только для просмотра';
  if (/JWT|not authenticated/i.test(m)) return 'Требуется вход';
  return m;
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new ApiError(pgMessage(error), error.code === 'PGRST301' ? 401 : 400);
  return data;
}

// Supabase отдаёт не больше 1000 строк за запрос — читаем частями
async function all(table, columns = '*', build = x => x) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const part = await q(build(sb.from(table).select(columns)).range(from, from + 999));
    out.push(...part);
    if (part.length < 1000) return out;
  }
}

const roomSortKey = c => /^\d+$/.test(c) ? [0, Number(c), ''] : [1, 0, c.toLowerCase()];
const byRoom = (a, b) => { const x = roomSortKey(a.code), y = roomSortKey(b.code); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };

async function currentUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new ApiError('Требуется вход', 401);
  const p = await q(sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  return { id: session.user.id, username: session.user.email, email: session.user.email,
           full_name: p?.full_name || '', role: p?.role || 'viewer' };
}

function flatAsset(a) {
  const { rooms, employees, ...rest } = a;
  return { ...rest, room: rooms?.code || null, room_name: rooms?.name || null, employee: employees?.full_name || null };
}
const ASSET_COLS = '*, rooms(code, name), employees(full_name)';

async function assetsAll() {
  const [assets, photos] = await Promise.all([all('assets', ASSET_COLS, b => b.order('inv')), all('asset_photos', 'asset_id, path', b => b.order('id'))]);
  // миниатюра в списке — первое фото каждой единицы
  const first = new Map();
  for (const p of photos) if (!first.has(p.asset_id)) first.set(p.asset_id, p.path);
  const urls = await signedUrls([...first.values()]);
  return assets.map(a => ({ ...flatAsset(a), photo_url: urls.get(first.get(a.id)) || null }));
}

// ---------- фото ----------
const PHOTO_BUCKET = 'asset-photos';
// хранилище закрытое: ссылки на фото временные (действуют час) и выдаются только вошедшим
async function signedUrls(paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 100) {
    const part = paths.slice(i, i + 100);
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(part, 3600);
    if (error) throw new ApiError(pgMessage(error));
    for (const d of data || []) if (d.signedUrl) out.set(d.path, d.signedUrl);
  }
  return out;
}
async function assetPhotos(assetId) {
  const rows = await q(sb.from('asset_photos').select('*').eq('asset_id', assetId).order('id'));
  const urls = await signedUrls(rows.map(r => r.path));
  return rows.map(r => ({ id: r.id, url: urls.get(r.path) || '', at: fmt(r.created_at), user: r.user }));
}
async function removeFiles(paths) {
  if (!paths.length) return;
  const { error } = await sb.storage.from(PHOTO_BUCKET).remove(paths);
  if (error) console.warn('Фото не удалены из хранилища:', error.message);
}
async function assetByInv(inv) {
  const a = await q(sb.from('assets').select(ASSET_COLS).eq('inv', inv).maybeSingle());
  if (!a) throw new ApiError(`Инвентарный номер ${inv} не найден`, 404);
  return flatAsset(a);
}

async function roomsList() {
  const [rooms, assets, stock] = await Promise.all([all('rooms'), all('assets', 'room_id'), all('stock_items', 'room_id')]);
  const cnt = (list, id) => list.filter(x => x.room_id === id).length;
  return rooms.map(r => ({ ...r, assets: cnt(assets, r.id), stock: cnt(stock, r.id) })).sort(byRoom);
}
async function employeesList() {
  const [emps, assets] = await Promise.all([all('employees', '*, rooms(code)', b => b.order('full_name')), all('assets', 'employee_id')]);
  return emps.map(({ rooms, ...e }) => ({ ...e, room: rooms?.code || null, assets: assets.filter(a => a.employee_id === e.id).length }));
}

const ASSET_FIELDS = ['inv', 'name', 'category', 'room_id', 'employee_id', 'mol', 'condition', 'status', 'serial', 'acquired', 'cost', 'residual', 'notes'];
function assetPayload(body) {
  const out = {};
  for (const k of ASSET_FIELDS) if (k in body) out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
  if (!out.inv) throw new ApiError('Укажите инвентарный номер');
  if (!out.name) throw new ApiError('Укажите наименование');
  return out;
}

async function auditState(id) {
  const au = await q(sb.from('audits').select('*, rooms(code)').eq('id', id).maybeSingle());
  if (!au) throw new ApiError('Инвентаризация не найдена', 404);
  const [assets, scans, rooms] = await Promise.all([assetsAll(), all('audit_scans', '*', b => b.eq('audit_id', id)), all('rooms')]);
  const code = rid => rooms.find(r => r.id === rid)?.code || null;
  const byAsset = new Map(scans.map(s => [s.asset_id, s]));
  const expected = assets
    .filter(a => a.status !== 'Списана' && a.category !== 'Программное обеспечение' && (!au.room_id || a.room_id === au.room_id))
    .map(a => { const s = byAsset.get(a.id); return { inv: a.inv, name: a.name, category: a.category, condition: a.condition, room: a.room, employee: a.employee,
      scanned_at: s ? fmt(s.at) : null, scanned_by: s?.user || null, found_room: s ? code(s.found_room_id) : null }; })
    .sort((x, y) => byRoom({ code: x.room || '~' }, { code: y.room || '~' }) || x.inv.localeCompare(y.inv));
  const expectedInv = new Set(expected.map(x => x.inv));
  const extra = scans.map(s => ({ s, a: assets.find(a => a.id === s.asset_id) })).filter(x => x.a && !expectedInv.has(x.a.inv))
    .map(({ s, a }) => ({ inv: a.inv, name: a.name, room: a.room, scanned_at: fmt(s.at), scanned_by: s.user, found_room: code(s.found_room_id) }));
  const { rooms: r, ...rest } = au;
  return { ...rest, room: r?.code || null, created_at: fmt(au.created_at), closed_at: au.closed_at ? fmt(au.closed_at) : null,
           expected, extra, found: expected.filter(x => x.scanned_at).length, total: expected.length };
}

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const withAt = list => list.map(x => ({ ...x, at: fmt(x.at) }));

// ---------- маршруты (повторяют прежний REST API) ----------
const ROUTES = [
  ['GET', /^\/api\/meta$/, async () => {
    const [user, rooms, employees] = await Promise.all([currentUser(), roomsList(), employeesList()]);
    return { user, rooms, employees, conditions: CONDITIONS, statuses: STATUSES, categories: CATEGORIES, base_url: siteUrl() };
  }],

  // основные средства
  ['GET', /^\/api\/assets$/, assetsAll],
  ['GET', /^\/api\/assets\/([^/]+)$/, async inv => {
    const a = await assetByInv(inv);
    const [movements, events, audits, scans] = await Promise.all([
      q(sb.from('movements').select('*').eq('asset_id', a.id).order('id', { ascending: false })),
      q(sb.from('events').select('*').eq('ref', inv).order('id', { ascending: false }).limit(50)),
      q(sb.from('audits').select('id, name, rooms(code)').is('closed_at', null).order('id', { ascending: false })),
      q(sb.from('audit_scans').select('audit_id').eq('asset_id', a.id)),
    ]);
    const scanned = new Set(scans.map(s => s.audit_id));
    a.movements = withAt(movements);
    a.events = withAt(events);
    a.open_audits = audits.map(o => ({ id: o.id, name: o.name, room: o.rooms?.code || null, scanned: scanned.has(o.id) }));
    a.updated_at = fmt(a.updated_at);
    a.photos = await assetPhotos(a.id);
    return a;
  }],
  ['POST', /^\/api\/assets\/([^/]+)\/photos$/, async (inv, body) => {
    const a = await assetByInv(inv);
    const path = `${a.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, body.blob, { contentType: 'image/jpeg' });
    if (error) throw new ApiError(/row-level security|Unauthorized|403/i.test(error.message) ? 'Недостаточно прав: доступ только для просмотра' : error.message);
    try { await q(sb.from('asset_photos').insert({ asset_id: a.id, path })); }
    catch (e) { await removeFiles([path]); throw e; }
    return { ok: true };
  }],
  ['DELETE', /^\/api\/photos\/(\d+)$/, async id => {
    const rows = await q(sb.from('asset_photos').delete().eq('id', id).select('path'));
    if (!rows.length) throw new ApiError('Недостаточно прав или запись не найдена', 403);
    await removeFiles(rows.map(r => r.path));
    return { ok: true };
  }],
  ['POST', /^\/api\/assets$/, async (body) => {
    const row = await q(sb.from('assets').insert(assetPayload(body)).select('inv').single());
    return assetByInv(row.inv);
  }],
  ['PUT', /^\/api\/assets\/([^/]+)$/, async (inv, body) => {
    const before = await assetByInv(inv);
    const payload = assetPayload(body);
    const moving = payload.room_id !== before.room_id || payload.employee_id !== before.employee_id;
    if (moving) {
      // перемещение — отдельной операцией, чтобы в историю попало основание
      await q(sb.rpc('move_asset', { p_inv: inv, p_room: payload.room_id, p_employee: payload.employee_id, p_reason: body.reason || '' }));
    }
    const rows = await q(sb.from('assets').update(payload).eq('id', before.id).select('inv'));
    if (!rows.length) throw new ApiError('Недостаточно прав: доступ только для просмотра', 403);
    return assetByInv(rows[0].inv);
  }],
  ['POST', /^\/api\/assets\/([^/]+)\/move$/, async (inv, body) => {
    await q(sb.rpc('move_asset', { p_inv: inv, p_room: body.room_id ?? null, p_employee: body.employee_id ?? null, p_reason: body.reason || '' }));
    return assetByInv(inv);
  }],
  ['DELETE', /^\/api\/assets\/([^/]+)$/, async inv => {
    const a = await assetByInv(inv);
    const photos = await q(sb.from('asset_photos').select('path').eq('asset_id', a.id));
    const rows = await q(sb.from('assets').delete().eq('id', a.id).select('id'));
    if (rows.length) await removeFiles(photos.map(p => p.path));
    if (!rows.length) throw new ApiError('Недостаточно прав или запись не найдена', 403);
    return { ok: true };
  }],

  // кабинеты
  ['GET', /^\/api\/rooms$/, roomsList],
  ['POST', /^\/api\/rooms$/, async body => q(sb.from('rooms').insert({ code: body.code.trim(), name: (body.name || '').trim() }).select('id').single())],
  ['PUT', /^\/api\/rooms\/(\d+)$/, async (id, body) => mustChange(sb.from('rooms').update({ code: body.code.trim(), name: (body.name || '').trim() }).eq('id', id))],
  ['DELETE', /^\/api\/rooms\/(\d+)$/, async id => {
    const r = (await roomsList()).find(x => x.id === Number(id));
    if (r && (r.assets || r.stock)) throw new ApiError('В кабинете есть техника или ТМЗ — сначала переместите их');
    return mustChange(sb.from('rooms').delete().eq('id', id));
  }],

  // сотрудники
  ['GET', /^\/api\/employees$/, employeesList],
  ['POST', /^\/api\/employees$/, async body => q(sb.from('employees').insert(employeePayload(body)).select('id').single())],
  ['PUT', /^\/api\/employees\/(\d+)$/, async (id, body) => mustChange(sb.from('employees').update(employeePayload(body)).eq('id', id))],
  ['DELETE', /^\/api\/employees\/(\d+)$/, async id => {
    const n = (await q(sb.from('assets').select('id').eq('employee_id', id))).length;
    if (n) throw new ApiError('За сотрудником закреплена техника — сначала переместите её');
    return mustChange(sb.from('employees').delete().eq('id', id));
  }],

  // ТМЗ
  ['GET', /^\/api\/stock$/, async () => (await all('stock_items', '*, rooms(code)', b => b.order('name'))).map(({ rooms, ...s }) => ({ ...s, qty: Number(s.qty), min_qty: Number(s.min_qty), room: rooms?.code || null }))],
  ['GET', /^\/api\/stock\/(\d+)\/moves$/, async id => withAt(await q(sb.from('stock_moves').select('*').eq('item_id', id).order('id', { ascending: false })))],
  ['POST', /^\/api\/stock$/, async body => q(sb.from('stock_items').insert(stockPayload(body)).select('id').single())],
  ['PUT', /^\/api\/stock\/(\d+)$/, async (id, body) => mustChange(sb.from('stock_items').update(stockPayload(body)).eq('id', id))],
  ['POST', /^\/api\/stock\/(\d+)\/move$/, async (id, body) => q(sb.rpc('stock_move', { p_item: Number(id), p_delta: body.delta, p_counterpart: body.counterpart || '', p_note: body.note || '' }))],
  ['DELETE', /^\/api\/stock\/(\d+)$/, async id => mustChange(sb.from('stock_items').delete().eq('id', id))],

  // инвентаризация
  ['GET', /^\/api\/audits$/, async () => {
    const list = await q(sb.from('audits').select('id').order('id', { ascending: false }));
    return Promise.all(list.map(a => auditState(a.id)));
  }],
  ['POST', /^\/api\/audits$/, async body => {
    const me = await currentUser();
    return q(sb.from('audits').insert({ name: body.name.trim(), room_id: body.room_id ?? null, created_by: me.full_name || me.email }).select('id').single());
  }],
  ['GET', /^\/api\/audits\/(\d+)$/, auditState],
  ['POST', /^\/api\/audits\/(\d+)\/scan$/, async (id, body) => q(sb.rpc('audit_scan', { p_audit: Number(id), p_code: body.code, p_room: body.room_id ?? null }))],
  ['DELETE', /^\/api\/audits\/(\d+)\/scan\/([^/]+)$/, async (id, inv) => {
    const a = await assetByInv(inv);
    return mustChange(sb.from('audit_scans').delete().eq('audit_id', id).eq('asset_id', a.id));
  }],
  ['POST', /^\/api\/audits\/(\d+)\/close$/, async id => q(sb.rpc('audit_close', { p_audit: Number(id) }))],
  ['DELETE', /^\/api\/audits\/(\d+)$/, async id => mustChange(sb.from('audits').delete().eq('id', id))],

  // история
  ['GET', /^\/api\/events$/, async (params) => withAt(await q(sb.from('events').select('*').order('id', { ascending: false }).limit(Math.min(Number(params.limit) || 500, 1000))))],
  ['GET', /^\/api\/movements$/, async () => withAt((await q(sb.from('movements').select('*, assets(inv, name)').order('id', { ascending: false }).limit(1000)))
    .map(({ assets, ...m }) => ({ ...m, inv: assets?.inv, name: assets?.name })))],

  // пользователи
  ['GET', /^\/api\/users$/, async () => (await q(sb.from('profiles').select('*').order('email'))).map(p => ({ ...p, username: p.email }))],
  ['PUT', /^\/api\/users\/([\w-]+)$/, async (id, body) => {
    const me = await currentUser();
    if (body.password) {
      if (id !== me.id) throw new ApiError('Пароль другого пользователя меняется в Supabase → Authentication → Users');
      if (body.password.length < 6) throw new ApiError('Пароль — не короче 6 символов');
      const { error } = await sb.auth.updateUser({ password: body.password });
      if (error) throw new ApiError(pgMessage(error));
    }
    return mustChange(sb.from('profiles').update({ full_name: (body.full_name || '').trim(), role: body.role }).eq('id', id));
  }],
  ['DELETE', /^\/api\/users\/([\w-]+)$/, async id => mustChange(sb.from('profiles').update({ role: 'viewer' }).eq('id', id))],
];

function employeePayload(b) {
  const name = (b.full_name || '').trim();
  if (name.length < 2) throw new ApiError('Укажите ФИО');
  return { full_name: name, department: (b.department || '').trim(), position: (b.position || '').trim(), room_id: b.room_id ?? null, phone: (b.phone || '').trim() };
}
function stockPayload(b) {
  if (!(b.name || '').trim()) throw new ApiError('Укажите наименование');
  if (!(b.qty >= 0) || !(b.min_qty >= 0)) throw new ApiError('Количество не может быть отрицательным');
  return { name: b.name.trim(), unit: (b.unit || '').trim() || 'шт.', qty: b.qty, min_qty: b.min_qty, room_id: b.room_id ?? null, notes: (b.notes || '').trim() };
}

async function mustChange(builder) {
  const rows = await q(builder.select());
  if (!rows.length) throw new ApiError('Недостаточно прав или запись не найдена', 403);
  return { ok: true };
}

function siteUrl() {
  return (CFG.SITE_URL || (location.origin + location.pathname)).replace(/index\.html$/, '').replace(/\/?$/, '/');
}

async function api(method, url, body) {
  if (!sb) throw new ApiError('Программа не подключена к базе: заполните docs/config.js (см. README)', 500);
  const [path, query = ''] = url.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  for (const [m, re, handler] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    const args = match.slice(1).map(decodeURIComponent);
    try {
      return await (method === 'GET' && !args.length ? handler(params) : body !== undefined ? handler(...args, body) : handler(...args, params));
    } catch (e) {
      if (e.status === 401) { showLogin(); }
      throw e;
    }
  }
  throw new ApiError(`Неизвестная операция ${method} ${path}`, 404);
}
