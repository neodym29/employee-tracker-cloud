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
from datetime import datetime, timezone, timedelta
import json
import fcntl
import hmac
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import shlex
import sqlite3
import subprocess
import sys
import tempfile
from typing import Iterable, Sequence
from urllib import request
from urllib.error import URLError, HTTPError
import uuid
import time
from urllib.parse import urlsplit

VERSION = "2.0.0"
MAX_DISCOVERY_ROOTS = 32
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
        roots = value.get("discovery_roots", [])
        if not isinstance(roots, list) or len(roots) > MAX_DISCOVERY_ROOTS:
            raise RuntimeError(f"config discovery_roots must contain at most {MAX_DISCOVERY_ROOTS} roots")
        if any(not isinstance(root, str) or _canonical_root(root) != root for root in roots):
            raise RuntimeError("discovery_roots must contain canonical directories")
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


def _atomic_json_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            fd = -1
            stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def approve_discovery_root(root: str) -> dict:
    """Reload current disk state before merging, so reinstall/config races do not lose bindings."""
    config_path, _state = paths()
    config = load_config()
    canonical = _canonical_root(root)
    roots = config.get("discovery_roots", [])
    if not isinstance(roots, list):
        roots = []
    config["discovery_roots"] = sorted(set(str(item) for item in roots if isinstance(item, str)) | {canonical})
    if len(config["discovery_roots"]) > MAX_DISCOVERY_ROOTS:
        raise RuntimeError(f"at most {MAX_DISCOVERY_ROOTS} discovery roots may be approved")
    _atomic_json_write(config_path, config)
    return config


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


DISCOVERY_EXCLUSIONS = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "vendor", "target"})


def git_common_dir(root: str) -> str | None:
    """Resolve both normal repositories and linked worktrees (.git files)."""
    try:
        value = subprocess.check_output(["git", "-C", root, "rev-parse", "--git-common-dir"],
                                        text=True, stderr=subprocess.DEVNULL, timeout=3).strip()
        return os.path.realpath(os.path.join(root, value)) if not os.path.isabs(value) else os.path.realpath(value)
    except (OSError, subprocess.SubprocessError):
        return None


def discover_repositories(root: str, *, max_depth: int = 12, max_directories: int = 10_000,
                          max_repositories: int = 500, timeout_seconds: float = 5.0) -> list[str]:
    """Single-root compatibility entry point; all traversal uses shared budgets."""
    return discover_approved_roots([root], max_depth=max_depth,
                                   max_directories=max_directories,
                                   max_repositories=max_repositories,
                                   timeout_seconds=timeout_seconds)


class DiscoveryResult(list):
    """List-compatible paths plus explicit bounded-traversal outcome."""
    def __init__(self):
        super().__init__()
        self.partial = False
        self.directories = 0
        self.entries = 0


def discover_approved_roots(roots: Sequence[str], *, max_depth: int = 12,
                            max_directories: int = 10_000, max_repositories: int = 500,
                            timeout_seconds: float = 5.0, max_entries: int = 100_000) -> DiscoveryResult:
    """One traversal, global counters/deadline, no recount or eager scandir list.

    Filesystem calls cannot be preempted, but no new operation is started once
    the deadline is observed. Git validation is deferred to candidate processing.
    """
    deadline = time.monotonic() + max(0.0, min(timeout_seconds, 30.0))
    found = DiscoveryResult()
    seen = set()
    def exhausted():
        return (time.monotonic() >= deadline or found.directories >= max_directories
                or found.entries >= max_entries or len(found) >= max_repositories)
    for root in roots:
        if exhausted():
            found.partial = True
            break
        try:
            approved = _canonical_root(root)
            device = os.lstat(approved).st_dev
        except (OSError, RuntimeError):
            found.partial = True
            continue
        stack = [(approved, 0)]
        while stack:
            if exhausted():
                found.partial = True
                break
            current, depth = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            found.directories += 1
            try:
                if os.path.islink(current) or os.lstat(current).st_dev != device:
                    continue
                # Probe the marker directly: a wide checkout need not enumerate
                # every file merely to discover its .git directory/worktree file.
                marker = os.path.join(current, '.git')
                if not os.path.islink(marker) and (os.path.isdir(marker) or os.path.isfile(marker)):
                    found.append(current)
                    continue
                if depth >= max_depth:
                    found.partial = True
                    continue
                with os.scandir(current) as entries:
                    while True:
                        if time.monotonic() >= deadline or found.entries >= max_entries:
                            found.partial = True
                            break
                        entry = next(entries, None)
                        if entry is None:
                            break
                        found.entries += 1
                        if entry.name in DISCOVERY_EXCLUSIONS or entry.name.startswith('.'):
                            continue
                        if entry.is_dir(follow_symlinks=False) and not entry.is_symlink():
                            stack.append((entry.path, depth + 1))
            except OSError:
                found.partial = True
    return found


