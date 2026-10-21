-- ӨRLEU BASE — схема базы для Supabase.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Повторный запуск безопасен: создаёт только то, чего ещё нет.

-- ---------- справочники ----------
create table if not exists public.rooms (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null default '',
  sort int not null default 0
);

create table if not exists public.employees (
  id bigint generated always as identity primary key,
  full_name text not null unique,
  department text not null default '',
  position text not null default '',
  room_id bigint references public.rooms(id) on delete set null,
  phone text not null default ''
);

-- ---------- основные средства ----------
create table if not exists public.assets (
  id bigint generated always as identity primary key,
  inv text not null unique,
  name text not null,
  category text not null default 'Прочая техника',
  room_id bigint references public.rooms(id) on delete set null,
  employee_id bigint references public.employees(id) on delete set null,
  mol text not null default '',
  condition text not null default 'Не проверено'
    check (condition in ('Не проверено', 'Исправна', 'Неисправна', 'Требует ремонта')),
  status text not null default 'В эксплуатации'
    check (status in ('В эксплуатации', 'На складе', 'Предлагается к списанию', 'Списана')),
  serial text not null default '',
  acquired text not null default '',
  cost numeric,
  residual numeric,
  notes text not null default '',
  source text not null default 'Вручную',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assets_room on public.assets(room_id);
create index if not exists assets_employee on public.assets(employee_id);

create table if not exists public.movements (
  id bigint generated always as identity primary key,
  asset_id bigint not null references public.assets(id) on delete cascade,
  at timestamptz not null default now(),
  "user" text not null default '',
  from_room text not null default '',
  to_room text not null default '',
  from_employee text not null default '',
  to_employee text not null default '',
  reason text not null default ''
);
create index if not exists movements_asset on public.movements(asset_id);

-- ---------- ТМЗ ----------
create table if not exists public.stock_items (
  id bigint generated always as identity primary key,
  name text not null,
  unit text not null default 'шт.',
  qty numeric not null default 0 check (qty >= 0),
  min_qty numeric not null default 0 check (min_qty >= 0),
  room_id bigint references public.rooms(id) on delete set null,
  notes text not null default ''
);

create table if not exists public.stock_moves (
  id bigint generated always as identity primary key,
  item_id bigint not null references public.stock_items(id) on delete cascade,
  at timestamptz not null default now(),
  "user" text not null default '',
  delta numeric not null,
  counterpart text not null default '',
  note text not null default ''
);

-- ---------- инвентаризация ----------
create table if not exists public.audits (
  id bigint generated always as identity primary key,
  name text not null,
  room_id bigint references public.rooms(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  closed_at timestamptz
);

create table if not exists public.audit_scans (
  audit_id bigint not null references public.audits(id) on delete cascade,
  asset_id bigint not null references public.assets(id) on delete cascade,
  at timestamptz not null default now(),
  "user" text not null default '',
  found_room_id bigint references public.rooms(id) on delete set null,
  primary key (audit_id, asset_id)
);

-- ---------- журнал ----------
create table if not exists public.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  "user" text not null default '',
  type text not null,
  ref text not null default '',
  details text not null default ''
);
create index if not exists events_ref on public.events(ref);

-- ---------- пользователи и роли ----------
-- Учётные записи создаются в Supabase → Authentication → Users → Add user.
-- Новый пользователь получает роль «просмотр»; администратора назначают в программе
-- (Настройки → Пользователи) или SQL-запросом:
--   update public.profiles set role = 'admin' where email = 'почта@example.com';
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  role text not null default 'viewer' check (role in ('admin', 'viewer'))
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', ''),
          -- самый первый пользователь становится администратором
          case when exists (select 1 from public.profiles) then 'viewer' else 'admin' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- пользователи, созданные до запуска схемы
insert into public.profiles (id, email)
select id, coalesce(email, '') from auth.users on conflict (id) do nothing;
update public.profiles set role = 'admin'
where not exists (select 1 from public.profiles where role = 'admin')
  and id = (select id from public.profiles order by email limit 1);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.current_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name, ''), email, 'система') from public.profiles where id = auth.uid()
