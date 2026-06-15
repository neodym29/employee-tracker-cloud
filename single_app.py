#!/usr/bin/env python3
"""Single-file Python version of the Neodym employee tracker cloud app.

Routes included:
- GET /api/health
- POST /api/ingest
- POST /api/login
- POST /api/logout
- POST /api/register
- POST /api/signup
- POST /api/approve
- POST /api/bootstrap
- GET /api/screenshot
- GET /api/installer
- GET /dashboard
- GET /login, /register, /signup, /employee, /admin/approve, /

Run locally:
    DATABASE_URL=postgresql://... AUTH_SECRET=... INGEST_API_KEY=... python3 single_app.py --port 8000

The HTTP layer uses only Python's stdlib. Database access uses psycopg/psycopg2 if
available, against the same Postgres schema as the Next.js app.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import socket
import ssl
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

try:
    import psycopg  # type: ignore
except Exception:  # pragma: no cover
    psycopg = None

try:
    import psycopg2  # type: ignore
    import psycopg2.extras  # type: ignore
except Exception:  # pragma: no cover
    psycopg2 = None

COOKIE_NAME = "neodym_session"
CONSUMER_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
    "outlook.com", "live.com", "icloud.com", "me.com", "aol.com",
    "proton.me", "protonmail.com",
}


# ----------------------------- utilities -----------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def as_string(value: Any, fallback: str = "") -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def as_number(value: Any) -> int | float | None:
    try:
        if value is None or value == "":
            return None
        numeric = float(value)
        if not (numeric == numeric and abs(numeric) != float("inf")):
            return None
        return int(numeric) if numeric.is_integer() else numeric
    except Exception:
        return None


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def health() -> dict[str, Any]:
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or ""
    hint = re.sub(r"://.*@", "://***@", url)
    hint = re.sub(r"\?.*$", "?…", hint) if hint else "missing"
    return {"configured": bool(url), "hasIngestKey": bool(os.environ.get("INGEST_API_KEY")), "databaseUrlHint": hint}


def normalize_email(email: str) -> str:
    value = (email or "").strip().lower()
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", value):
        raise ValueError("Enter a valid work email")
    return value


def domain_from_email(email: str) -> str:
    return normalize_email(email).split("@", 1)[1]


def normalize_domain(domain: str) -> str:
    value = (domain or "").strip().lower().lstrip("@").rstrip(".")
    if not re.match(r"^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$", value):
        raise ValueError("Enter a valid company email domain")
    if value in CONSUMER_EMAIL_DOMAINS:
        raise ValueError("Use a company-owned email domain, not a personal email provider")
    return value


def assert_legit_company_domain(domain: str) -> str:
    value = normalize_domain(domain)
    # Lightweight stdlib DNS check. MX/NS parity with Next.js is ideal, but A lookup
    # keeps this single-file app dependency-free and catches fake domains.
    try:
        socket.getaddrinfo(value, None)
    except Exception as exc:
        raise ValueError(f"Could not verify DNS for {value}. Use a real company domain with DNS records.") from exc
    return value


def assert_password(password: str) -> str:
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters")
    return password


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac("sha256", assert_password(password).encode(), salt.encode(), 210_000, 32).hex()
    return f"pbkdf2_sha256$210000${salt}${derived}"


def verify_password(password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        scheme, iterations_raw, salt, expected = stored_hash.split("$", 3)
        iterations = int(iterations_raw)
        if scheme != "pbkdf2_sha256" or iterations < 100_000:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations, 32).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def auth_secret() -> str:
    secret = os.environ.get("AUTH_SECRET") or os.environ.get("ADMIN_SETUP_KEY") or os.environ.get("INGEST_API_KEY")
    if not secret:
        raise RuntimeError("AUTH_SECRET or ADMIN_SETUP_KEY must be configured for login sessions")
    return secret


def sign(payload: str) -> str:
    return b64url_encode(hmac.new(auth_secret().encode(), payload.encode(), hashlib.sha256).digest())


def create_session_token(user: dict[str, Any]) -> str:
    payload = dict(user)
    payload["exp"] = int(time.time() * 1000) + 1000 * 60 * 60 * 24 * 7
    encoded = b64url_encode(json.dumps(payload, separators=(",", ":"), default=json_default).encode())
    return f"{encoded}.{sign(encoded)}"


def parse_session_token(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    payload, signature = token.split(".", 1)
    if not hmac.compare_digest(signature, sign(payload)):
        return None
    parsed = json.loads(b64url_decode(payload).decode())
    if int(parsed.get("exp") or 0) < int(time.time() * 1000):
        return None
    if parsed.get("role") not in {"admin", "employee"}:
        return None
    return {"id": str(parsed["id"]), "company_id": str(parsed["company_id"]), "email": parsed["email"], "role": parsed["role"], "company_domain": parsed["company_domain"]}


# ----------------------------- database -----------------------------

class DB:
    def __init__(self) -> None:
        self.url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
        self.conn: Any = None
        self.driver = "none"

    def connect(self) -> Any:
        if not self.url:
            raise RuntimeError("DATABASE_URL or POSTGRES_URL is not configured")
        if self.conn is not None:
            return self.conn
        if psycopg is not None:
            kwargs = {"conninfo": self.url, "autocommit": True, "row_factory": psycopg.rows.dict_row}
            self.conn = psycopg.connect(**kwargs)
            self.driver = "psycopg3"
        elif psycopg2 is not None:
            self.conn = psycopg2.connect(self.url, sslmode="require" if "localhost" not in self.url else None)
            self.conn.autocommit = True
            self.driver = "psycopg2"
        else:
            raise RuntimeError("Install psycopg or psycopg2 to use database-backed routes")
        return self.conn

    def query(self, sql: str, params: list[Any] | tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        conn = self.connect()
        if self.driver == "psycopg3":
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return list(cur.fetchall()) if cur.description else []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:  # type: ignore[union-attr]
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()] if cur.description else []


db = DB()


def ensure_schema() -> None:
    db.query("""
    create table if not exists companies (
      id bigserial primary key,
      name text not null,
      domain text not null unique,
      created_at timestamptz not null default now()
    );
    create table if not exists app_users (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      email text not null unique,
      password_hash text,
      role text not null check(role in ('admin','employee')),
      approval_status text not null default 'pending' check(approval_status in ('pending','approved','rejected')),
      employee_username text,
      device_label text,
      enrollment_token text unique,
      approved_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table if not exists devices (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      user_id bigint references app_users(id),
      device_key text not null unique,
      employee_email text not null,
      hostname text,
      os_user text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create table if not exists activity_events (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      device_id bigint references devices(id),
      employee_email text not null,
      hostname text,
      os_user text,
      captured_at timestamptz not null,
      event_type text not null,
      app_name text,
      window_title text,
      url text,
      idle_seconds integer,
      payload jsonb not null default '{}'::jsonb,
      received_at timestamptz not null default now()
    );
    create table if not exists activity_screenshots (
      id bigserial primary key,
      activity_event_id bigint not null unique references activity_events(id) on delete cascade,
      company_id bigint not null references companies(id),
      employee_email text not null,
      captured_at timestamptz not null,
      mime_type text not null default 'image/png',
      image_base64 text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists app_settings (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );
    alter table app_users add column if not exists enrollment_token text unique;
    alter table app_users add column if not exists approved_at timestamptz;
    alter table app_users add column if not exists password_hash text;
    """)


def telemetry_paused() -> bool:
    ensure_schema()
    rows = db.query("select value from app_settings where key='telemetry_paused' limit 1")
    return bool(rows and rows[0].get("value") == "1")


def register_company_with_admin(company_name: str, admin_email: str, admin_password: str) -> dict[str, Any]:
    email = normalize_email(admin_email)
    domain = assert_legit_company_domain(domain_from_email(email))
    password_hash = hash_password(admin_password)
    name = company_name.strip() or domain.split(".")[0]
    ensure_schema()
    if db.query("select id from companies where domain=%s", [domain]):
        raise ValueError(f"{domain} is already registered. Ask an existing admin to approve employees.")
    company = db.query("insert into companies(name, domain) values(%s,%s) returning id, name, domain", [name, domain])[0]
    admin = db.query("""
      insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,approved_at)
      values(%s,%s,%s,'admin','approved',%s,now()) returning id, email, role, approval_status
    """, [company["id"], email, password_hash, email.split("@")[0]])[0]
    return {"ok": True, "company": company, "admin": admin}


def signup_employee(email: str, password: str) -> dict[str, Any]:
    normalized = normalize_email(email)
    password_hash = hash_password(password)
    domain = domain_from_email(normalized)
    ensure_schema()
    company = db.query("select id, domain from companies where domain=%s", [domain])
    if not company:
        raise ValueError(f"{domain} is not registered yet. Register the company and first admin before employee signups.")
    rows = db.query("""
      insert into app_users(company_id,email,password_hash,role,approval_status,employee_username)
      values(%s,%s,%s,'employee','pending',%s)
      on conflict(email) do update set company_id=excluded.company_id, password_hash=excluded.password_hash,
        approval_status='pending', employee_username=excluded.employee_username
      where app_users.role='employee'
      returning email, role, approval_status
    """, [company[0]["id"], normalized, password_hash, normalized.split("@")[0]])
    if not rows:
        raise ValueError(f"{normalized} is already an admin. Use the login page or reset admin access.")
    return {"ok": True, "email": normalized, "company_domain": domain, "status": "pending"}


def login_user(email: str, password: str) -> dict[str, Any]:
    normalized = normalize_email(email)
    ensure_schema()
    rows = db.query("""
      select app_users.id, app_users.company_id, app_users.email, app_users.password_hash,
        app_users.role, app_users.approval_status, companies.domain as company_domain
      from app_users join companies on companies.id=app_users.company_id where app_users.email=%s
    """, [normalized])
    user = rows[0] if rows else None
    if not user or not verify_password(password, user.get("password_hash")):
        raise ValueError("Invalid email or password")
    if user["role"] == "employee" and user["approval_status"] != "approved":
        raise ValueError("Employee account is pending admin approval")
    return {"id": str(user["id"]), "company_id": str(user["company_id"]), "email": user["email"], "role": user["role"], "approval_status": user["approval_status"], "company_domain": user["company_domain"]}


def approve_employee(email: str) -> dict[str, Any]:
    normalized = normalize_email(email)
    token = secrets.token_hex(24)
    ensure_schema()
    rows = db.query("""
      update app_users set approval_status='approved', enrollment_token=coalesce(enrollment_token,%s), approved_at=now()
      where email=%s and role='employee' returning email, enrollment_token, company_id
    """, [token, normalized])
    if not rows:
        raise ValueError("Employee not found")
    return rows[0]


def user_by_enrollment_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    ensure_schema()
    rows = db.query("""
      select app_users.id, app_users.email, app_users.employee_username, app_users.company_id, companies.domain
      from app_users join companies on companies.id=app_users.company_id
      where enrollment_token=%s and approval_status='approved' and role='employee'
    """, [token])
    return rows[0] if rows else None


def company_by_domain(domain: str) -> dict[str, Any] | None:
    normalized = normalize_domain(domain)
    rows = db.query("select id, name, domain from companies where domain=%s", [normalized])
    return rows[0] if rows else None


def read_dashboard(filters: dict[str, str] | None = None) -> dict[str, Any]:
    ensure_schema()
    filters = filters or {}
    where: list[str] = []
    params: list[Any] = []
    if filters.get("user") and filters.get("user") != "all":
        params.append(filters["user"])
        where.append(f"employee_email=%s")
    if filters.get("eventType") and filters.get("eventType") != "all":
        params.append(filters["eventType"])
        where.append(f"event_type=%s")
    if filters.get("mode") == "range" and filters.get("startTime"):
        params.append(filters["startTime"])
        where.append("captured_at >= %s")
    if filters.get("mode") == "range" and filters.get("endTime"):
        params.append(filters["endTime"])
        where.append("captured_at <= %s")
    limit = 500 if filters.get("mode") == "range" else 120
    where_sql = " where " + " and ".join(where) if where else ""
    companies = db.query("select name, domain, created_at from companies order by id desc limit 25")
    users = db.query("""
      select app_users.email, app_users.role, app_users.approval_status, app_users.employee_username,
        app_users.approved_at, app_users.created_at, companies.domain as company_domain,
        case when enrollment_token is null then null else left(enrollment_token, 8) || '…' end as enrollment_token_hint
      from app_users join companies on companies.id=app_users.company_id order by app_users.id desc limit 50
    """)
    devices = db.query("select employee_email, hostname, os_user, first_seen_at, last_seen_at from devices order by last_seen_at desc limit 25")
    events = db.query(f"""
      select id, employee_email, hostname, os_user, captured_at, received_at, event_type, app_name,
        window_title, url, idle_seconds, payload,
        exists(select 1 from activity_screenshots s where s.activity_event_id=activity_events.id) as has_screenshot
      from activity_events {where_sql} order by received_at desc, id desc limit %s
    """, [*params, limit])
    return {"companies": companies, "users": users, "devices": devices, "events": events}


def rich_event_rows(body: dict[str, Any], captured_at: str) -> list[dict[str, Any]]:
    events = body.get("rich_events") if isinstance(body.get("rich_events"), list) else []
    rows = []
    for event in events[:250]:
        if not isinstance(event, dict):
            continue
        rows.append({
            "captured_at": as_string(event.get("captured_at"), captured_at),
            "event_type": as_string(event.get("event_type"), "detail_event"),
            "app_name": as_string(event.get("app_name") or event.get("to_app_name") or event.get("application_name") or event.get("process_name")),
            "window_title": as_string(event.get("window_title") or event.get("to_window_title") or event.get("title") or event.get("target_hint") or event.get("media_name")),
            "url": as_string(event.get("url")),
            "idle_seconds": as_number(event.get("idle_seconds")),
            "payload": event,
        })
    return rows


def ingest(body: dict[str, Any], headers: dict[str, str]) -> tuple[dict[str, Any], int]:
    expected = os.environ.get("INGEST_API_KEY")
    if not health()["configured"]:
        return {"ok": False, "error": "DATABASE_URL or POSTGRES_URL is not configured"}, 503
    enrollment_token = headers.get("x-enrollment-token", "")
    token_user = user_by_enrollment_token(enrollment_token) if enrollment_token else None
    shared_key_ok = bool(expected and headers.get("x-ingest-key") == expected)
    if not shared_key_ok and not token_user:
        return {"ok": False, "error": "forbidden"}, 403
    employee_email = (token_user.get("email") if token_user else as_string(body.get("employee_email"))).lower()
    if not employee_email or "@" not in employee_email:
        return {"ok": False, "error": "employee_email is required"}, 400
    requested_domain = as_string(body.get("company_domain"), employee_email.split("@", 1)[1]).lower()
    company = {"id": token_user["company_id"], "domain": token_user["domain"]} if token_user else company_by_domain(requested_domain)
    if not company:
        return {"ok": False, "error": f"{requested_domain} is not registered"}, 400
    if not token_user and not employee_email.endswith("@" + company["domain"]):
        return {"ok": False, "error": "employee_email must match the registered company domain"}, 400
    ensure_schema()
    if telemetry_paused():
        return {"ok": False, "error": "telemetry temporarily paused for reset"}, 503
    hostname = as_string(body.get("hostname"), "unknown-host")
    os_user = as_string(body.get("os_user"), "unknown-user")
    device_key = as_string(body.get("device_key"), f"{employee_email}:{hostname}:{os_user}")
    captured_at = as_string(body.get("captured_at"), utc_now_iso())
    company_id = company["id"]
    users = db.query("select id from app_users where email=%s and company_id=%s", [employee_email, company_id])
    user_id = users[0]["id"] if users else None
    device = db.query("""
      insert into devices(company_id,user_id,device_key,employee_email,hostname,os_user,last_seen_at)
      values(%s,%s,%s,%s,%s,%s,now())
      on conflict(device_key) do update set last_seen_at=now(), employee_email=excluded.employee_email,
        hostname=excluded.hostname, os_user=excluded.os_user, user_id=excluded.user_id returning id
    """, [company_id, user_id, device_key, employee_email, hostname, os_user])[0]
    screenshot_b64 = as_string(body.get("screenshot_png_base64"))
    screenshot_mime = as_string(body.get("screenshot_mime_type"), "image/png")
    sanitized = dict(body)
    sanitized.pop("screenshot_png_base64", None)
    sanitized.pop("screenshot_mime_type", None)
    event = db.query("""
      insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) returning id
    """, [company_id, device["id"], employee_email, hostname, os_user, captured_at, as_string(body.get("event_type"), "activity_snapshot"), as_string(body.get("app_name")), as_string(body.get("window_title")), as_string(body.get("url")), as_number(body.get("idle_seconds")), json.dumps(sanitized, default=json_default)])[0]
    screenshot_ok = bool(screenshot_b64 and re.match(r"^image/(png|jpeg|webp)$", screenshot_mime) and len(screenshot_b64) < 15_000_000)
    if screenshot_ok:
        db.query("""
          insert into activity_screenshots(activity_event_id,company_id,employee_email,captured_at,mime_type,image_base64)
          values(%s,%s,%s,%s,%s,%s)
          on conflict(activity_event_id) do update set mime_type=excluded.mime_type, image_base64=excluded.image_base64
        """, [event["id"], company_id, employee_email, captured_at, screenshot_mime, screenshot_b64])
    rich_rows = rich_event_rows(body, captured_at)
    for row in rich_rows:
        db.query("""
          insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
          values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        """, [company_id, device["id"], employee_email, hostname, os_user, row["captured_at"], row["event_type"], row["app_name"], row["window_title"], row["url"], row["idle_seconds"], json.dumps(row["payload"], default=json_default)])
    if screenshot_ok:
        screenshot_event = db.query("""
          insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
          values(%s,%s,%s,%s,%s,%s,'screenshot_capture',%s,%s,%s,%s,%s::jsonb) returning id
        """, [company_id, device["id"], employee_email, hostname, os_user, captured_at, as_string(body.get("app_name")), as_string(body.get("window_title")), as_string(body.get("url")), as_number(body.get("idle_seconds")), json.dumps({"screenshot_path": as_string(body.get("screenshot_path")), "source_event_id": event["id"]})])[0]
        db.query("""
          insert into activity_screenshots(activity_event_id,company_id,employee_email,captured_at,mime_type,image_base64)
          values(%s,%s,%s,%s,%s,%s)
          on conflict(activity_event_id) do update set mime_type=excluded.mime_type, image_base64=excluded.image_base64
        """, [screenshot_event["id"], company_id, employee_email, captured_at, screenshot_mime, screenshot_b64])
    return {"ok": True, "employee_email": employee_email, "hostname": hostname, "rich_events": len(rich_rows), "screenshot": screenshot_ok, "screenshot_rejected": bool(screenshot_b64 and not screenshot_ok)}, 200


# ----------------------------- views -----------------------------

def page(title: str, body: str) -> str:
    return f"""<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>{html.escape(title)}</title><style>
body{{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#07111f;color:#eaf1ff}}a{{color:#8ed7ff}}.wrap{{max-width:1180px;margin:0 auto;padding:28px}}.card{{background:#101c2f;border:1px solid #24364f;border-radius:18px;padding:18px;margin:14px 0;box-shadow:0 16px 50px #0005}}input,select,button{{padding:11px;border-radius:10px;border:1px solid #35506f;background:#091426;color:#eaf1ff;margin:4px}}button{{background:#36a3ff;border:0;color:white;font-weight:700;cursor:pointer}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263950;padding:8px;text-align:left;vertical-align:top}}.muted{{color:#91a4bd}}.pill{{display:inline-block;background:#1d3555;border:1px solid #31547b;border-radius:999px;padding:3px 9px;margin:2px;font-size:12px}}pre{{white-space:pre-wrap;background:#07111f;border-radius:12px;padding:12px;overflow:auto}}</style></head><body><div class='wrap'>{body}</div></body></html>"""


def nav() -> str:
    return "<p><a href='/dashboard'>Dashboard</a> · <a href='/login'>Login</a> · <a href='/register'>Register company</a> · <a href='/signup'>Employee signup</a> · <a href='/employee'>Employee</a></p>"


def login_page() -> str:
    return page("Login", nav() + """<div class='card'><h1>Login</h1><form method='post' action='/api/login'><input name='email' placeholder='email'><input name='password' type='password' placeholder='password'><button>Login</button></form></div>""")


def register_page() -> str:
    return page("Register", nav() + """<div class='card'><h1>Register company</h1><form method='post' action='/api/register'><input name='company_name' placeholder='company name'><input name='admin_email' placeholder='admin email'><input name='admin_password' type='password' placeholder='password'><button>Register</button></form></div>""")


def signup_page() -> str:
    return page("Signup", nav() + """<div class='card'><h1>Employee signup</h1><form method='post' action='/api/signup'><input name='email' placeholder='work email'><input name='password' type='password' placeholder='password'><button>Request access</button></form></div>""")


def employee_page() -> str:
    return page("Employee", nav() + """<div class='card'><h1>Employee installer</h1><p>After an admin approves you, use the installer URL generated in the dashboard/admin approval flow.</p></div>""")


def event_description(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    event_type = event.get("event_type")
    if event_type == "typed_chunk":
        return " · ".join(str(x) for x in [payload.get("note") or "typed chunk", payload.get("reason") and f"reason={payload.get('reason')}", payload.get("key_count") and f"{payload.get('key_count')} keys", payload.get("typed_text")] if x)
    if event_type == "shortcut":
        return " · ".join(str(x) for x in [payload.get("note") or "shortcut", payload.get("shortcut"), payload.get("keys_json")] if x)
    if event_type == "activity_session":
        return str(payload.get("summary") or "activity session")
    if event_type == "audio_output":
        return " · ".join(str(x) for x in [payload.get("application_name"), payload.get("content_title"), payload.get("mpris_artist")] if x)
    return " · ".join(str(x) for x in [event.get("app_name"), event.get("window_title"), event.get("url")] if x)


def dashboard_page(query: dict[str, list[str]], session: dict[str, Any] | None) -> str:
    if not session or session.get("role") != "admin":
        return page("Login required", nav() + "<div class='card'><h1>Admin login required</h1><p><a href='/login?next=/dashboard'>Login</a></p></div>")
    filters = {
        "mode": (query.get("mode") or ["latest"])[0] if (query.get("mode") or ["latest"])[0] == "range" else "latest",
        "user": (query.get("user") or ["all"])[0],
        "eventType": (query.get("eventType") or ["all"])[0],
        "startTime": (query.get("start") or [""])[0],
        "endTime": (query.get("end") or [""])[0],
    }
    error = ""
    data = {"companies": [], "users": [], "devices": [], "events": []}
    if health()["configured"]:
        try:
            data = read_dashboard(filters)
        except Exception as exc:
            error = str(exc)
    user_options = ["<option value='all'>All users</option>"] + [f"<option>{html.escape(str(u.get('email')))}</option>" for u in data.get("users", [])]
    event_options = ["all", "activity_snapshot", "browser_tab", "input_click", "activity_session", "typed_chunk", "shortcut", "screenshot_capture", "audio_output", "terminal_command"]
    rows = []
    for event in data.get("events", []):
        screenshot = f"<a href='/api/screenshot?id={event.get('id')}'>screenshot</a>" if event.get("has_screenshot") else ""
        rows.append(f"<tr><td>{html.escape(str(event.get('captured_at')))}</td><td>{html.escape(str(event.get('employee_email')))}</td><td><span class='pill'>{html.escape(str(event.get('event_type')))}</span></td><td>{html.escape(event_description(event))}</td><td>{screenshot}</td></tr>")
    body = nav() + f"""
    <div class='card'><h1>Neodym Tracker Dashboard</h1><p class='muted'>Single-file Python dashboard. Configured: {health()['configured']}. {html.escape(error)}</p>
    <form method='get'><select name='user'>{''.join(user_options)}</select><select name='eventType'>{''.join(f'<option value="{x}">{x}</option>' for x in event_options)}</select><select name='mode'><option>latest</option><option>range</option></select><input name='start' placeholder='start ISO'><input name='end' placeholder='end ISO'><button>Filter</button></form></div>
    <div class='card'><h2>Companies</h2><p>{len(data.get('companies', []))} companies</p></div>
    <div class='card'><h2>Users</h2><p>{len(data.get('users', []))} users</p></div>
    <div class='card'><h2>Devices</h2><p>{len(data.get('devices', []))} devices</p></div>
    <div class='card'><h2>Raw events</h2><table><thead><tr><th>Captured</th><th>User</th><th>Type</th><th>Details</th><th>Media</th></tr></thead><tbody>{''.join(rows) or '<tr><td colspan=5>No events yet</td></tr>'}</tbody></table></div>
    """
    return page("Neodym Tracker Dashboard", body)


def installer_script(token: str, platform: str, base: str) -> str:
    platform = platform if platform in {"linux", "macos", "windows"} else "linux"
    if platform == "windows":
        return f"""# Neodym single-file Python app compatible Windows installer stub
$ErrorActionPreference = 'Stop'
Write-Host "Download the agent package from the main repository and configure:"
Write-Host "EMPLOYEE_TRACKER_ENROLLMENT_TOKEN={token}"
Write-Host "EMPLOYEE_TRACKER_CLOUD_API={base}/api/ingest"
Write-Host "EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=0"
"""
    if platform == "macos":
        return f"""#!/usr/bin/env bash
set -euo pipefail
echo "Neodym macOS installer stub"
echo "EMPLOYEE_TRACKER_ENROLLMENT_TOKEN={token}"
echo "EMPLOYEE_TRACKER_CLOUD_API={base}/api/ingest"
echo "EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=0"
"""
    return f"""#!/usr/bin/env bash
set -euo pipefail
echo "Neodym Linux installer stub for the single-file Python server"
echo "Install the normal agent package, then write cloud.env with:"
echo "EMPLOYEE_TRACKER_ENROLLMENT_TOKEN={token}"
echo "EMPLOYEE_TRACKER_CLOUD_API={base}/api/ingest"
echo "EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=1"
echo "EMPLOYEE_TRACKER_KEYBOARD_IDLE_SECONDS=2.5"
echo "EMPLOYEE_TRACKER_KEYBOARD_MAX_CHUNK_SECONDS=30"
"""


def list_users_for_setup() -> list[dict[str, Any]]:
    ensure_schema()
    return db.query("""
      select app_users.email, app_users.role, app_users.approval_status, app_users.employee_username, app_users.approved_at,
        companies.domain as company_domain, app_users.password_hash is not null as has_password,
        case when app_users.enrollment_token is null then null else left(app_users.enrollment_token, 8) || '…' end as enrollment_token_hint,
        app_users.created_at
      from app_users join companies on companies.id=app_users.company_id order by app_users.id asc
    """)


def event_stats_for_setup() -> dict[str, Any]:
    ensure_schema()
    totals = db.query("select count(*)::int as total_events, count(*) filter (where exists(select 1 from activity_screenshots s where s.activity_event_id=activity_events.id))::int as screenshot_events, max(received_at) as latest_received_at from activity_events")[0]
    by_type = db.query("select event_type, count(*)::int as count, max(received_at) as latest_received_at from activity_events group by event_type order by count desc, event_type asc")
    recent = db.query("select id, employee_email, event_type, received_at, captured_at, exists(select 1 from activity_screenshots s where s.activity_event_id=activity_events.id) as has_screenshot from activity_events order by received_at desc, id desc limit 20")
    return {"totals": totals, "by_type": by_type, "recent": recent}


# ----------------------------- HTTP server -----------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "NeodymSinglePython/1.0"

    def parse_cookies(self) -> cookies.SimpleCookie:
        jar = cookies.SimpleCookie()
        if self.headers.get("Cookie"):
            jar.load(self.headers.get("Cookie"))
        return jar

    def session(self) -> dict[str, Any] | None:
        morsel = self.parse_cookies().get(COOKIE_NAME)
        return parse_session_token(morsel.value if morsel else None)

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        ctype = self.headers.get("content-type", "")
        if "application/json" in ctype:
            return json.loads(raw.decode() or "{}")
        if "application/x-www-form-urlencoded" in ctype:
            parsed = parse_qs(raw.decode())
            return {k: v[-1] if v else "" for k, v in parsed.items()}
        return json.loads(raw.decode() or "{}") if raw else {}

    def send_json(self, payload: dict[str, Any], status: int = 200, headers: dict[str, str] | None = None) -> None:
        raw = json.dumps(payload, default=json_default).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def send_html(self, content: str, status: int = 200) -> None:
        raw = content.encode()
        self.send_response(status)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def redirect(self, location: str, cookie_header: str | None = None) -> None:
        self.send_response(303)
        self.send_header("location", location)
        if cookie_header:
            self.send_header("set-cookie", cookie_header)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                return self.send_json({"ok": True, **health(), "service": "neodym-tracker-cloud"})
            if parsed.path == "/api/screenshot":
                session = self.session()
                if not session or session.get("role") != "admin":
                    return self.send_json({"ok": False, "error": "admin login required"}, 403)
                event_id = int((query.get("id") or ["0"])[0])
                ensure_schema()
                rows = db.query("""
                  select s.mime_type, s.image_base64, e.employee_email, e.hostname, e.captured_at
                  from activity_screenshots s join activity_events e on e.id=s.activity_event_id
                  where s.activity_event_id=%s limit 1
                """, [event_id])
                if not rows:
                    return self.send_json({"ok": False, "error": "screenshot not found"}, 404)
                row = rows[0]
                mime = row.get("mime_type") or "image/png"
                return self.send_json({"ok": True, "mime_type": mime, "image": f"data:{mime};base64,{row.get('image_base64')}", "employee_email": row.get("employee_email"), "hostname": row.get("hostname"), "captured_at": row.get("captured_at")})
            if parsed.path == "/api/installer":
                token = (query.get("token") or [""])[0]
                platform = (query.get("platform") or ["linux"])[0]
                if not token:
                    self.send_response(400); self.end_headers(); self.wfile.write(b"missing token\n"); return
                user = user_by_enrollment_token(token)
                if not user:
                    self.send_response(403); self.end_headers(); self.wfile.write(b"invalid or unapproved enrollment token\n"); return
                base = os.environ.get("NEXT_PUBLIC_APP_URL") or f"http://{self.headers.get('host', 'localhost')}"
                raw = installer_script(token, platform, base).encode()
                self.send_response(200)
                self.send_header("content-type", "text/plain; charset=utf-8")
                self.send_header("content-length", str(len(raw)))
                self.end_headers(); self.wfile.write(raw); return
            if parsed.path == "/dashboard":
                return self.send_html(dashboard_page(query, self.session()))
            if parsed.path == "/login":
                return self.send_html(login_page())
            if parsed.path == "/register":
                return self.send_html(register_page())
            if parsed.path == "/signup":
                return self.send_html(signup_page())
            if parsed.path == "/employee":
                return self.send_html(employee_page())
            if parsed.path == "/admin/approve":
                return self.send_html(page("Approve", nav() + "<div class='card'><h1>Approve employee</h1><form method='post' action='/api/approve'><input name='email' placeholder='employee email'><select name='platform'><option>linux</option><option>macos</option><option>windows</option></select><button>Approve</button></form></div>"))
            if parsed.path == "/":
                return self.send_html(page("Neodym", nav() + "<div class='card'><h1>Neodym employee tracker cloud</h1><p>Single-file Python edition.</p></div>"))
            self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        body = self.read_body()
        headers = {k.lower(): v for k, v in self.headers.items()}
        try:
            if parsed.path == "/api/ingest":
                payload, status = ingest(body, headers)
                return self.send_json(payload, status)
            if parsed.path == "/api/login":
                try:
                    user = login_user(str(body.get("email") or ""), str(body.get("password") or ""))
                    token = create_session_token(user)
                    morsel = cookies.SimpleCookie()
                    morsel[COOKIE_NAME] = token
                    morsel[COOKIE_NAME]["path"] = "/"
                    morsel[COOKIE_NAME]["httponly"] = True
                    morsel[COOKIE_NAME]["samesite"] = "Lax"
                    if "application/json" in self.headers.get("content-type", ""):
                        return self.send_json({"ok": True, "user": {"email": user["email"], "role": user["role"], "company_domain": user["company_domain"]}}, 200, {"set-cookie": morsel.output(header="").strip()})
                    return self.redirect("/dashboard" if user["role"] == "admin" else "/employee", morsel.output(header="").strip())
                except Exception as exc:
                    return self.send_json({"ok": False, "error": str(exc)}, 401)
            if parsed.path == "/api/logout":
                morsel = f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
                return self.send_json({"ok": True}, 200, {"set-cookie": morsel})
            if parsed.path == "/api/register":
                try:
                    result = register_company_with_admin(str(body.get("company_name") or ""), str(body.get("admin_email") or ""), str(body.get("admin_password") or ""))
                    return self.send_json(result)
                except Exception as exc:
                    return self.send_json({"ok": False, "error": str(exc)}, 400)
            if parsed.path == "/api/signup":
                try:
                    return self.send_json(signup_employee(str(body.get("email") or ""), str(body.get("password") or "")))
                except Exception as exc:
                    return self.send_json({"ok": False, "error": str(exc)}, 400)
            if parsed.path == "/api/approve":
                session = self.session()
                if not session or session.get("role") != "admin":
                    return self.send_json({"ok": False, "error": "admin login required"}, 403)
                platform = body.get("platform") if body.get("platform") in {"linux", "macos", "windows"} else "linux"
                result = approve_employee(str(body.get("email") or ""))
                base = os.environ.get("NEXT_PUBLIC_APP_URL") or f"http://{self.headers.get('host', 'localhost')}"
                return self.send_json({"ok": True, "email": result["email"], "platform": platform, "installer_url": f"{base}/api/installer?token={quote(result['enrollment_token'])}&platform={platform}"})
            if parsed.path == "/api/bootstrap":
                key = self.headers.get("x-admin-setup-key", "")
                if not os.environ.get("ADMIN_SETUP_KEY") or key != os.environ.get("ADMIN_SETUP_KEY"):
                    return self.send_json({"ok": False, "error": "forbidden"}, 403)
                ensure_schema()
                action = body.get("action")
                if action == "list_users":
                    return self.send_json({"ok": True, "users": list_users_for_setup()})
                if action == "event_stats":
                    return self.send_json({"ok": True, "stats": event_stats_for_setup()})
                if action == "set_telemetry_pause":
                    db.query("insert into app_settings(key,value,updated_at) values('telemetry_paused',%s,now()) on conflict(key) do update set value=excluded.value, updated_at=now()", ["1" if body.get("paused") else "0"])
                    return self.send_json({"ok": True, "result": {"telemetry_paused": bool(body.get("paused"))}})
                if action == "optimize_indexes":
                    db.query("create index if not exists idx_activity_events_received_id on activity_events (received_at desc, id desc)")
                    db.query("create index if not exists idx_activity_events_employee_received on activity_events (employee_email, received_at desc, id desc)")
                    db.query("create index if not exists idx_activity_events_type_received on activity_events (event_type, received_at desc, id desc)")
                    return self.send_json({"ok": True, "result": {"optimized": True}})
                return self.send_json({"ok": True, "schema": "ready", "seeded": []})
            self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"ok": False, "error": str(exc)}, 500)


def main() -> None:
    parser = argparse.ArgumentParser(description="Single-file Python Neodym tracker cloud app")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    server = HTTPServer((args.host, args.port), Handler)
    print(f"Serving single_app.py on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