def repository_fingerprint(repo: str) -> dict:
    """Return local identity facts; no path is suitable for server display."""
    path = _canonical_root(repo)
    value = os.stat(path, follow_symlinks=False)
    common = git_common_dir(path)
    if not common:
        raise RuntimeError("not a Git repository")
    gitdir = os.stat(common, follow_symlinks=False)
    birthtime = getattr(value, "st_birthtime_ns", 0)
    result = {"device_id": value.st_dev, "inode": value.st_ino,
              "git_device": gitdir.st_dev, "git_inode": gitdir.st_ino}
    # The server canonicalizes aliases and accepts only JS-safe numeric facts.
    # Modern birthtime nanoseconds exceed that range; omit rather than round.
    if 0 <= birthtime <= 2**53 - 1:
        result["birthtime_ns"] = birthtime
    if any(not 0 <= fact <= 2**53 - 1 for fact in result.values()):
        raise RuntimeError("repository fingerprint exceeds server integer range")
    return result


def _history_heads(repo: str) -> list[str]:
    try:
        refs = subprocess.check_output(
            ["git", "-C", repo, "for-each-ref", "--format=%(objectname)",
             "refs/heads", "refs/remotes", "refs/tags"], text=True,
            stderr=subprocess.DEVNULL, timeout=3).split()
        refs.append(subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"],
                                            text=True, stderr=subprocess.DEVNULL, timeout=3).strip())
        return sorted(set(refs))
    except (OSError, subprocess.SubprocessError):
        return []


def _index_mtime(repo: str) -> int | None:
    try:
        index = subprocess.check_output(["git", "-C", repo, "rev-parse", "--git-path", "index"],
                                        text=True, stderr=subprocess.DEVNULL, timeout=3).strip()
        path = Path(index) if os.path.isabs(index) else Path(repo) / index
        return path.stat().st_mtime_ns
    except (OSError, subprocess.SubprocessError):
        return None


def history_heads(repo: str) -> list[str]:
    return _history_heads(_canonical_root(repo))


def _commit_data(repo: str, sha: str) -> dict:
    raw = subprocess.check_output(["git", "-C", repo, "show", "-s", "--format=%H%n%s%n%aI%n%an%n%ae", sha],
                                  text=True, stderr=subprocess.DEVNULL, timeout=3).splitlines()
    stats = subprocess.check_output(["git", "-C", repo, "show", "--format=", "--numstat", sha],
                                    text=True, stderr=subprocess.DEVNULL, timeout=3).splitlines()
    return {"commit_sha": raw[0], "message": raw[1], "commit_timestamp": raw[2],
            "author_name": raw[3], "author_email": raw[4],
            "files_changed": len([line for line in stats if line]),
            "branch": subprocess.check_output(["git", "-C", repo, "branch", "--show-current"],
                                                text=True, stderr=subprocess.DEVNULL, timeout=3).strip() or "(detached)"}


def commit_history(repo: str, since: str, until: str | None = None) -> list[dict]:
    args = ["git", "-C", _canonical_root(repo), "log", "--all", "--reverse", "--format=%H", f"--since={since}"]
    if until:
        args.append(f"--until={until}")
    try:
        commits = subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=8).split()
        return [_commit_data(_canonical_root(repo), sha) for sha in commits]
    except (OSError, subprocess.SubprocessError):
        return []


