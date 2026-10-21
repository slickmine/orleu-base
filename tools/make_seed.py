"""Готовит supabase/seed.sql — первичную загрузку техники из Excel-файлов филиала.

Запуск:  python tools/make_seed.py "..\\Исходные данные"
Потом:   Supabase → SQL Editor → вставить содержимое supabase/seed.sql → Run.

Файл содержит ФИО и стоимости, поэтому он в .gitignore и в GitHub не попадает.
Повторный запуск seed.sql безопасен: существующие записи не дублируются.
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import db, import_excel  # noqa: E402


def q(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def room_ref(code) -> str:
    return "null" if not code else f"(select id from public.rooms where code = {q(code)})"


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    src = Path(argv[1])
    out = ROOT / "supabase" / "seed.sql"
    report = ROOT / "supabase" / "import_report.xlsx"
    with tempfile.TemporaryDirectory() as tmp:
        conn = db.connect(Path(tmp) / "seed.db")
        summary = import_excel.run(src, conn, report_path=report)
        conn.row_factory = sqlite3.Row
        lines = [
            "-- Первичная загрузка ӨRLEU BASE. Сгенерировано tools/make_seed.py",
            "begin;",
            "select set_config('orleu.import', '1', true);",
        ]
        for r in conn.execute("select * from rooms order by sort"):
            lines.append(f"insert into public.rooms (code, name, sort) values ({q(r['code'])}, {q(r['name'])}, {r['sort']}) on conflict (code) do nothing;")
        for e in conn.execute("select e.*, r.code as room from employees e left join rooms r on r.id = e.room_id"):
            lines.append(
                "insert into public.employees (full_name, department, position, room_id) values "
                f"({q(e['full_name'])}, {q(e['department'])}, {q(e['position'])}, {room_ref(e['room'])}) on conflict (full_name) do nothing;")
        for a in conn.execute("select a.*, r.code as room from assets a left join rooms r on r.id = a.room_id order by a.inv"):
            lines.append(
                "insert into public.assets (inv, name, category, room_id, mol, condition, status, acquired, cost, residual, notes, source) values "
                f"({q(a['inv'])}, {q(a['name'])}, {q(a['category'])}, {room_ref(a['room'])}, {q(a['mol'])}, {q(a['condition'])}, "
                f"{q(a['status'])}, {q(a['acquired'])}, {q(a['cost'])}, {q(a['residual'])}, {q(a['notes'])}, {q(a['source'])}) "
                "on conflict (inv) do nothing;")
        lines.append("-- ТМЗ загружаются только в пустой склад, чтобы повторный запуск не задвоил остатки")
        stock = list(conn.execute("select s.*, r.code as room from stock_items s left join rooms r on r.id = s.room_id"))
        if stock:
            values = ",\n  ".join(
                f"({q(s['name'])}, {q(s['unit'])}, {q(s['qty'])}, {room_ref(s['room'])}, {q(s['notes'])})" for s in stock)
            lines.append("insert into public.stock_items (name, unit, qty, room_id, notes)\nselect * from (values\n  "
                         f"{values}\n) v(name, unit, qty, room_id, notes)\nwhere not exists (select 1 from public.stock_items);")
        details = "ОС: {assets}, с кабинетом: {with_room}, ТМЗ: {stock}".format(**summary)
        lines.append(f"select public.log_event('Первичная загрузка', 'Excel', {q(details)});")
        lines.append("commit;")
        conn.close()
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Готово: {out} ({summary['assets']} ОС, {summary['stock']} ТМЗ, {summary['rooms']} кабинетов)")
    print(f"Отчёт расхождений: {report}")


if __name__ == "__main__":
    main(sys.argv)
