#!/usr/bin/env python3
"""Privacy-safe, files-only tracing wrapper for approved AI command-line tools.

Only file paths and mutation metadata are persisted. File data and traced command
arguments are never added to the queue or upload payload.
"""
from __future__ import annotations

import argparse
import ast
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import fcntl
import hmac
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
from typing import Iterable, Sequence
from urllib import request
from urllib.error import URLError, HTTPError
import uuid
import time
from urllib.parse import urlsplit

VERSION = "2.0.0"
SYSCALLS = (
    "clone,clone3,fork,vfork,chdir,fchdir,openat,openat2,creat,close,dup,dup2,dup3,fcntl,"
    "write,pwrite64,pwritev,pwritev2,writev,truncate,ftruncate,fallocate,mmap,mmap2,msync,munmap,"
    "copy_file_range,sendfile,rename,renameat,renameat2,unlink,unlinkat,"
    "mkdir,mkdirat,rmdir,link,linkat,symlink,symlinkat"
)
RAW_SYSCALLS = "write,pwrite64,pwritev,pwritev2,writev,copy_file_range,sendfile"
WRITE_FLAGS = ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_TMPFILE")
AGENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
APPROVED_AGENTS = frozenset(("hermes", "codex", "claude"))
GIT_EVENT_TYPES = frozenset(("commit", "branch", "merge", "rewrite", "pull", "stage", "push"))
LINE_RE = re.compile(r"^(?:(?:\[pid\s+)?(\d+)\]?\s+)?(.*)$")
CALL_RE = re.compile(r"^(\w+)\((.*)\)\s+=\s+(.+)$")
RESUMED_RE = re.compile(r"^<\.\.\.\s+(\w+) resumed>(.*)$")
FD_RE = re.compile(r"^\s*(?:0x([0-9a-fA-F]+)|(\d+))(?:<([^>]*)>)?")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Event:
    action: str
    path: str
    bytes: int = 0
    count: int = 1
    occurred_at: str = field(default_factory=utc_now)

    def as_dict(self) -> dict:
        return {"action": self.action, "path": self.path, "bytes": self.bytes,
                "count": self.count, "occurred_at": self.occurred_at}


def split_args(text: str) -> list[str]:
    parts, start, depth, quote, escaped = [], 0, 0, None, False
    for index, char in enumerate(text):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char in "[{(":
            depth += 1
        elif char in "]})":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
    parts.append(text[start:].strip())
    return parts


def decoded_string(value: str) -> str | None:
    value = value.strip()
    if not value.startswith('"'):
        return None
    try:
        parsed = ast.literal_eval(value)
        return parsed if isinstance(parsed, str) else None
    except (SyntaxError, ValueError):
        return None


def fd_info(value: str) -> tuple[int | None, str | None]:
    match = FD_RE.match(value)
    if not match:
        return None, None
    number = int(match.group(1), 16) if match.group(1) else int(match.group(2))
    return number, match.group(3)


