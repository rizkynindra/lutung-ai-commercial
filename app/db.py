"""SQLite persistence: users, trials, executions, consent, feedback.

ponytail: SQLite single file; swap to managed Postgres when running >1 instance.
All SQL here is portable (conditional UPDATE for atomicity, no SQLite-only locking).
"""
import os
import sqlite3
import time
import uuid

DB_PATH = os.getenv("LUTUNG_DB_PATH", "lutung.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, auth_provider TEXT NOT NULL, auth_subject TEXT NOT NULL,
  email TEXT, display_name TEXT, created_at REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (auth_provider, auth_subject));
CREATE TABLE IF NOT EXISTS trial_entitlements (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), technology_id TEXT NOT NULL,
  status TEXT NOT NULL, reserved_at REAL, consumed_at REAL, request_id TEXT, failure_reason_category TEXT,
  UNIQUE (user_id, technology_id));
CREATE TABLE IF NOT EXISTS playground_executions (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT, technology_id TEXT NOT NULL,
  status TEXT NOT NULL, started_at REAL NOT NULL, completed_at REAL, latency_ms INTEGER,
  error_code TEXT, input_metadata TEXT);
CREATE TABLE IF NOT EXISTS consent_acknowledgements (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, notice_version TEXT NOT NULL, accepted_at REAL NOT NULL,
  UNIQUE (user_id, notice_version));
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY, user_id TEXT, technology_id TEXT NOT NULL, request_id TEXT,
  message TEXT NOT NULL, created_at REAL NOT NULL, status TEXT NOT NULL DEFAULT 'open');
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)  # autocommit; each UPDATE is atomic
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with connect() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)


def _id():
    return uuid.uuid4().hex


def upsert_user(provider, subject, email, name):
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO users (id, auth_provider, auth_subject, email, display_name, created_at) "
                  "VALUES (?,?,?,?,?,?)", (_id(), provider, subject, email, name, time.time()))
        c.execute("UPDATE users SET email=?, display_name=? WHERE auth_provider=? AND auth_subject=?",
                  (email, name, provider, subject))
        return dict(c.execute("SELECT * FROM users WHERE auth_provider=? AND auth_subject=?",
                              (provider, subject)).fetchone())


# --- Trial state machine: AVAILABLE -> RESERVED -> CONSUMED, RESERVED -> AVAILABLE on provider failure ---

def trial_status(user_id, tech):
    with connect() as c:
        row = c.execute("SELECT status FROM trial_entitlements WHERE user_id=? AND technology_id=?",
                        (user_id, tech)).fetchone()
    return row["status"] if row else "AVAILABLE"


def reserve_trial(user_id, tech, request_id, lease_s):
    """Atomically reserve the one trial. Returns 'RESERVED', 'CONSUMED' or 'IN_PROGRESS'.

    A RESERVED row older than lease_s is treated as abandoned and may be re-reserved.
    lease_s must exceed the provider timeout so a live request can never be overtaken.
    """
    now = time.time()
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO trial_entitlements (id, user_id, technology_id, status) VALUES (?,?,?,'AVAILABLE')",
                  (_id(), user_id, tech))
        cur = c.execute(
            "UPDATE trial_entitlements SET status='RESERVED', reserved_at=?, request_id=? "
            "WHERE user_id=? AND technology_id=? AND (status='AVAILABLE' OR (status='RESERVED' AND reserved_at < ?))",
            (now, request_id, user_id, tech, now - lease_s))
        if cur.rowcount == 1:
            return "RESERVED"
        status = c.execute("SELECT status FROM trial_entitlements WHERE user_id=? AND technology_id=?",
                           (user_id, tech)).fetchone()["status"]
    return "CONSUMED" if status == "CONSUMED" else "IN_PROGRESS"


def settle_trial(user_id, tech, request_id, success, failure_category=None):
    with connect() as c:
        if success:
            c.execute("UPDATE trial_entitlements SET status='CONSUMED', consumed_at=? "
                      "WHERE user_id=? AND technology_id=? AND request_id=? AND status='RESERVED'",
                      (time.time(), user_id, tech, request_id))
        else:
            c.execute("UPDATE trial_entitlements SET status='AVAILABLE', reserved_at=NULL, failure_reason_category=? "
                      "WHERE user_id=? AND technology_id=? AND request_id=? AND status='RESERVED'",
                      (failure_category, user_id, tech, request_id))


def record_execution(request_id, user_id, tech, status, started, error_code=None, input_metadata=None):
    done = time.time()
    with connect() as c:
        c.execute("INSERT INTO playground_executions VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (_id(), request_id, user_id, tech, status, started, done, int((done - started) * 1000),
                   error_code, input_metadata))


def has_consent(user_id, version):
    with connect() as c:
        return c.execute("SELECT 1 FROM consent_acknowledgements WHERE user_id=? AND notice_version=?",
                         (user_id, version)).fetchone() is not None


def add_consent(user_id, version):
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO consent_acknowledgements VALUES (?,?,?,?)",
                  (_id(), user_id, version, time.time()))


def add_feedback(user_id, tech, request_id, message):
    with connect() as c:
        c.execute("INSERT INTO feedback (id, user_id, technology_id, request_id, message, created_at) VALUES (?,?,?,?,?,?)",
                  (_id(), user_id, tech, request_id, message, time.time()))
