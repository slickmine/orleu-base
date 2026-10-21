"""Проверка supabase/schema.sql на локальном Postgres (pgserver) с заглушками Supabase Auth.

Запуск: python -m pytest tests/test_schema.py   (нужен pip install pgserver psycopg2-binary)
"""
import uuid
from pathlib import Path

import pytest

pgserver = pytest.importorskip("pgserver")
psycopg2 = pytest.importorskip("psycopg2")

ROOT = Path(__file__).resolve().parent.parent
SUPABASE_STUB = """
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;
"""
GRANTS = """
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema auth to authenticated, anon;
"""

ADMIN = str(uuid.uuid4())
VIEWER = str(uuid.uuid4())


@pytest.fixture(scope="module")
def conn(tmp_path_factory):
    srv = pgserver.get_server(tmp_path_factory.mktemp("pg"), cleanup_mode="stop")
    c = psycopg2.connect(srv.get_uri())
    c.autocommit = True
    cur = c.cursor()
    cur.execute(SUPABASE_STUB)
    schema = (ROOT / "supabase" / "schema.sql").read_text(encoding="utf-8")
    cur.execute(schema)
    cur.execute(schema)  # повторный запуск не должен падать
    cur.execute(GRANTS)
    cur.execute("insert into auth.users (id, email) values (%s, 'admin@x.kz'), (%s, 'guest@x.kz')", (ADMIN, VIEWER))
    cur.execute("insert into rooms (code) values ('27'), ('29')")
    cur.execute("insert into employees (full_name) values ('Иванов Иван')")
    cur.execute("insert into assets (inv, name, room_id) values ('241300000001', 'Моноблок', (select id from rooms where code='27')),"
                " ('241300000002', 'Принтер', (select id from rooms where code='27')),"
                " ('241300000003', 'Ноутбук', (select id from rooms where code='29'))")
    yield c
    c.close()


def as_user(conn, uid):
    cur = conn.cursor()
    cur.execute("reset role")
    cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (uid,))
    cur.execute("set role authenticated")
    return cur


def test_first_user_is_admin(conn):
    cur = as_user(conn, ADMIN)
    cur.execute("select email, role from profiles order by email")
    assert cur.fetchall() == [("admin@x.kz", "admin"), ("guest@x.kz", "viewer")]


def test_viewer_cannot_write(conn):
    cur = as_user(conn, VIEWER)
    cur.execute("select count(*) from assets")
    assert cur.fetchone()[0] == 3
    cur.execute("update assets set name = 'x' where inv = '241300000001'")
    assert cur.rowcount == 0  # RLS тихо отбрасывает
    with pytest.raises(psycopg2.Error, match="Недостаточно прав"):
        cur.execute("select move_asset('241300000001', null, null, '')")
    conn.rollback() if not conn.autocommit else None
    cur.execute("update profiles set role = 'admin' where email = 'guest@x.kz'")
    assert cur.rowcount == 0


def test_move_and_history(conn):
    cur = as_user(conn, ADMIN)
    cur.execute("select move_asset('241300000001', (select id from rooms where code='29'), (select id from employees limit 1), 'заявка')")
    cur.execute("select from_room, to_room, to_employee, reason, \"user\" from movements")
    assert cur.fetchall() == [("27", "29", "Иванов Иван", "заявка", "admin@x.kz")]
    # перемещение через обычное редактирование тоже пишется
    cur.execute("update assets set room_id = (select id from rooms where code='27'), condition = 'Неисправна' where inv = '241300000001'")
    cur.execute("select count(*) from movements")
    assert cur.fetchone()[0] == 2
    cur.execute("select type, details from events where ref = '241300000001' order by id")
    types = [t for t, _ in cur.fetchall()]
    assert "Перемещение" in types and "Изменение ОС" in types
    # историю нельзя править вручную
    cur.execute("delete from movements")
    assert cur.rowcount == 0


def test_audit_flow(conn):
    cur = as_user(conn, ADMIN)
    cur.execute("insert into audits (name, room_id, created_by) values ('Каб 27', (select id from rooms where code='27'), 'admin') returning id")
    aid = cur.fetchone()[0]
    res = lambda code: (cur.execute("select audit_scan(%s, %s)", (aid, code)), cur.fetchone()[0]["result"])[1]
    assert res("https://slickmine.github.io/orleu-base/#/a/241300000002") == "found"
    assert res("241300000002") == "repeat"
    assert res("241300000003") == "foreign"
    assert res("999") == "unknown"
    cur.execute("select audit_close(%s)", (aid,))
    with pytest.raises(psycopg2.Error, match="завершена"):
        cur.execute("select audit_scan(%s, '241300000001')", (aid,))


def test_stock(conn):
    cur = as_user(conn, ADMIN)
    cur.execute("insert into stock_items (name, qty) values ('Картридж', 5) returning id")
    sid = cur.fetchone()[0]
    cur.execute("select (stock_move(%s, -3, 'каб 25')).qty", (sid,))
    assert cur.fetchone()[0] == 2
    with pytest.raises(psycopg2.Error, match="Недостаточно"):
        cur.execute("select stock_move(%s, -3)", (sid,))
    cur.execute("update stock_items set qty = 10 where id = %s", (sid,))
    cur.execute("select delta, note from stock_moves where item_id = %s order by id", (sid,))
    assert [(float(d), n) for d, n in cur.fetchall()] == [(-3.0, ""), (8.0, "Корректировка")]


def test_viewer_cannot_forge_history(conn):
    cur = as_user(conn, VIEWER)
    with pytest.raises(psycopg2.Error, match="permission denied"):
        cur.execute("select log_event('Перемещение', '241300000001', 'подделка')")


def test_last_admin_protected(conn):
    cur = as_user(conn, ADMIN)
    with pytest.raises(psycopg2.Error, match="последнего администратора"):
        cur.execute("update profiles set role = 'viewer' where email = 'admin@x.kz'")


def test_seed_loads_twice_without_duplicates(conn):
    seed = ROOT / "supabase" / "seed.sql"
    if not seed.exists():
        pytest.skip("seed.sql не сгенерирован (tools/make_seed.py)")
    cur = conn.cursor()
    cur.execute("reset role")
    cur.execute(seed.read_text(encoding="utf-8"))
    cur.execute("select count(*) from assets where source <> 'Вручную'")
    first = cur.fetchone()[0]
    cur.execute("select count(*) from stock_items")
    stock = cur.fetchone()[0]
    cur.execute(seed.read_text(encoding="utf-8"))
    cur.execute("select count(*) from assets where source <> 'Вручную'")
    assert cur.fetchone()[0] == first
    cur.execute("select count(*) from stock_items")
    assert cur.fetchone()[0] == stock
    cur.execute("select count(*) from events where type = 'Добавлено ОС'")
    assert cur.fetchone()[0] == 3  # импорт не засоряет журнал, только 3 тестовые записи