def commit_history_after_heads(repo: str, previous_heads: Sequence[str]) -> list[dict]:
    if not previous_heads:
        return []
    try:
        valid = [sha for sha in previous_heads if subprocess.run(
            ["git", "-C", repo, "cat-file", "-e", f"{sha}^{{commit}}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=3).returncode == 0]
        if not valid:
            return []
        commits = subprocess.check_output(["git", "-C", _canonical_root(repo), "rev-list", "--all", "--reverse", "--not", *valid],
                                          text=True, stderr=subprocess.DEVNULL, timeout=8).split()
        return [_commit_data(_canonical_root(repo), sha) for sha in commits]
    except (OSError, subprocess.SubprocessError):
        return []


def _approved_hooks_dir(repo: str, approved_roots: Sequence[str] | None = None) -> Path:
    repo = _canonical_root(repo)
    configured = subprocess.run(['git', '-C', repo, 'config', '--get', 'core.hooksPath'],
                                capture_output=True, text=True, timeout=3)
    if configured.returncode != 1:
        raise RuntimeError("custom core.hooksPath is not supported; hooks were not changed")
    common = git_common_dir(_canonical_root(repo))
    if not common:
        raise RuntimeError("not a Git repository")
    hooks = Path(common) / "hooks"
    roots = [_canonical_root(root) for root in (approved_roots or [repo])]
    if not any(os.path.commonpath([str(hooks.resolve()), root]) == root for root in roots):
        raise RuntimeError("Git common hooks directory is outside approved roots")
    if any(part.is_symlink() for part in [hooks, *hooks.parents]):
        raise RuntimeError("refusing to use a symlinked Git hooks directory")
    for name in ('post-commit', 'post-checkout', 'post-merge', 'post-rewrite', 'pre-push'):
        for suffix in ('', '.tracemini-owner', '.tracemini-original'):
            if (hooks / (name + suffix)).is_symlink():
                raise RuntimeError("refusing to replace a symlinked Git hook")
    return hooks


def install_managed_git_hooks(repo: str, endpoint: str, device: str, *, executable: str | None = None,
                              approved_roots: Sequence[str] | None = None) -> None:
    """Install digest-owned wrappers only within explicitly approved roots."""
    hooks = _approved_hooks_dir(repo, approved_roots)
    hooks.mkdir(parents=True, exist_ok=True)
    marker = "# TraceMini managed hook v2"
    executable = os.path.realpath(executable or str(Path(__file__).resolve()))
    for name in ("post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-push"):
        hook = hooks / name
        if hook.is_symlink() or hook.with_name(hook.name + ".tracemini-owner").is_symlink():
            raise RuntimeError("refusing to replace a symlinked Git hook")
        owner = hook.with_name(hook.name + ".tracemini-owner")
        original_path = hook.with_name(hook.name + ".tracemini-original")
        existing = hook.read_text(encoding="utf-8", errors="replace") if hook.is_file() else ""
        if marker in existing:
            if owner.is_file() and owner.read_text().strip() == hashlib.sha256(existing.encode()).hexdigest():
                continue
            raise RuntimeError("managed Git hook ownership changed; refusing to overwrite")
        if original_path.exists():
            raise RuntimeError("Git hook backup already exists; refusing to overwrite")
        if existing and not original_path.exists():
            os.replace(hook, original_path)
        event_type = {"post-commit": "commit", "post-checkout": "branch", "post-merge": "merge",
                      "post-rewrite": "rewrite", "pre-push": "push"}[name]
        command = f"{shlex.quote(executable)} hook-event --hook {shlex.quote(name)} --type {event_type} --root \"$(git rev-parse --show-toplevel)\""
        managed = "#!/bin/sh\n# TraceMini managed hook v2\n"
        # Keep a non-executable audit copy in the wrapper as well as the
        # sidecar. The executable source remains exclusively in .tracemini-original.
        managed += "# preserved original hook body:\n" + "".join(
            f"# {line}\n" for line in (existing or "#!/bin/sh\n").splitlines())
        managed += "input=$(mktemp \"${TMPDIR:-/tmp}/tracemini-hook.XXXXXX\") || exit 0\n"
        managed += "trap 'rm -f \"$input\"' EXIT HUP INT TERM\n"
        managed += "cat >\"$input\"\n"
        managed += "status=0\n"
        managed += f"if [ -x \"$0.tracemini-original\" ]; then \"$0.tracemini-original\" \"$@\" <\"$input\" || status=$?; fi\n"
        managed += f"{command} \"$@\" <\"$input\" >/dev/null 2>&1 || :\n"
        managed += "exit $status\n"
        for destination, content, mode in ((hook, managed, 0o700), (owner, hashlib.sha256(managed.encode()).hexdigest() + "\n", 0o600)):
            fd, temporary = tempfile.mkstemp(prefix=f'.{name}.', dir=hooks)
            try:
                os.fchmod(fd, mode)
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    stream.write(content)
                os.replace(temporary, destination)
            finally:
                Path(temporary).unlink(missing_ok=True)


def uninstall_managed_git_hooks(repo: str, *, approved_roots: Sequence[str] | None = None) -> None:
    hooks = _approved_hooks_dir(repo, approved_roots)
    marker = "# TraceMini managed hook v2"
    for name in ("post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-push"):
        hook = hooks / name
        if not hook.is_file():
            continue
        owner = hook.with_name(hook.name + ".tracemini-owner")
        original = hook.with_name(hook.name + ".tracemini-original")
        content = hook.read_text(encoding="utf-8", errors="replace")
        if not owner.exists() or hashlib.sha256(content.encode()).hexdigest() != owner.read_text().strip():
            continue
        hook.unlink()
        if original.exists():
            os.replace(original, hook)
        owner.unlink()


def work_completion_payload(kind: str, work_id: str, claim_token: str, revision: int | None,
                            desired_tracking: bool | None, *, count: int | None = None,
                            error: str | None = None, **extra: object) -> dict:
    """Build the exact server completion contract; never omit lease identity."""
    payload: dict = {"kind": kind, "work_id": str(work_id), "claim_token": claim_token}
    if kind == "selection":
        payload.update(revision=revision, tracked=desired_tracking)
    if kind == "scan" or error is not None:
        payload["error"] = error
    if count is not None:
        payload["count"] = count
    payload.update(extra)
    return payload


def git_hook_record(kind: str, metadata: dict) -> dict:
    if kind not in {'commit', 'branch', 'merge', 'rewrite', 'stage'}:
        raise RuntimeError('unsupported ordinary Git event')
    return {'event_key': secrets.token_hex(24), 'kind': kind, 'action': f'git_{kind}',
            'repository_key': metadata['repository_key'], 'occurred_at': utc_now(),
            'provenance': {key: value for key, value in metadata['provenance'].items()
                           if key in {'branch', 'head_sha', 'old_head_sha', 'new_head_sha', 'files_changed'}
                           and value is not None}}


def repository_metadata(root: str, local_only: bool = False) -> dict:
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
                  "upstream_head_sha": upstream_head or None}
    remote_head = ""
    if remote and branch != "HEAD" and not local_only:
        try:
            remote_head = verify_remote(repo, remote, f"refs/heads/{branch}")
        except RuntimeError:
            pass
    provenance["remote_branch_sha"] = remote_head or None
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


def sanitized_push_remote(remote: str) -> str:
    """Keep destination case/port/path, strip URL credentials/query/fragment."""
    parsed = urlsplit(remote)
    if parsed.scheme in ('https', 'http'):
        host = parsed.hostname or ''
        if ':' in host:
            host = '[' + host + ']'
        authority = host + (':' + str(parsed.port) if parsed.port else '')
        safe = parsed.scheme + '://' + authority + parsed.path
    else:
        safe = remote
    canonical_repository_key(safe, '/', '0' * 40)
    if any(ord(c) < 32 or ord(c) == 127 for c in safe):
        raise RuntimeError('invalid remote')
    return safe


def queue_push(queue: Queue, binding_id: str, payload: dict) -> None:
    payload = dict(payload)
    ref = payload.get('branch', '')
    if (not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', payload.get('expected_head_sha', ''))
            or not ref.startswith(('refs/heads/', 'refs/tags/'))
            or subprocess.run(['git', 'check-ref-format', ref], capture_output=True, timeout=3).returncode):
        raise RuntimeError('invalid push ref or SHA')
    payload['remote_url'] = sanitized_push_remote(payload['remote_url'])
    # Never persist hook argument remote names (which can themselves be URLs).
    payload.pop('remote_name', None)
    with queue._connection() as db:
        db.execute('CREATE TABLE IF NOT EXISTS push_outbox(event_key TEXT PRIMARY KEY, binding_id TEXT NOT NULL, payload TEXT NOT NULL, push_id TEXT)')
        db.execute('INSERT INTO push_outbox VALUES(?,?,?,NULL)',
                   (secrets.token_hex(24), binding_id, json.dumps(payload)))


def flush_pushes(config: dict, state: Path) -> int:
    queue = Queue(state / 'queue.sqlite3')
    endpoint = config.get('pushes_url') or config.get('endpoint', '').replace('/api/files-agent/ingest', '/api/files-agent/pushes')
    with queue._connection() as db:
        db.execute('CREATE TABLE IF NOT EXISTS push_outbox(event_key TEXT PRIMARY KEY, binding_id TEXT NOT NULL, payload TEXT NOT NULL, push_id TEXT)')
        rows = db.execute('SELECT * FROM push_outbox WHERE push_id IS NULL LIMIT 32').fetchall()
    count = 0
    for row in rows:
        if not any(b.get('binding_id') == row['binding_id'] and not b.get('disabled') for b in config.get('bindings', [])):
            continue
        response = _post_json(endpoint, config, json.loads(row['payload']))
        push_id = str(response.get('pushId', ''))
        if not push_id.isdigit():
            raise RuntimeError('invalid push receipt')
        with queue._connection() as db:
            db.execute('UPDATE push_outbox SET push_id=? WHERE event_key=? AND push_id IS NULL', (push_id, row['event_key']))
        count += 1
    return count


def push_destination(state: Path, item: dict) -> str | None:
    queue = Queue(state / 'queue.sqlite3')
    with queue._connection() as db:
        db.execute('CREATE TABLE IF NOT EXISTS push_outbox(event_key TEXT PRIMARY KEY, binding_id TEXT NOT NULL, payload TEXT NOT NULL, push_id TEXT)')
        row = db.execute('SELECT payload FROM push_outbox WHERE push_id=?', (str(item['work_id']),)).fetchone()
    if not row:
        return None  # Legacy/unknown destinations must never fall back to origin.
    payload = json.loads(row['payload'])
    if any(payload.get(k) != item.get(k) for k in ('repository_key', 'fingerprint', 'branch', 'expected_head_sha')):
        return None
    return payload['remote_url']


def reconcile_tracked_clones(config: dict, state: Path) -> int:
    """Recover local metadata only. Queue writes, dedupe and checkpoints commit together.

    At most four clones and 32 commit records per tick; Git calls are timeout
    bounded. A changed identity never advances a checkpoint or emits evidence.
    """
    queue = Queue(state / 'queue.sqlite3')
    emitted = 0
    deadline = time.monotonic() + 5
    with queue._connection() as db:
        db.execute('CREATE TABLE IF NOT EXISTS reconcile_state(binding_id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS reconcile_seen(binding_id TEXT, event_key TEXT, PRIMARY KEY(binding_id,event_key))')
        db.execute('CREATE TABLE IF NOT EXISTS reconcile_cursor(id INTEGER PRIMARY KEY, offset INTEGER NOT NULL)')
        cursor = db.execute('SELECT offset FROM reconcile_cursor WHERE id=1').fetchone()
        clones = config.get('clones', [])
        start = (cursor[0] if cursor else 0) % max(1, len(clones))
        visited = 0
        for i in range(min(4, len(clones))):
            if time.monotonic() >= deadline:
                break
            visited += 1
            clone = clones[(start + i) % len(clones)]
            try:
                root = _canonical_root(clone['path'])
                def identity():
                    if not any(os.path.commonpath([root, _canonical_root(r)]) == _canonical_root(r)
                               for r in config.get('discovery_roots', [])):
                        raise RuntimeError('clone outside approved roots')
                    if git_root(root) != root or repository_fingerprint(root) != clone.get('fingerprint'):
                        raise RuntimeError('clone identity changed')
                    binding = select_binding(config, root)
                    if not binding or binding['binding_id'] != clone.get('binding_id'):
                        raise RuntimeError('clone binding changed')
                    metadata = repository_metadata(root, local_only=True)
                    if metadata.get('repository_key') != clone.get('repository_key'):
                        raise RuntimeError('clone repository changed')
                    return metadata
                metadata = identity()
                binding_id = clone['binding_id']
                row = db.execute('SELECT payload FROM reconcile_state WHERE binding_id=?', (binding_id,)).fetchone()
                checkpoint = json.loads(row[0]) if row else dict(clone)
                heads = _history_heads(root)
                records = []
                complete = True
                if heads != checkpoint.get('history_heads'):
                    previous = checkpoint.get('history_heads', [])
                    # Restrict history to the supported retention window. Never advance
                    # heads on a truncated processing batch; durable seen keys resume it.
                    args = ['git', '-C', root, 'rev-list', '--all', '--reverse', '--since=90 days ago']
                    if previous:
                        args += ['--not', *previous]
                    commits = subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=3).split()
                    for sha in commits:
                        key = hashlib.sha256((metadata['repository_key'] + json.dumps(clone['fingerprint'], sort_keys=True, separators=(',', ':')) + sha).encode()).hexdigest()
                        if db.execute('SELECT 1 FROM reconcile_seen WHERE binding_id=? AND event_key=?', (binding_id, key)).fetchone():
                            continue
                        if len(records) >= 32 or time.monotonic() >= deadline:
                            complete = False
                            break
                        data = _commit_data(root, sha)
                        records.append({'event_key': key, 'kind': 'commit', 'action': 'commit_history',
                                        'repository_key': metadata['repository_key'], 'occurred_at': data['commit_timestamp'],
                                        'provenance': {'head_sha': sha, 'branch': data['branch'], 'files_changed': data['files_changed']}})
                index = metadata['provenance']['index_digest']
                pending = checkpoint.get('pending_index')
                if index != checkpoint.get('index_digest'):
                    if pending and pending.get('digest') == index and time.time() - pending['at'] >= 2:
                        event = git_hook_record('stage', metadata)
                        event['event_key'] = hashlib.sha256((binding_id + ':' + str(pending['at']) + ':' + index).encode()).hexdigest()
                        records.append(event)
                        checkpoint['index_digest'] = index
                        checkpoint.pop('pending_index', None)
                    elif checkpoint.get('index_digest') is None and _index_mtime(root) == clone.get('index_mtime'):
                        checkpoint['index_digest'] = index
                    else:
                        checkpoint['pending_index'] = {'digest': index, 'at': time.time()}
                else:
                    checkpoint.pop('pending_index', None)
                after = identity()
                if _history_heads(root) != heads or after['provenance']['index_digest'] != index:
                    continue
                for record in records:
                    result = db.execute('INSERT OR IGNORE INTO reconcile_seen VALUES(?,?)', (binding_id, record['event_key']))
                    if result.rowcount:
                        db.execute('INSERT OR IGNORE INTO trace_events(binding_id,event_key,payload,created_at) VALUES(?,?,?,?)',
                                   (binding_id, record['event_key'], json.dumps(record), utc_now()))
                        emitted += 1
                if complete:
                    checkpoint['history_heads'] = heads
                db.execute('INSERT OR REPLACE INTO reconcile_state VALUES(?,?)', (binding_id, json.dumps(checkpoint)))
            except (OSError, RuntimeError, subprocess.SubprocessError, KeyError, ValueError):
                continue
        db.execute('INSERT OR REPLACE INTO reconcile_cursor VALUES(1,?)', (start + visited,))
    return emitted


def poll_reports(config: dict) -> None:
    endpoint = config.get("report_poll_url")
    if endpoint:
        _post_json(endpoint, config, {"at": utc_now()})


def poll_discovery_work(config: dict, state: Path) -> None:
    """Claim queued scans and publish only safe repository facts."""
    endpoint = config.get("work_url") or config.get("endpoint", "").replace("/api/files-agent/ingest", "/api/files-agent/work")
    if not endpoint or not config.get("discovery_roots"):
        return
    work = _post_json(endpoint, config, {"at": utc_now()})
    base_url = endpoint.rstrip("/").rsplit("/", 1)[0]
    for item in work.get("work", []):
        if item.get("kind") == "selection":
            tracked = False
            error = "selected repository is unavailable in approved roots"
            if config.get("discovery_roots") and item.get("repository_key"):
                for repo in discover_approved_roots(config["discovery_roots"]):
                    try:
                        metadata = repository_metadata(repo)
                        if metadata.get("repository_key") != item.get("repository_key"):
                            continue
                        fingerprint = repository_fingerprint(repo)
                        if fingerprint != item.get("fingerprint"):
                            error = "repository fingerprint changed"
                            continue
                        error = None
                        if item.get("desired_tracking") is True:
                            binding = item.get("binding")
                            if not isinstance(binding, dict) or not all(isinstance(binding.get(k), str) and binding[k] for k in ('binding_id', 'binding_secret', 'root_hash')):
                                raise RuntimeError("device project binding is missing")
                            _approved_hooks_dir(repo, config['discovery_roots'])
                            binding_for_repo = {k: binding[k] for k in ('binding_id', 'binding_secret', 'root_hash')}
                            binding_for_repo.update(root=_canonical_root(repo), repository_key=metadata['repository_key'])
                            config['bindings'] = [b for b in config.get('bindings', []) if b.get('root') != binding_for_repo['root']] + [binding_for_repo]
                            _atomic_json_write(paths()[0], config)
                            install_managed_git_hooks(repo, config.get("tracemini_endpoint", ""), device_id(state), approved_roots=config['discovery_roots'])
                            if repository_fingerprint(repo) != fingerprint or repository_metadata(repo).get("repository_key") != item.get("repository_key"):
                                uninstall_managed_git_hooks(repo, approved_roots=config['discovery_roots'])
                                raise RuntimeError("repository identity changed during activation")

                            history = commit_history(repo, (datetime.now(timezone.utc) - timedelta(days=90)).isoformat(), utc_now())
                            if binding_for_repo and history:

                                Queue(state / "queue.sqlite3").enqueue_trace(binding_for_repo["binding_id"], [
                                    {"event_key": hashlib.sha256((metadata["repository_key"] + json.dumps(fingerprint, sort_keys=True, separators=(",", ":")) + row["commit_sha"]).encode()).hexdigest(),
                                     "kind": "commit", "action": "commit_history", "agent": None, "run_id": None,
                                     "repository_key": metadata["repository_key"], "occurred_at": row["commit_timestamp"],
                                     "provenance": {"head_sha": row['commit_sha'], "files_changed": row['files_changed'], "branch": row['branch']}}
                                    for row in history])
                            config.setdefault("clones", [])
                            config["clones"] = [clone for clone in config["clones"]
                                                if clone.get("path") != os.path.realpath(repo)]
                            config["clones"].append({"path": os.path.realpath(repo),
                                "repository_key": metadata["repository_key"],
                                "repository_fingerprint": fingerprint,
                                "fingerprint": fingerprint,
                                "branch": metadata["provenance"].get("branch"),
                                "head_sha": metadata["provenance"].get("head_sha"),
                                "history_heads": _history_heads(repo),
                                "index_mtime": _index_mtime(repo),
                                "binding_id": select_binding(config, repo).get("binding_id") if select_binding(config, repo) else None})
                            _atomic_json_write(paths()[0], config)
                            tracked = True
                        else:
                            uninstall_managed_git_hooks(repo, approved_roots=config['discovery_roots'])
                            for binding in config.get('bindings', []):
                                if binding.get('root') == _canonical_root(repo):
                                    binding['disabled'] = True
                                    Queue(state / 'queue.sqlite3').purge_trace(binding['binding_id'])
                            config["clones"] = [clone for clone in config.get("clones", [])
                                                if clone.get("path") != os.path.realpath(repo)]
                            _atomic_json_write(paths()[0], config)
                        break
                    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                        tracked = False
                        error = "repository activation failed; check local identity, binding, and hook permissions"
                        print(f"TraceMini: {error}", file=sys.stderr)
                        for binding in config.get('bindings', []):
                            if binding.get('root') == _canonical_root(repo):
                                binding['disabled'] = True
                        _atomic_json_write(paths()[0], config)
                        break
            else:
                error = "selected repository is outside approved roots"
            complete_url = config.get("selection_complete_url") or base_url + f"/repository-selections/{item['work_id']}/complete"
            _post_json(complete_url, config, work_completion_payload(
                "selection", item["work_id"], item["claim_token"],
                item["revision"], item["desired_tracking"],
                tracked=tracked, error=error))
            continue
        if item.get("kind") == "push":
            occurred = item.get("occurred_at")
            if occurred:
                try:
                    if time.time() - datetime.fromisoformat(str(occurred).replace("Z", "+00:00")).timestamp() < 8:
                        continue
                except ValueError:
                    pass
            status = "pending"

            if config.get("discovery_roots"):
                for repo in discover_approved_roots(config["discovery_roots"]):
                    try:
                        metadata = repository_metadata(repo)
                        if (metadata.get("repository_key") == item.get("repository_key")
                                and repository_fingerprint(repo) == item.get("fingerprint")
                                and push_destination(state, item)
                                and _verified_push(repo, metadata, item.get("branch"), item.get("expected_head_sha"), push_destination(state, item))
                                and repository_fingerprint(repo) == item.get('fingerprint')
                                and repository_metadata(repo, local_only=True).get('repository_key') == item.get('repository_key')):
                            status = "verified"

                            break
                    except (OSError, RuntimeError, subprocess.SubprocessError):
                        pass
            complete_url = config.get("push_complete_url") or base_url + f"/pushes/{item['work_id']}/complete"
            _post_json(complete_url, config, work_completion_payload(
                "push", item["work_id"], item["claim_token"], None, None,
                status=status, expected_head_sha=item.get("expected_head_sha"),
                branch=item.get("branch")))
            continue
        if item.get("kind") != "scan":
            continue
        repositories = []
        scan_deadline = time.monotonic() + 5.0
        discovered = discover_approved_roots(config.get("discovery_roots", []))
        scan_error = "Repository scan partial: discovery budget reached" if getattr(discovered, 'partial', False) else None
        for repo in discovered:
            if time.monotonic() >= scan_deadline:
                scan_error = "Repository scan partial: candidate processing timed out"
                break
            metadata = repository_metadata(repo)
            if metadata.get("kind") != "git":
                continue
            repositories.append({"display_name": os.path.basename(repo), "repository_key": metadata["repository_key"],
                                **metadata["provenance"], "fingerprint": repository_fingerprint(repo)})
        _post_json(config.get("candidates_url") or base_url + "/repository-candidates", config,
                   {"scan_id": item["work_id"], "claim_token": item['claim_token'], "repositories": repositories[:500]})
        _post_json(config.get("work_complete_url") or base_url + f"/scans/{item['work_id']}/complete", config,
                   work_completion_payload("scan", item["work_id"], item["claim_token"], None, None,
                                           count=len(repositories[:500]), error=scan_error))


def _verified_push(root: str, metadata: dict, expected_branch: str | None = None,
                   expected_sha: str | None = None, destination: str | None = None) -> bool:
    if metadata.get("kind") != "git" or not metadata.get("repository_key"):
        return False
    remote = destination or _origin_remote(root)
    if not remote or remote.startswith("local:"):
        return False
    try:
        branch = expected_branch or metadata["provenance"].get("branch") or "HEAD"
        ref = branch if branch.startswith('refs/') else f'refs/heads/{branch}'
        canonical_repository_key(remote, root, '0' * 40)
        expected = expected_sha or metadata["provenance"].get("head_sha")
        output = subprocess.check_output(["git", "-C", root, "ls-remote", "--refs", remote, ref], text=True,
                                         stderr=subprocess.DEVNULL, timeout=8)
        return any(line.split()[0] == expected
                   and len(line.split()) > 1 and line.split()[1] == ref
                   for line in output.splitlines() if line.split())
    except (OSError, subprocess.SubprocessError, RuntimeError):
        return False


def enqueue_tracemini(queue: Queue, config: dict, root: str, agent: str,
                      file_events: Sequence[Event], before: dict | None = None,
                      run_id: str | None = None, execution_id: str | None = None) -> None:
    root = _canonical_root(root)
    binding = select_binding(config, root)
    if not binding:
        return
    metadata = repository_metadata(root)
    if not run_id:
        raise RuntimeError('Trace requires the actual approved execution run ID')
    now = utc_now()
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
    if execution_id:
        for record in records:
            record['provenance']['execution_id'] = execution_id
    queue.enqueue_trace(binding["binding_id"], records)


def heartbeat(config: dict) -> None:
    queue = Queue(paths()[1] / "queue.sqlite3")
    for binding in config.get("bindings", []):
        if binding.get("disabled"):
            continue
        endpoint = config.get("heartbeat_url") or (config.get("tracemini_endpoint") or config.get("endpoint", "").replace("/api/files-agent/ingest", "/api/files-agent/tracemini")) + "/heartbeat"
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
    execution_id = secrets.token_hex(16)
    run_id = (hmac.new(binding['binding_secret'].encode(),
                      ('approved-execution:' + execution_id).encode(), 'sha256').hexdigest()
              if binding else execution_id)
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
            queue.enqueue(agent, run_id, events)
            if binding:
                enqueue_tracemini(queue, config, initial_cwd, agent, events, before_metadata,
                                  run_id=run_id, execution_id=execution_id)
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
    scan = commands.add_parser("scan", help="scan an explicitly approved discovery root")
    scan.add_argument("--root", required=True)
    approve = commands.add_parser("approve-root", help="persist an explicit discovery root")
    approve.add_argument("root")
    hook_event = commands.add_parser("hook-event", help=argparse.SUPPRESS)
    hook_event.add_argument("--hook", required=True)
    hook_event.add_argument("--type", choices=sorted(GIT_EVENT_TYPES), required=False)
    hook_event.add_argument("--root", required=True)
    hook_event.add_argument("command", nargs=argparse.REMAINDER)
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
        if args.subcommand == "scan":
            print(json.dumps([{"repository": item, "fingerprint": repository_fingerprint(item), **repository_metadata(item)}
                              for item in discover_repositories(args.root)], indent=2))
            return 0
        if args.subcommand == "approve-root":
            root = _canonical_root(args.root)
            approve_discovery_root(root)
            print(json.dumps({"approved_root": os.path.basename(root)}))
            return 0
        if args.subcommand == "hook-event":
            # Hooks are durable and advisory: telemetry failure can never affect Git.
            try:
                config = load_config()
                root = _canonical_root(args.root)
                metadata = repository_metadata(root, local_only=True)
                if metadata.get("kind") == "git":
                    provenance = metadata["provenance"]
                    hook_type = args.type or {"post-commit": "commit", "post-checkout": "branch",
                                               "post-merge": "merge", "post-rewrite": "rewrite",
                                               "pre-push": "push"}.get(args.hook, "commit")
                    if hook_type == "push" and args.hook == "pre-push":
                        remote_name, remote_url = (args.command[-2:] if len(args.command) >= 2 else ("", ""))
                        for line in sys.stdin.read().splitlines():
                            parts = line.split()
                            if len(parts) < 3 or not parts[1].strip("0"):
                                continue
                            binding = select_binding(config, root)
                            if not binding or not parts[2].startswith('refs/'):
                                continue
                            queue_push(queue, binding['binding_id'], {"repository_key": metadata["repository_key"],
                                "branch": parts[2], "expected_head_sha": parts[1],
                                "fingerprint": repository_fingerprint(root),
                                "remote_name": remote_name, "remote_url": remote_url})
                    else:
                        queue = Queue(paths()[1] / "queue.sqlite3")
                        binding = select_binding(config, root)
                        if binding:
                            record = git_hook_record(hook_type, metadata)
                            queue.enqueue_trace(binding["binding_id"], [record])
            except (OSError, RuntimeError, subprocess.SubprocessError, KeyError, TypeError):
                pass
            return 0
        config = load_config()
        if args.subcommand == "heartbeat":
            heartbeat(config)
            return 0
        if args.subcommand == "service":
            interval = max(5.0, min(float(args.interval), 3600.0))
            while True:
                # Config is mutable by approve-root and reinstall; never retain a stale snapshot.
                config = load_config()
                try:
                    reconcile_tracked_clones(config, state)
                    flush_pushes(config, state)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    pass
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
                    poll_discovery_work(config, state)
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