class TraceParser:
    """Turn successful strace mutation calls into coalesced metadata events."""

    def __init__(self, initial_cwd: str, excluded_paths: Sequence[str],
                 allowed_roots: Sequence[str] | None = None):
        self.initial_cwd = os.path.abspath(initial_cwd)
        self.excluded = [os.path.abspath(p) for p in excluded_paths]
        self.allowed_roots = ([os.path.abspath(p) for p in allowed_roots]
                              if allowed_roots is not None else None)
        # Mutable containers model CLONE_FS and CLONE_FILES sharing while
        # ordinary descendants receive a point-in-time copy.
        self.cwd: dict[str, list[str]] = {}
        self.fds: dict[str, dict[int, str]] = {}
        self.pending: dict[str, str] = {}
        self.events: dict[tuple[str, str], Event] = {}
        self.shared_mmaps: dict[str, tuple[int, int, int, int] | None] = {}
        self.mmap_regions: dict[tuple[str, int], tuple[int, str]] = {}
        self.confirmed_mmaps: set[str] = set()
        self.observed_metadata: dict[str, tuple[int, int, int, int] | None] = {}

    @staticmethod
    def _metadata(path: str) -> tuple[int, int, int, int] | None:
        try:
            value = os.stat(path, follow_symlinks=False)
            return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns
        except OSError:
            return None

    def _cwd(self, pid: str) -> str:
        return self._cwd_state(pid)[0]

    def _cwd_state(self, pid: str) -> list[str]:
        return self.cwd.setdefault(pid, [self.initial_cwd])

    def _fd_state(self, pid: str) -> dict[int, str]:
        return self.fds.setdefault(pid, {})

    def _spawn(self, parent: str, child: str, flags: str) -> None:
        parent_cwd = self._cwd_state(parent)
        parent_fds = self._fd_state(parent)
        self.cwd[child] = parent_cwd if "CLONE_FS" in flags else parent_cwd.copy()
        self.fds[child] = parent_fds if "CLONE_FILES" in flags else parent_fds.copy()

    def _allowed(self, path: str) -> bool:
        normalized = os.path.normpath(path)
        if self.allowed_roots is not None and not any(
                normalized == root or normalized.startswith(root + os.sep)
                for root in self.allowed_roots):
            return False
        if normalized == "/proc" or normalized.startswith("/proc/"):
            return False
        if normalized == "/sys" or normalized.startswith("/sys/"):
            return False
        if normalized == "/dev" or normalized.startswith("/dev/"):
            return False
        return not any(normalized == p or normalized.startswith(p + "-") or normalized.startswith(p + "/")
                       for p in self.excluded)

    def _add(self, action: str, path: str | None, amount: int = 0) -> None:
        if not path:
            return
        path = os.path.normpath(path)
        if not os.path.isabs(path) or not self._allowed(path):
            return
        key = action, path
        if key in self.events:
            self.events[key].count += 1
            self.events[key].bytes += max(0, amount)
        else:
            self.events[key] = Event(action, path, max(0, amount))

    def _resolve(self, pid: str, value: str, dirfd: str | None = None) -> str | None:
        path = decoded_string(value)
        if path is None:
            return None
        if os.path.isabs(path):
            return os.path.normpath(path)
        base = self._cwd(pid)
        if dirfd:
            _number, annotated = fd_info(dirfd)
            annotation = annotated
            if annotation and os.path.isabs(annotation):
                base = annotation
            elif dirfd.startswith("AT_FDCWD<"):
                annotation = dirfd.partition("<")[2].rpartition(">")[0]
                if os.path.isabs(annotation):
                    base = annotation
        return os.path.normpath(os.path.join(base, path))

    def _fd_path(self, pid: str, value: str) -> str | None:
        number, annotation = fd_info(value)
        if annotation and os.path.isabs(annotation):
            return os.path.normpath(annotation)
        return self._fd_state(pid).get(number) if number is not None else None

    @staticmethod
    def _successful(result: str) -> bool:
        match = re.match(r"\s*(-?(?:0x[0-9a-fA-F]+|\d+))", result)
        if not match:
            return False
        try:
            return int(match.group(1), 0) >= 0
        except ValueError:
            return False

    @staticmethod
    def _result_int(result: str) -> int:
        match = re.match(r"\s*(-?(?:0x[0-9a-fA-F]+|\d+))", result)
        if not match:
            return 0
        try:
            return int(match.group(1), 0)
        except ValueError:
            return 0

    def parse(self, lines: Iterable[str]) -> list[Event]:
        source = iter(lines)
        work: deque[str] = deque()
        waiting: dict[str, list[str]] = {}
        while True:
            if not work:
                try:
                    work.append(next(source))
                except StopIteration:
                    break
            raw_line = work.popleft()
            match = LINE_RE.match(raw_line.rstrip("\n"))
            if not match:
                continue
            pid, body = match.group(1) or "root", match.group(2)
            spawn_pending = any(re.match(r"^(?:clone|clone3|fork|vfork)\(", pending)
                                for pending in self.pending.values())
            if pid not in self.cwd and pid not in self.fds and spawn_pending and not RESUMED_RE.match(body):
                waiting.setdefault(pid, []).append(raw_line)
                continue
            if "<unfinished ...>" in body:
                self.pending[pid] = body.replace("<unfinished ...>", "")
                continue
            resumed = RESUMED_RE.match(body)
            if resumed:
                prefix = self.pending.pop(pid, resumed.group(1) + "(")
                body = prefix + resumed.group(2)
            call = CALL_RE.match(body)
            if not call:
                continue
            name, arg_text, result = call.groups()
            if not self._successful(result):
                continue
            args = split_args(arg_text)
            try:
                self._call(pid, name, args, result)
            except (IndexError, ValueError):
                continue
            if name in ("clone", "clone3", "fork", "vfork"):
                child = str(self._result_int(result))
                for deferred in reversed(waiting.pop(child, [])):
                    work.appendleft(deferred)
        for path, before in self.shared_mmaps.items():
            if path not in self.confirmed_mmaps and self._metadata(path) != before:
                self._add("write", path)
        return sorted(self.events.values(), key=lambda event: (event.path, event.action))

    def _call(self, pid: str, name: str, args: list[str], result: str) -> None:
        if name in ("clone", "clone3", "fork", "vfork"):
            child = self._result_int(result)
            if child > 0:
                flags = "|".join(args) if name.startswith("clone") else ""
                self._spawn(pid, str(child), flags)
            return
        if name == "chdir":
            path = self._resolve(pid, args[0])
            if path:
                self._cwd_state(pid)[0] = path
            return
        if name == "fchdir":
            path = self._fd_path(pid, args[0])
            if path:
                self._cwd_state(pid)[0] = path
            return
        if name in ("openat", "openat2"):
            path = self._resolve(pid, args[1], args[0])
            flags = args[2]
            fd = self._result_int(result)
            if path:
                self._fd_state(pid)[fd] = path
                # strace output can trail the tracee slightly; capture metadata
                # at the earliest path-identifying call without opening/reading it.
                self.observed_metadata.setdefault(path, self._metadata(path))
            if any(flag in flags for flag in WRITE_FLAGS):
                self._add("create" if ("O_CREAT" in flags or "O_TMPFILE" in flags) else "open_write", path)
            return
        if name == "creat":
            path, fd = self._resolve(pid, args[0]), self._result_int(result)
            if path:
                self._fd_state(pid)[fd] = path
            self._add("create", path)
            return
        if name == "close":
            fd, _ = fd_info(args[0])
            if fd is not None:
                self._fd_state(pid).pop(fd, None)
            return
        if name in ("dup", "dup2", "dup3"):
            source = self._fd_path(pid, args[0])
            destination = self._result_int(result) if name == "dup" else (fd_info(args[1])[0])
            if source and destination is not None:
                self._fd_state(pid)[destination] = source
            return
        if name == "fcntl" and len(args) > 1 and "F_DUPFD" in args[1]:
            source, destination = self._fd_path(pid, args[0]), self._result_int(result)
            if source:
                self._fd_state(pid)[destination] = source
            return
        if name in ("write", "pwrite64", "pwritev", "pwritev2", "writev"):
            self._add("write", self._fd_path(pid, args[0]), self._result_int(result))
            return
        if name == "ftruncate":
            self._add("truncate", self._fd_path(pid, args[0]))
            return
        if name == "truncate":
            self._add("truncate", self._resolve(pid, args[0]))
            return
        if name in ("mmap", "mmap2") and len(args) >= 5:
            if "PROT_WRITE" in args[2] and "MAP_SHARED" in args[3]:
                path = self._fd_path(pid, args[4])
                if path and self._allowed(path) and path not in self.shared_mmaps:
                    self.shared_mmaps[path] = self.observed_metadata.get(path, self._metadata(path))
                address = self._result_int(result)
                length = self._result_int(args[1])
                if path and address > 0 and length > 0:
                    self.mmap_regions[(pid, address)] = (address + length, path)
            return
        if name == "msync" and len(args) >= 2:
            start = self._result_int(args[0])
            end = start + self._result_int(args[1])
            for (owner, region_start), (region_end, path) in self.mmap_regions.items():
                if owner == pid and start < region_end and end > region_start:
                    self._add("write", path)
                    self.confirmed_mmaps.add(path)
            return
        if name == "fallocate":
            self._add("write", self._fd_path(pid, args[0]))
            return
        if name == "copy_file_range":
            self._add("write", self._fd_path(pid, args[2]), self._result_int(result))
            return
        if name == "sendfile":
            self._add("write", self._fd_path(pid, args[0]), self._result_int(result))
            return
        if name in ("mkdir", "rmdir", "unlink"):
            self._add(name, self._resolve(pid, args[0]))
            return
        if name in ("mkdirat", "unlinkat"):
            self._add("mkdir" if name == "mkdirat" else "unlink", self._resolve(pid, args[1], args[0]))
            return
        if name in ("rename", "link"):
            self._add(name + "_from", self._resolve(pid, args[0]))
            self._add(name + "_to", self._resolve(pid, args[1]))
            return
        if name in ("renameat", "renameat2", "linkat"):
            action = "link" if name == "linkat" else "rename"
            self._add(action + "_from", self._resolve(pid, args[1], args[0]))
            self._add(action + "_to", self._resolve(pid, args[3], args[2]))
            return
        if name == "symlink":
            self._add("symlink", self._resolve(pid, args[1]))
            return
        if name == "symlinkat":
            self._add("symlink", self._resolve(pid, args[2], args[1]))


