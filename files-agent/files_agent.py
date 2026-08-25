#!/usr/bin/env python3
"""Privacy-safe, files-only tracing wrapper for approved AI command-line tools.

Only file paths and mutation metadata are persisted. File data and traced command
arguments are never added to the queue or upload payload.
"""
from __future__ import annotations

import argparse
import ast
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import fcntl
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

VERSION = "1.0.0"
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

    def _initialize(self) -> None:
        with self._connect() as connection:
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
        with self._connect() as connection:
            connection.executemany("""INSERT INTO events
                (event_id,run_id,agent,action,path,bytes,count,occurred_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                [(uuid.uuid4().hex, run_id, agent, e.action, e.path, e.bytes, e.count, e.occurred_at)
                 for e in events])

    def pending(self, limit: int = 250) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM events ORDER BY id LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    def ack(self, rows: Sequence[dict]) -> None:
        if not rows:
            return
        with self._connect() as connection:
            for item in rows:
                # Both keys bind the acknowledgment to the exact immutable row
                # snapshot selected for upload; never acknowledge by position alone.
                connection.execute(
                    "DELETE FROM events WHERE id=? AND event_id=?",
                    (item["id"], item["event_id"]),
                )

    def count(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT count(*) FROM events").fetchone()[0])


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
    initial_cwd = os.getcwd()
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
            spawn_flush(config_path, state)
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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.subcommand == "exec":
            return execute(args.agent, args.command)
        _config_path, state = paths()
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
        config = load_config()
        uploaded = flush(queue, config, state)
        if not args.quiet:
            print(json.dumps({"uploaded": uploaded, "pending": queue.count()}))
        return 0
    except (RuntimeError, ValueError) as error:
        print(f"files-agent: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