$$;

create or replace function public.log_event(p_type text, p_ref text, p_details text) returns void
language sql security definer set search_path = public as $$
  insert into public.events ("user", type, ref, details)
  values (coalesce(public.current_name(), 'система'), p_type, coalesce(p_ref, ''), coalesce(p_details, ''))
$$;

-- ---------- доступ (RLS): читать — всем вошедшим, менять — только администраторам ----------
do $$
declare t text;
begin
  foreach t in array array['rooms', 'employees', 'assets', 'movements', 'stock_items', 'stock_moves',
                           'audits', 'audit_scans', 'events', 'profiles'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('create policy read_all on public.%I for select to authenticated using (true)', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- история не редактируется и не удаляется вручную — её пишут только функции ниже
drop policy if exists admin_write on public.movements;
drop policy if exists admin_write on public.events;
drop policy if exists admin_write on public.stock_moves;

-- нельзя убрать последнего администратора
create or replace function public.keep_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'Нельзя убрать последнего администратора';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists keep_last_admin on public.profiles;
create trigger keep_last_admin before update or delete on public.profiles
  for each row execute function public.keep_last_admin();

-- ---------- автоматический журнал изменений ----------
create or replace function public.audit_assets() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changes text[] := '{}';
begin
  if coalesce(current_setting('orleu.import', true), '') = '1' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    perform public.log_event('Добавлено ОС', new.inv, new.name);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.log_event('Удалено ОС', old.inv,
      old.name || '; кабинет ' || coalesce((select code from rooms where id = old.room_id), '—'));
    return old;
  end if;
  new.updated_at := now();
  if new.inv is distinct from old.inv then
    changes := changes || ('инв. номер: ' || old.inv || ' → ' || new.inv);
    update events set ref = new.inv where ref = old.inv;
  end if;
  if new.name is distinct from old.name then changes := changes || ('название: ' || old.name || ' → ' || new.name); end if;
  if new.condition is distinct from old.condition then changes := changes || ('состояние: ' || old.condition || ' → ' || new.condition); end if;
  if new.status is distinct from old.status then changes := changes || ('статус: ' || old.status || ' → ' || new.status); end if;
  if new.category is distinct from old.category then changes := changes || ('категория: ' || old.category || ' → ' || new.category); end if;
  if new.serial is distinct from old.serial then changes := changes || ('серийный №: ' || coalesce(nullif(old.serial, ''), '—') || ' → ' || coalesce(nullif(new.serial, ''), '—')); end if;
  if new.notes is distinct from old.notes then changes := changes || 'примечание'::text; end if;
  if array_length(changes, 1) > 0 then
    perform public.log_event('Изменение ОС', new.inv, array_to_string(changes, '; '));
  end if;
  -- перемещение, сделанное через форму редактирования, тоже попадает в историю
  if (new.room_id is distinct from old.room_id or new.employee_id is distinct from old.employee_id)
     and coalesce(current_setting('orleu.moving', true), '') <> '1' then
    perform public.record_move(old, new.room_id, new.employee_id, '');
  end if;
  return new;
end $$;

create or replace function public.record_move(a public.assets, p_room bigint, p_employee bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  fr text := coalesce((select code from rooms where id = a.room_id), '');
  tr text := coalesce((select code from rooms where id = p_room), '');
  fe text := coalesce((select full_name from employees where id = a.employee_id), '');
  te text := coalesce((select full_name from employees where id = p_employee), '');
begin
  insert into movements (asset_id, "user", from_room, to_room, from_employee, to_employee, reason)
  values (a.id, coalesce(current_name(), 'система'), fr, tr, fe, te, coalesce(p_reason, ''));
  perform log_event('Перемещение', a.inv,
    coalesce(nullif(fr, ''), '—') || ' / ' || coalesce(nullif(fe, ''), '—') || ' → ' ||
    coalesce(nullif(tr, ''), '—') || ' / ' || coalesce(nullif(te, ''), '—') ||
    case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end);
end $$;

drop trigger if exists audit_assets on public.assets;
create trigger audit_assets before insert or update or delete on public.assets
  for each row execute function public.audit_assets();

create or replace function public.audit_simple() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  label text := case tg_table_name when 'rooms' then 'кабинет' when 'employees' then 'сотрудник'
                  when 'stock_items' then 'позиция ТМЗ' when 'audits' then 'инвентаризация' end;
  rec jsonb := to_jsonb(coalesce(new, old));
  ref text := coalesce(rec->>'code', rec->>'full_name', rec->>'name', '');
begin
  if coalesce(current_setting('orleu.import', true), '') = '1' then return coalesce(new, old); end if;
  perform public.log_event(
    case tg_op when 'INSERT' then 'Добавлен(а) ' when 'UPDATE' then 'Изменён(а) ' else 'Удалён(а) ' end || label,
    ref, '');
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['rooms', 'employees', 'stock_items'] loop
    execute format('drop trigger if exists audit_simple on public.%I', t);
    execute format('create trigger audit_simple after insert or update or delete on public.%I for each row execute function public.audit_simple()', t);
  end loop;
end $$;

-- ---------- операции (вызываются из программы) ----------
create or replace function public.move_asset(p_inv text, p_room bigint, p_employee bigint, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare a assets;
begin
  if not is_admin() then raise exception 'Недостаточно прав'; end if;
  select * into a from assets where inv = p_inv for update;
  if not found then raise exception 'Инвентарный номер % не найден', p_inv; end if;
  if a.room_id is not distinct from p_room and a.employee_id is not distinct from p_employee then return; end if;
  perform record_move(a, p_room, p_employee, p_reason);
  perform set_config('orleu.moving', '1', true);
  update assets set room_id = p_room, employee_id = p_employee where id = a.id;
  perform set_config('orleu.moving', '', true);
end $$;

create or replace function public.stock_adjust() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- ручное изменение остатка в карточке ТМЗ тоже видно в движении
  if new.qty is distinct from old.qty and coalesce(current_setting('orleu.stock', true), '') <> '1' then
    insert into stock_moves (item_id, "user", delta, note) values (new.id, coalesce(current_name(), ''), new.qty - old.qty, 'Корректировка');
  end if;
  return new;
end $$;
drop trigger if exists stock_adjust on public.stock_items;
create trigger stock_adjust after update on public.stock_items for each row execute function public.stock_adjust();

-- stock_move сам пишет движение — отключаем триггер корректировки на время операции
create or replace function public.stock_move(p_item bigint, p_delta numeric, p_counterpart text default '', p_note text default '')
returns public.stock_items language plpgsql security definer set search_path = public as $$
declare s stock_items;
begin
  if not is_admin() then raise exception 'Недостаточно прав'; end if;
  if p_delta = 0 then raise exception 'Количество должно быть больше нуля'; end if;
  select * into s from stock_items where id = p_item for update;
  if not found then raise exception 'Позиция не найдена'; end if;
  if s.qty + p_delta < 0 then raise exception 'Недостаточно на складе: остаток % %', s.qty, s.unit; end if;
  perform set_config('orleu.stock', '1', true);
  update stock_items set qty = qty + p_delta where id = p_item returning * into s;
  perform set_config('orleu.stock', '', true);
  insert into stock_moves (item_id, "user", delta, counterpart, note)
  values (p_item, coalesce(current_name(), ''), p_delta, coalesce(p_counterpart, ''), coalesce(p_note, ''));
  perform log_event(case when p_delta > 0 then 'Приход ТМЗ' else 'Выдача ТМЗ' end, s.name,
                    abs(p_delta)::text || ' ' || s.unit || case when coalesce(p_counterpart, '') <> '' then '; ' || p_counterpart else '' end);
  return s;
end $$;

create or replace function public.parse_code(p_code text) returns text
language sql immutable as $$
  select coalesce(substring(trim(p_code) from '/a/([^/?#[:space:]]+)'), trim(p_code))
$$;

create or replace function public.audit_scan(p_audit bigint, p_code text, p_room bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  au audits;
  a assets;
  v_inv text := parse_code(p_code);
  v_room bigint;
begin
  if not is_admin() then raise exception 'Недостаточно прав'; end if;
  select * into au from audits where id = p_audit;
  if not found then raise exception 'Инвентаризация не найдена'; end if;
  if au.closed_at is not null then raise exception 'Инвентаризация уже завершена'; end if;
  select * into a from assets where inv = v_inv;
  if not found then
    return jsonb_build_object('result', 'unknown', 'inv', v_inv, 'message', 'Номер ' || v_inv || ' не найден в базе');
  end if;
  if exists (select 1 from audit_scans where audit_id = p_audit and asset_id = a.id) then
    return jsonb_build_object('result', 'repeat', 'inv', v_inv, 'name', a.name, 'message', 'Уже отмечено ранее');
  end if;
  v_room := coalesce(p_room, au.room_id);
  insert into audit_scans (audit_id, asset_id, "user", found_room_id) values (p_audit, a.id, coalesce(current_name(), ''), v_room);
  perform log_event('Найдено при инвентаризации', v_inv, au.name);
  if au.room_id is not null and a.room_id is distinct from au.room_id then
    return jsonb_build_object('result', 'foreign', 'inv', v_inv, 'name', a.name,
      'message', 'Числится в кабинете ' || coalesce((select code from rooms where id = a.room_id), '—') || ', найдено здесь');
  end if;
  return jsonb_build_object('result', 'found', 'inv', v_inv, 'name', a.name, 'message', 'Найдено');
end $$;

create or replace function public.audit_close(p_audit bigint) returns void
language plpgsql security definer set search_path = public as $$
declare au audits; found_n int;
begin
  if not is_admin() then raise exception 'Недостаточно прав'; end if;
  update audits set closed_at = now() where id = p_audit and closed_at is null returning * into au;
  if not found then raise exception 'Инвентаризация не найдена или уже завершена'; end if;
  select count(*) into found_n from audit_scans where audit_id = p_audit;
  perform log_event('Завершена инвентаризация', au.name, 'Отмечено: ' || found_n);
end $$;

create or replace function public.audit_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_event('Начата инвентаризация', new.name, coalesce((select code from rooms where id = new.room_id), 'все кабинеты'));
  elsif tg_op = 'DELETE' then
    perform log_event('Удалена инвентаризация', old.name, '');
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_events on public.audits;
create trigger audit_events after insert or delete on public.audits for each row execute function public.audit_events();

-- для GitHub Action, который раз в несколько дней «будит» бесплатный проект (без доступа к данным)
create or replace function public.ping() returns text language sql stable set search_path = public as $$ select 'ok' $$;
grant execute on function public.ping() to anon;
alter function public.parse_code(text) set search_path = public;

-- ---------- права на функции ----------
-- внутренние функции и функции триггеров вызываются только самой базой
-- (иначе пользователь «просмотр» мог бы дописать фальшивую историю через /rpc/log_event)
revoke execute on function public.log_event(text, text, text), public.record_move(public.assets, bigint, bigint, text),
  public.current_name(), public.handle_new_user(), public.keep_last_admin(), public.audit_assets(),
  public.audit_simple(), public.audit_events(), public.stock_adjust()
  from public, anon, authenticated;
-- операции программы — только для вошедших; права администратора проверяются внутри каждой
revoke execute on function public.move_asset(text, bigint, bigint, text), public.stock_move(bigint, numeric, text, text),
  public.audit_scan(bigint, text, bigint), public.audit_close(bigint), public.is_admin()
  from public, anon;
grant execute on function public.move_asset(text, bigint, bigint, text), public.stock_move(bigint, numeric, text, text),
  public.audit_scan(bigint, text, bigint), public.audit_close(bigint), public.is_admin()
  to authenticated;