class Queue:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
            ).fetchone()
            desired_columns = {
                "id", "event_id", "run_id", "agent", "action", "path",
                "bytes", "count", "occurred_at",
            }
            migrate = False
            if existing:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(events)")}
                unique_indexes = []
                for index in connection.execute("PRAGMA index_list(events)"):
                    if index[2]:
                        unique_indexes.append(tuple(
                            row[2] for row in connection.execute(
                                f'PRAGMA index_info("{index[1]}")'
                            )
                        ))
                migrate = (
                    columns != desired_columns
                    or "AUTOINCREMENT" not in existing[0].upper()
                    or ("run_id", "agent", "action", "path") in unique_indexes
                )
                if migrate:
                    connection.execute("ALTER TABLE events RENAME TO events_legacy")
            connection.execute("""CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                run_id TEXT NOT NULL, agent TEXT NOT NULL,
                action TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
                count INTEGER NOT NULL, occurred_at TEXT NOT NULL)""")
            connection.execute("""CREATE TABLE IF NOT EXISTS trace_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                binding_id TEXT NOT NULL, event_key TEXT NOT NULL,
                payload TEXT NOT NULL, created_at TEXT NOT NULL)""")
            trace_indexes = [tuple(row[2] for row in connection.execute(f'PRAGMA index_info("{index[1]}")'))
                             for index in connection.execute("PRAGMA index_list(trace_events)") if index[2]]
            if ("event_key",) in trace_indexes:
                connection.execute("ALTER TABLE trace_events RENAME TO trace_events_legacy")
                connection.execute("""CREATE TABLE trace_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id TEXT NOT NULL,
                    event_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)""")
                connection.execute("""INSERT INTO trace_events(id,binding_id,event_key,payload,created_at)
                    SELECT id,binding_id,event_key,payload,created_at FROM trace_events_legacy ORDER BY id""")
                connection.execute("DROP TABLE trace_events_legacy")
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS trace_events_binding_key ON trace_events(binding_id,event_key)")
            if migrate:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(events_legacy)")}
                rows = connection.execute("SELECT * FROM events_legacy ORDER BY id").fetchall()
                for row in rows:
                    event_id = row["event_id"] if "event_id" in columns and row["event_id"] else uuid.uuid4().hex
                    connection.execute("""INSERT INTO events
                        (id,event_id,run_id,agent,action,path,bytes,count,occurred_at)
                        VALUES (?,?,?,?,?,?,?,?,?)""",
                        (row["id"], event_id, row["run_id"], row["agent"], row["action"],
                         row["path"], row["bytes"], row["count"], row["occurred_at"]))
                connection.execute("DROP TABLE events_legacy")
        os.chmod(self.path, 0o600)

    def enqueue(self, agent: str, run_id: str, events: Sequence[Event]) -> None:
        # A queue row is also the idempotent wire contribution. Never merge or
        # mutate it after insertion: retries must serialize the exact same event_id
        # and values, while later matching contributions receive independent IDs.
        with self._connection() as connection:
            connection.executemany("""INSERT INTO events
                (event_id,run_id,agent,action,path,bytes,count,occurred_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                [(uuid.uuid4().hex, run_id, agent, e.action, e.path, e.bytes, e.count, e.occurred_at)
                 for e in events])

    def pending(self, limit: int = 250) -> list[dict]:
        with self._connection() as connection:
            rows = connection.execute("SELECT * FROM events ORDER BY id LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    def ack(self, rows: Sequence[dict]) -> None:
        if not rows:
            return
        with self._connection() as connection:
            for item in rows:
                # Both keys bind the acknowledgment to the exact immutable row
                # snapshot selected for upload; never acknowledge by position alone.
                connection.execute(
                    "DELETE FROM events WHERE id=? AND event_id=?",
                    (item["id"], item["event_id"]),
                )

    def count(self) -> int:
        with self._connection() as connection:
            return int(connection.execute("SELECT count(*) FROM events").fetchone()[0])

    def enqueue_trace(self, binding_id: str, records: Sequence[dict]) -> None:
        with self._connection() as connection:
            connection.executemany(
                "INSERT OR IGNORE INTO trace_events(binding_id,event_key,payload,created_at) VALUES(?,?,?,?)",
                [(binding_id, record["event_key"], json.dumps(record, separators=(",", ":")), utc_now())
                 for record in records],
            )

    def pending_trace(self, binding_id: str, limit: int = 250) -> list[dict]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT id,binding_id,event_key,payload FROM trace_events WHERE binding_id=? ORDER BY id LIMIT ?",
                (binding_id, limit),
            ).fetchall()
        return [{"id": row["id"], "binding_id": row["binding_id"], "event_key": row["event_key"], "payload": json.loads(row["payload"])} for row in rows]

    def ack_trace(self, rows: Sequence[dict]) -> None:
        with self._connection() as connection:
            connection.executemany("DELETE FROM trace_events WHERE id=? AND binding_id=? AND event_key=?",
                                   [(row["id"], row["binding_id"], row["event_key"]) for row in rows])

    def purge_trace(self, binding_id: str) -> int:
        with self._connection() as connection:
            result = connection.execute("DELETE FROM trace_events WHERE binding_id=?", (binding_id,))
            return result.rowcount

    def trace_count(self) -> int:
        with self._connection() as connection:
            return int(connection.execute("SELECT count(*) FROM trace_events").fetchone()[0])


def paths() -> tuple[Path, Path]:
    config = Path(os.environ.get("FILES_AGENT_CONFIG", "~/.config/files-agent/config.json")).expanduser()
    state = Path(os.environ.get("FILES_AGENT_STATE_DIR", "~/.local/state/files-agent")).expanduser()
    return config, state


def load_config(required: bool = True) -> dict:
    config_path, _state = paths()
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        if not required:
            return {}
        raise RuntimeError(f"cannot load config {config_path}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"config {config_path} must contain a JSON object")
    if required:
        if not value.get("endpoint") or not value.get("device_token"):
            raise RuntimeError("config requires endpoint and device_token")
        agents = value.get("agents")
        if not isinstance(agents, list) or not agents:
            raise RuntimeError("config requires a nonempty agents list")
        if any(not isinstance(agent, str) or not AGENT_RE.fullmatch(agent) for agent in agents):
            raise RuntimeError("config agents must contain valid agent names")
        if any(agent not in APPROVED_AGENTS for agent in agents):
            raise RuntimeError("config agents may contain only hermes, codex, or claude")
        mappings = value.get("agent_commands")
        if not isinstance(mappings, dict):
            raise RuntimeError("config requires an agent_commands mapping")
        bindings = value.get("bindings", [])
        if not isinstance(bindings, list):
            raise RuntimeError("config bindings must be a list")
        for binding in bindings:
            if (not isinstance(binding, dict) or not isinstance(binding.get("root"), str)
                    or not isinstance(binding.get("binding_id"), str)
                    or not isinstance(binding.get("binding_secret"), str)
                    or _canonical_root(binding["root"]) != binding["root"]):
                raise RuntimeError("each binding requires a canonical root and opaque credentials")
        for agent in agents:
            commands = mappings.get(agent)
            if isinstance(commands, str):
                commands = [commands]
                mappings[agent] = commands
            if not isinstance(commands, list) or not commands:
                raise RuntimeError(f"config agent_commands requires one or more paths for {agent!r}")
            for command in commands:
                if (not isinstance(command, str) or not os.path.isabs(command)
                        or os.path.realpath(command) != command
                        or not os.path.isfile(command) or not os.access(command, os.X_OK)):
                    raise RuntimeError(
                        "config agent_commands must contain canonical absolute executable paths"
                    )
    return value


def device_id(state: Path) -> str:
    path = state / "device-id"
    if not path.exists():
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(str(uuid.uuid4()), encoding="ascii")
        path.chmod(0o600)
    return path.read_text(encoding="ascii").strip()


def flush(queue: Queue, config: dict, state: Path) -> int:
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = state / "flush.lock"
    with open(lock_path, "a+b") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _flush_locked(queue, config, state)


def _flush_locked(queue: Queue, config: dict, state: Path) -> int:
    total = 0
    while True:
        rows = queue.pending(250)
        if not rows:
            return total
        safe_rows = [{key: row[key] for key in ("event_id", "run_id", "agent", "action", "path", "bytes", "count", "occurred_at")}
                     for row in rows]
        body = json.dumps({"device_id": device_id(state), "events": safe_rows}, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "User-Agent": f"files-agent/{VERSION}"}
        if config.get("auth", "bearer") == "x-device-token":
            headers["x-device-token"] = config["device_token"]
        else:
            headers["Authorization"] = "Bearer " + config["device_token"]
        req = request.Request(config["endpoint"], data=body, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=float(config.get("timeout_seconds", 10))) as response:
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"upload returned HTTP {response.status}")
        except (HTTPError, URLError, OSError) as error:
            raise RuntimeError(f"upload failed; events retained: {error}") from error
        queue.ack(rows)
        total += len(rows)


def _canonical_root(root: str) -> str:
    value = os.path.realpath(root)
    if value == "/" or not os.path.isabs(value) or not os.path.isdir(value):
        raise RuntimeError("root must be an existing checked-out directory")
    return value


def root_binding_hash(root: str, binding_code: str) -> str:
    """Opaque, code-scoped root proof; never a plain hash of a predictable path."""
    return hmac.new(binding_code.encode(), _canonical_root(root).encode(), "sha256").hexdigest()


def select_binding(config: dict, root: str) -> dict | None:
    """Select the longest explicitly bound root containing root; never guess a project."""
    root = _canonical_root(root)
    candidates = []
    for binding in config.get("bindings", []):
        bound = binding.get("root")
        try:
            if binding.get("disabled"):
                continue
            if not isinstance(bound, str) or _canonical_root(bound) != bound:
                continue
            if os.path.commonpath([root, bound]) == bound:
                candidates.append(binding)
        except (TypeError, ValueError):
            continue
    return max(candidates, key=lambda item: len(item["root"]), default=None)


def _binding_headers(binding: dict, body: bytes) -> dict:
    binding_id = binding.get("binding_id")
    binding_secret = binding.get("binding_secret")
    if not isinstance(binding_id, str) or not isinstance(binding_secret, str) or not binding_id or not binding_secret:
        raise RuntimeError("TraceMini root binding is required; run bind first")
    return _signed_headers(binding, "POST", body)


def _signed_headers(binding: dict, method: str, body: bytes) -> dict:
    binding_id = binding.get("binding_id")
    binding_secret = binding.get("binding_secret")
    if not isinstance(binding_id, str) or not isinstance(binding_secret, str) or not binding_id or not binding_secret:
        raise RuntimeError("TraceMini root binding is required; run bind first")
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    path = urlsplit(binding.get("endpoint", "")).path or "/api/files-agent/tracemini"
    digest = hashlib.sha256(body).hexdigest()
    canonical = "\n".join((method.upper(), path, timestamp, nonce, digest)).encode()
    signature = hmac.new(binding_secret.encode(), canonical, "sha256").hexdigest()
    return {"X-TraceMini-Binding": binding_id, "X-TraceMini-Signature": signature,
            "X-TraceMini-Timestamp": timestamp, "X-TraceMini-Nonce": nonce}


def _post_json(url: str, config: dict, body: dict, binding: dict | None = None) -> dict:
    encoded = json.dumps(body, separators=(",", ":")).encode()
    headers = {"Content-Type": "application/json", "User-Agent": f"files-agent/{VERSION}"}
    if config.get("auth", "bearer") == "x-device-token":
        headers["x-device-token"] = config["device_token"]
    else:
        headers["Authorization"] = "Bearer " + config["device_token"]
    if binding is not None:
        binding = {**binding, "endpoint": url}
        headers.update(_signed_headers(binding, "POST", encoded))
    attempts = max(1, min(5, int(config.get("max_retries", 4))))
    for attempt in range(attempts):
        if binding is not None:
            # Every attempt needs a fresh nonce because the server rejects replayed proofs.
            binding = {**binding, "endpoint": url}
            headers.update(_signed_headers(binding, "POST", encoded))
        req = request.Request(url, data=encoded, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=float(config.get("timeout_seconds", 10))) as response:
                if not 200 <= response.status < 300:
                    raise HTTPError(url, response.status, "non-success", response.headers, None)
                return json.loads(response.read(1_000_000).decode() or "{}")
        except HTTPError as error:
            retryable = error.code == 429 or error.code >= 500
            if not retryable or attempt + 1 == attempts:
                detail = ""
                try:
                    detail = error.read(4096).decode("utf-8", "replace")
                except OSError:
                    pass
                raise RuntimeError(f"request failed with HTTP {error.code}: {detail}") from error
        except (URLError, OSError, TimeoutError) as error:
            if attempt + 1 == attempts:
                raise RuntimeError(f"request failed after retries: {error}") from error
        time.sleep(min(8.0, 0.25 * (2 ** attempt)))
    raise RuntimeError("request failed")


def git_root(root: str) -> str | None:
    try:
        return _canonical_root(subprocess.check_output(
            ["git", "-C", root, "rev-parse", "--show-toplevel"], text=True,
            stderr=subprocess.DEVNULL, timeout=3).strip())
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return None


def repository_metadata(root: str) -> dict:
    repo = git_root(root)
    if not repo:
        return {"kind": "non_git", "repository_key": None,
                "provenance": {"root_label": os.path.basename(root)}}
    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", repo, *args], text=True,
                                       stderr=subprocess.DEVNULL, timeout=3).strip()
    branch, head = git("branch", "--show-current") or "HEAD", git("rev-parse", "HEAD")
    try:
        remote = git("config", "--get", "remote.origin.url")
    except (OSError, subprocess.SubprocessError):
        remote = ""
    status = git("status", "--porcelain", "--untracked-files=all")
    key = canonical_repository_key(remote, repo, head)
    def digest_diff(*args: str) -> str:
        result = subprocess.run(["git", "-C", repo, "diff", "--binary", *args], capture_output=True, timeout=3, check=False)
        return hashlib.sha256(result.stdout).hexdigest() if result.returncode == 0 else ""
    try:
        upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
        upstream_head = git("rev-parse", "@{upstream}")
    except (OSError, subprocess.SubprocessError):
        upstream, upstream_head = "", ""
    provenance = {"branch": branch, "head_sha": head, "repository_key": key,
                  "index_digest": digest_diff("--cached"), "worktree_digest": digest_diff(),
                  "parent_count": len(git("rev-list", "--parents", "-n", "1", "HEAD").split()) - 1,
                  "upstream_head_sha": upstream_head}
    remote_head = ""
    if remote and branch != "HEAD":
        try:
            remote_head = verify_remote(repo, remote, f"refs/heads/{branch}")
        except RuntimeError:
            pass
    provenance["remote_branch_sha"] = remote_head
    if status:
        provenance.update({"dirty": True, "dirty_paths": min(len(status.splitlines()), 1000)})
    return {"kind": "git", "repository_key": key, "provenance": provenance, "dirty": bool(status)}


def canonical_repository_key(remote: str, repo: str, head: str) -> str:
    """Return a stable credential-free identity; never persist a raw remote URL."""
    remote = (remote or "").strip()
    if remote:
        parsed = urlsplit(remote)
        if parsed.scheme == "file":
            if parsed.username or parsed.query or parsed.fragment or not parsed.path or not os.path.isabs(parsed.path):
                raise RuntimeError("repository remote is invalid")
            return f"local:{hashlib.sha256((os.path.realpath(repo) + ':' + parsed.path).encode()).hexdigest()}"
        if parsed.scheme in ("http", "https"):
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise RuntimeError("repository remote contains credentials or query data")
            host = (parsed.hostname or "").lower()
            path = parsed.path.rstrip("/")
            if not host or not path:
                raise RuntimeError("repository remote is invalid")
            return f"{host}{path[:-4] if path.endswith('.git') else path}".lower()
        if remote.startswith("git@") and ":" in remote:
            host, path = remote[4:].split(":", 1)
            if not host or not path or any(mark in path for mark in "?#"):
                raise RuntimeError("repository remote is invalid")
            return f"{host.lower()}/{path[:-4] if path.endswith('.git') else path}".lower()
        raise RuntimeError("repository remote must be HTTPS or standard SCP form")
    return f"local:{hashlib.sha256((os.path.realpath(repo) + ':' + head).encode()).hexdigest()}"


def verify_remote(root: str, remote: str, ref: str = "HEAD") -> str:
    """Bounded, credential-free remote fact check; client booleans are ignored."""
    canonical_repository_key(remote, _canonical_root(root), "0" * 40)
    if not ref.startswith("refs/"):
        raise RuntimeError("remote verification requires an exact ref")
    result = subprocess.run(["git", "-C", _canonical_root(root), "ls-remote", "--refs", remote, ref],
                            text=True, capture_output=True, timeout=5, check=False)
    if result.returncode != 0:
        raise RuntimeError("remote verification unavailable")
    return result.stdout.split()[0] if result.stdout.split() else ""


def _origin_remote(root: str) -> str:
    try:
        remote = subprocess.check_output(["git", "-C", _canonical_root(root), "config", "--get", "remote.origin.url"],
                                         text=True, stderr=subprocess.DEVNULL, timeout=3).strip()
        canonical_repository_key(remote, root, "0" * 40)
        return remote
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return ""


def _history_rewritten(root: str, old_head: str, new_head: str) -> bool:
    result = subprocess.run(["git", "-C", _canonical_root(root), "merge-base", "--is-ancestor", old_head, new_head],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
    return result.returncode != 0


def poll_reports(config: dict) -> None:
    endpoint = config.get("report_poll_url")
    if endpoint:
        _post_json(endpoint, config, {"at": utc_now()})


def _verified_push(root: str, metadata: dict) -> bool:
    if metadata.get("kind") != "git" or not metadata.get("repository_key"):
        return False
    remote = _origin_remote(root)
    if not remote or remote.startswith("local:"):
        return False
    try:
        branch = metadata["provenance"].get("branch") or "HEAD"
        output = subprocess.check_output(["git", "ls-remote", remote, f"refs/heads/{branch}"], text=True,
                                         stderr=subprocess.DEVNULL, timeout=8)
        return any(line.split()[0] == metadata["provenance"].get("head_sha")
                   and len(line.split()) > 1 and line.split()[1] == f"refs/heads/{branch}"
                   for line in output.splitlines() if line.split())
    except (OSError, subprocess.SubprocessError):
        return False


def enqueue_tracemini(queue: Queue, config: dict, root: str, agent: str,
                      file_events: Sequence[Event], before: dict | None = None) -> None:
    root = _canonical_root(root)
    binding = select_binding(config, root)
    if not binding:
        return
    metadata = repository_metadata(root)
    now, run_id = utc_now(), secrets.token_hex(16)
    common = {"run_id": run_id, "agent": agent, "occurred_at": now,
              "repository_key": metadata.get("repository_key")}
    records = [{**common, "event_key": secrets.token_hex(24), "kind": "file_activity",
                "action": "approved_agent_mutation",
                "provenance": {"files_changed": min(len(file_events), 1000)}}]
    if metadata["kind"] == "non_git":
        records.append({**common, "event_key": secrets.token_hex(24), "kind": "non_git",
                        "action": "approved_agent_non_git_activity", "provenance": {}})
    else:
        prior = before or {}
        old_head = prior.get("provenance", {}).get("head_sha")
        new_head = metadata["provenance"].get("head_sha")
        old_branch = prior.get("provenance", {}).get("branch")
        new_branch = metadata["provenance"].get("branch")
        if old_head and new_head and old_head != new_head:
            records.append({**common, "event_key": secrets.token_hex(24), "kind": "commit",
                            "action": "head_changed", "provenance": {"old_head_sha": old_head, "new_head_sha": new_head,
                                                                          "branch": new_branch}})
            if _history_rewritten(root, old_head, new_head):
                records.append({**common, "event_key": secrets.token_hex(24), "kind": "rewrite",
                                "action": "history_rewritten", "provenance": {"old_head_sha": old_head, "new_head_sha": new_head}})
            if metadata["provenance"].get("parent_count", 0) > 1:
                records.append({**common, "event_key": secrets.token_hex(24), "kind": "merge",
                                "action": "merge_commit", "provenance": {"new_head_sha": new_head}})
            if metadata["provenance"].get("upstream_head_sha") == new_head:
                records.append({**common, "event_key": secrets.token_hex(24), "kind": "pull",
                                "action": "upstream_head_observed", "provenance": {"new_head_sha": new_head}})
        if (prior.get("provenance", {}).get("index_digest")
                and prior.get("provenance", {}).get("index_digest") != metadata["provenance"].get("index_digest")):
            records.append({**common, "event_key": secrets.token_hex(24), "kind": "stage",
                            "action": "index_changed", "provenance": {}})
        if old_branch and old_branch != new_branch:
            records.append({**common, "event_key": secrets.token_hex(24), "kind": "branch",
                            "action": "branch_changed", "provenance": {"branch": new_branch}})
        if metadata.get("dirty"):
            records.append({**common, "event_key": secrets.token_hex(24), "kind": "dirty",
                            "action": "working_tree_dirty", "provenance": {}})
        if (_verified_push(root, metadata)
                and before
                and before.get("provenance", {}).get("remote_branch_sha") != metadata["provenance"].get("remote_branch_sha")):
            records.append({**common, "event_key": secrets.token_hex(24), "kind": "push",
                            "action": "remote_head_observed", "provenance": {"head_sha": new_head, "remote_head_sha": new_head}})
    queue.enqueue_trace(binding["binding_id"], records)


def heartbeat(config: dict) -> None:
    queue = Queue(paths()[1] / "queue.sqlite3")
    for binding in config.get("bindings", []):
        if binding.get("disabled"):
            continue
        endpoint = config.get("heartbeat_url") or config.get("tracemini_endpoint", config.get("endpoint", "")) + "/heartbeat"
        try:
            response = _post_json(endpoint, config, {"at": utc_now()}, binding=binding)
            if response.get("paused") or response.get("revoked") or response.get("purge"):
                queue.purge_trace(binding["binding_id"])
                binding["disabled"] = True
        except RuntimeError as error:
            if ("HTTP 401" in str(error) or "HTTP 403" in str(error)
                    or "paused" in str(error).lower() or "telemetry" in str(error).lower()):
                queue.purge_trace(binding["binding_id"])
                binding["disabled"] = True
            raise


def flush_tracemini(config: dict, state: Path) -> int:
    queue = Queue(state / "queue.sqlite3")
    endpoint = config.get("tracemini_endpoint") or config.get("endpoint", "").replace("/api/files-agent/ingest", "/api/files-agent/tracemini")
    total = 0
    for binding in config.get("bindings", []):
        if binding.get("disabled"):
            continue
        while True:
            rows = queue.pending_trace(binding["binding_id"], 250)
            if not rows:
                break
            try:
                response = _post_json(endpoint, config, {"events": [row["payload"] for row in rows]}, binding=binding)
            except RuntimeError as error:
                if ("HTTP 401" in str(error) or "HTTP 403" in str(error)
                        or "paused" in str(error).lower() or "telemetry" in str(error).lower()):
                    queue.purge_trace(binding["binding_id"])
                    binding["disabled"] = True
                raise
            if response.get("paused") or response.get("revoked") or response.get("purge"):
                queue.purge_trace(binding["binding_id"])
                binding["disabled"] = True
                break
            queue.ack_trace(rows)
            total += len(rows)
    return total


def upload_tracemini(config: dict, state: Path) -> int:
    """Named command API used by installers and tests."""
    return flush_tracemini(config, state)


def spawn_flush(config_path: Path, state: Path) -> None:
    if os.environ.get("FILES_AGENT_NO_BACKGROUND"):
        return
    env = os.environ.copy()
    env["FILES_AGENT_CONFIG"] = str(config_path)
    env["FILES_AGENT_STATE_DIR"] = str(state)
    with open(os.devnull, "rb") as source, open(os.devnull, "ab") as sink:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "flush", "--quiet"],
                         stdin=source, stdout=sink, stderr=sink, env=env, start_new_session=True,
                         close_fds=True)


def execute(agent: str, command: list[str]) -> int:
    config_path, state = paths()
    config = load_config()
    approved = config["agents"]
    if not AGENT_RE.fullmatch(agent):
        raise RuntimeError("invalid agent name")
    if agent not in approved:
        raise RuntimeError(f"agent {agent!r} is not approved by configuration")
    if not command:
        raise RuntimeError("exec requires -- REALCMD...")
    if command[0] == "--":
        command = command[1:]
    if not command:
        raise RuntimeError("exec requires -- REALCMD...")
    executable = shutil.which(command[0])
    if not executable:
        raise RuntimeError(f"command executable {command[0]!r} was not found")
    executable = os.path.realpath(executable)
    if executable not in config["agent_commands"][agent]:
        raise RuntimeError(f"command executable does not match agent {agent!r} mapping")
    command[0] = executable
    tracer = shutil.which("strace")
    if not tracer:
        raise RuntimeError("strace is required")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    queue = Queue(state / "queue.sqlite3")
    read_fd, write_fd = os.pipe()
    trace_command = [tracer, "-f", "-yy", "-qq", "-e", "trace=" + SYSCALLS,
                     "-e", "raw=" + RAW_SYSCALLS, "-o", f"/proc/self/fd/{write_fd}", "--", *command]
    initial_cwd = _canonical_root(os.getcwd())
    binding = select_binding(config, initial_cwd)
    before_metadata = repository_metadata(initial_cwd) if binding else None
    try:
        completed = subprocess.Popen(trace_command, pass_fds=(write_fd,))
        os.close(write_fd)
        write_fd = -1
        with os.fdopen(read_fd, encoding="utf-8", errors="replace") as trace:
            read_fd = -1
            events = TraceParser(initial_cwd, [str(queue.path), str(state)],
                                 allowed_roots=[initial_cwd]).parse(trace)
        return_code = completed.wait()
        if events:
            queue.enqueue(agent, secrets.token_hex(16), events)
            if binding:
                enqueue_tracemini(queue, config, initial_cwd, agent, events, before_metadata)
        # Flush embedded provenance even when this invocation made no file
        # events; the ordinary files queue remains available to its own worker.
        # Both queues are best-effort: an unavailable server must never discard
        # either queue or turn a successful approved command into data loss.
        flush_calls = ([lambda: flush(queue, config, state)] if config.get("bindings") else [])
        flush_calls.append(lambda: flush_tracemini(config, state))
        for flush_call in flush_calls:
            try:
                flush_call()
            except RuntimeError:
                pass
        return return_code
    finally:
        if read_fd >= 0:
            os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="files-agent", description="Files-only AI CLI tracer")
    parser.add_argument("--version", action="version", version=VERSION)
    commands = parser.add_subparsers(dest="subcommand", required=True)
    run = commands.add_parser("exec", help="trace an approved command")
    run.add_argument("--agent", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    commands.add_parser("status", help="show queue status")
    listing = commands.add_parser("list", help="list queued file metadata as JSON")
    listing.add_argument("--limit", type=int, default=500)
    upload = commands.add_parser("flush", help="upload queued metadata")
    upload.add_argument("--quiet", action="store_true")
    bind = commands.add_parser("bind", help="bind this checkout with a server-issued one-use code")
    bind.add_argument("--code", required=True)
    bind.add_argument("--root", default=os.getcwd())
    bind.add_argument("--label", default="")
    commands.add_parser("heartbeat", help="send an authenticated heartbeat")
    tmflush = commands.add_parser("tracemini-flush", help="upload queued TraceMini provenance")
    tmflush.add_argument("--quiet", action="store_true")
    service = commands.add_parser("service", help="run the managed heartbeat and flush loop")
    service.add_argument("--interval", type=float, default=60.0)
    discover = commands.add_parser("discover", help="discover local Git/non-Git metadata")
    discover.add_argument("--root", default=os.getcwd())
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.subcommand == "exec":
            return execute(args.agent, args.command)
        config_path, state = paths()
        queue = Queue(state / "queue.sqlite3")
        if args.subcommand == "status":
            config = load_config(required=False)
            print(json.dumps({"version": VERSION, "pending": queue.count(),
                              "configured": bool(config.get("endpoint") and config.get("device_token")),
                              "strace": bool(shutil.which("strace"))}))
            return 0
        if args.subcommand == "list":
            print(json.dumps(queue.pending(max(0, args.limit)), indent=2))
            return 0
        if args.subcommand == "discover":
            print(json.dumps(repository_metadata(_canonical_root(args.root)), indent=2))
            return 0
        config = load_config()
        if args.subcommand == "heartbeat":
            heartbeat(config)
            return 0
        if args.subcommand == "service":
            interval = max(5.0, min(float(args.interval), 3600.0))
            while True:
                try:
                    heartbeat(config)
                except RuntimeError:
                    pass
                try:
                    flush(queue, config, state)
                except RuntimeError:
                    pass
                try:
                    flush_tracemini(config, state)
                except RuntimeError:
                    pass
                try:
                    poll_reports(config)
                except RuntimeError:
                    pass
                time.sleep(interval)
        if args.subcommand == "tracemini-flush":
            uploaded = flush_tracemini(config, state)
            if not args.quiet:
                print(json.dumps({"uploaded": uploaded}))
            return 0
        if args.subcommand == "bind":
            root = _canonical_root(args.root)
            endpoint = config.get("bind_url") or config.get("tracemini_endpoint", "") + "/bind"
            result = _post_json(endpoint, config,
                                {"code": args.code, "root_hash": root_binding_hash(root, args.code),
                                 "repository_key": repository_metadata(root).get("repository_key")},
                                binding={"binding_id": "enrollment", "binding_secret": args.code})
            binding = {"root": root, "binding_id": result["binding_id"],
                       "binding_secret": result["binding_secret"], "root_hash": result["root_hash"],
                       "root_label": result.get("root_label", os.path.basename(root))}
            config["bindings"] = [item for item in config.get("bindings", []) if item.get("root") != root]
            binding["endpoint"] = config.get("tracemini_endpoint", "")
            config["bindings"].append(binding)
            config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
            config_path.chmod(0o600)
            print(json.dumps({"binding_id": result["binding_id"], "root_hash": result["root_hash"]}))
            return 0
        uploaded = flush(queue, config, state)
        if not args.quiet:
            print(json.dumps({"uploaded": uploaded, "pending": queue.count()}))
        return 0
    except (RuntimeError, ValueError) as error:
        print(f"files-agent: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
