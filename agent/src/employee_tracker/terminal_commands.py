from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import base64
import os
import re
from typing import Iterator

SENSITIVE_PATTERNS = [
    re.compile(r'(?i)(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth)[=\s]+)(\S+)'),
    re.compile(r'(?i)((?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth)\s*=\s*)(\S+)'),
]

SENSITIVE_COMMANDS = re.compile(r'(?i)\b(passwd|sudo\s+-S|sshpass|gpg\s+--decrypt|openssl\s+(?:enc|rsa|pkcs12))\b')


@dataclass(frozen=True)
class TerminalCommandEvent:
    captured_at: str
    shell: str
    cwd: str | None
    exit_code: int | None
    command: str
    source: str


def default_terminal_log_path() -> Path:
    base = Path(os.environ.get('EMPLOYEE_TRACKER_DIR', Path.home() / '.local/share/neodym-employee-tracker/data'))
    return Path(os.environ.get('EMPLOYEE_TRACKER_TERMINAL_LOG', base.parent / 'terminal-commands.tsv'))


def redact_command(command: str) -> str:
    stripped = command.strip()
    if not stripped:
        return stripped
    if SENSITIVE_COMMANDS.search(stripped):
        return '[redacted sensitive command]'
    redacted = stripped
    for pattern in SENSITIVE_PATTERNS:
        redacted = pattern.sub(lambda match: f'{match.group(1)}[redacted]', redacted)
    return redacted[:2000]


class TerminalCommandReader:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_terminal_log_path()
        self._offset = 0
        self._inode: int | None = None

    def read_commands(self, limit: int = 100) -> list[TerminalCommandEvent]:
        path = self.path.expanduser()
        try:
            stat = path.stat()
        except OSError:
            return []
        if self._inode is not None and stat.st_ino != self._inode:
            self._offset = 0
        self._inode = stat.st_ino
        if stat.st_size < self._offset:
            self._offset = 0

        events: list[TerminalCommandEvent] = []
        try:
            with path.open('rb') as handle:
                handle.seek(self._offset)
                for raw_line in handle:
                    parsed = _parse_line(raw_line)
                    if parsed is not None:
                        events.append(parsed)
                    if len(events) >= limit:
                        break
                self._offset = handle.tell()
        except OSError:
            return []
        return events


def _parse_line(raw_line: bytes) -> TerminalCommandEvent | None:
    try:
        line = raw_line.decode('utf-8', errors='replace').rstrip('\n')
    except Exception:
        return None
    parts = line.split('\t')
    if len(parts) < 5:
        return None
    captured_at, shell, cwd, exit_raw, encoded_command = parts[:5]
    try:
        command = base64.b64decode(encoded_command.encode('ascii'), validate=False).decode('utf-8', errors='replace')
    except Exception:
        return None
    command = redact_command(command)
    if not command:
        return None
    return TerminalCommandEvent(
        captured_at=_normalize_timestamp(captured_at),
        shell=shell[:80] or 'shell',
        cwd=cwd[:1000] or None,
        exit_code=_safe_int(exit_raw),
        command=command,
        source='shell-history-hook',
    )


def _normalize_timestamp(value: str) -> str:
    if value:
        return value[:80]
    return datetime.now(timezone.utc).isoformat()


def _safe_int(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
