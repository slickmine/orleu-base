"""SQLite storage for ӨRLEU BASE."""
import hashlib
import hmac
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ORLEU_DATA", ROOT / "data"))
DB_PATH = DATA_DIR / "orleu.db"

CONDITIONS = ["Не проверено", "Исправна", "Неисправна", "Требует ремонта"]
STATUSES = ["В эксплуатации", "На складе", "Предлагается к списанию", "Списана"]
CATEGORIES = [
    "Компьютеры", "Моноблоки", "Ноутбуки", "Принтеры и МФУ", "Мониторы",
    "Интерактивные панели", "Проекторы", "Сетевое оборудование",
    "Аудио и видео", "Робототехника", "Программное обеспечение", "Прочая техника",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL DEFAULT '',
    position TEXT NOT NULL DEFAULT '',
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY,
    inv TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Прочая техника',
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    mol TEXT NOT NULL DEFAULT '',
    condition TEXT NOT NULL DEFAULT 'Не проверено',
    status TEXT NOT NULL DEFAULT 'В эксплуатации',
    serial TEXT NOT NULL DEFAULT '',
    acquired TEXT NOT NULL DEFAULT '',
    cost REAL,
    residual REAL,
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_room ON assets(room_id);
CREATE INDEX IF NOT EXISTS assets_employee ON assets(employee_id);
CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    user TEXT NOT NULL,
    from_room TEXT NOT NULL DEFAULT '',
    to_room TEXT NOT NULL DEFAULT '',
    from_employee TEXT NOT NULL DEFAULT '',
    to_employee TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS movements_asset ON movements(asset_id);
CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'шт.',
    qty REAL NOT NULL DEFAULT 0,
    min_qty REAL NOT NULL DEFAULT 0,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    user TEXT NOT NULL,
    delta REAL NOT NULL,
    counterpart TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    closed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_scans (
    audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    user TEXT NOT NULL,
    found_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    PRIMARY KEY (audit_id, asset_id)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user TEXT NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    full_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = Path(path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


@contextmanager
def tx(conn: sqlite3.Connection):
    """Run a block atomically: commit on success, roll back on any error."""
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def log_event(conn, user: str, type_: str, ref: str = "", details: str = "") -> None:
    conn.execute(
        "INSERT INTO events (at, user, type, ref, details) VALUES (?, ?, ?, ?, ?)",
        (now(), user, type_, ref, details),
    )


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"pbkdf2${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    expected = hash_password(password, bytes.fromhex(salt_hex)).split("$")[2]
    return hmac.compare_digest(expected, digest_hex)


def room_code_key(code: str):
    """Sort rooms numerically first (2, 3, 10…), then named rooms alphabetically."""
    return (0, int(code), "") if code.isdigit() else (1, 0, code.lower())
