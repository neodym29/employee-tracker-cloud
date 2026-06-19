from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import os
import platform
import re
import shutil
import subprocess
from typing import Callable

SECRET_VALUE_PATTERN = re.compile(
    r'(?i)(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|auth|bearer|cookie|session)'
    r'\s*[:=]\s*([^\s#;&]+)'
)
PRIVATE_KEY_PATTERN = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----', re.DOTALL)
LONG_TOKEN_PATTERN = re.compile(r'(?<![A-Za-z0-9_\-])([A-Za-z0-9_\-]{32,})(?![A-Za-z0-9_\-])')


@dataclass(frozen=True)
class ClipboardCapture:
    status: str
    content: str | None = None
    content_hash: str | None = None
    content_length: int = 0
    content_redacted: bool = False
    content_truncated: bool = False
    source: str | None = None
    reason: str | None = None


def redact_clipboard_text(text: str) -> tuple[str, bool]:
    redacted = False

    def replace_secret(match: re.Match[str]) -> str:
        nonlocal redacted
        redacted = True
        prefix = match.group(0)[: match.group(0).rfind(match.group(2))]
        return f'{prefix}[REDACTED]'

    text = PRIVATE_KEY_PATTERN.sub('[REDACTED_PRIVATE_KEY]', text)
    if '[REDACTED_PRIVATE_KEY]' in text:
        redacted = True

    text = SECRET_VALUE_PATTERN.sub(replace_secret, text)

    def replace_token(match: re.Match[str]) -> str:
        nonlocal redacted
        value = match.group(1)
        # Avoid redacting normal long prose/paths with spaces; this only matches compact token-like runs.
        if any(char.isdigit() for char in value) and any(char.isalpha() for char in value):
            redacted = True
            return '[REDACTED_TOKEN]'
        return value

    text = LONG_TOKEN_PATTERN.sub(replace_token, text)
    return text, redacted


def _run_clipboard_command(command: list[str], timeout: float = 0.5) -> str | None:
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return None
    if completed.returncode != 0:
        return None
    data = completed.stdout
    if not data:
        return ''
    if b'\x00' in data[:8192]:
        return None
    return data.decode('utf-8', errors='replace')


def read_clipboard_text(command_runner: Callable[[list[str]], str | None] | None = None) -> tuple[str | None, str | None, str | None]:
    """Return clipboard text, source, reason. Does not raise when no clipboard is available."""
    runner = command_runner or _run_clipboard_command
    system = platform.system().lower()
    candidates: list[tuple[str, list[str]]] = []
    if system == 'darwin':
        candidates.append(('pbpaste', ['pbpaste']))
    elif system == 'windows':
        candidates.append(('powershell-get-clipboard', ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw']))
    else:
        if os.environ.get('WAYLAND_DISPLAY'):
            candidates.append(('wl-paste', ['wl-paste', '--no-newline']))
        candidates.extend([
            ('xclip', ['xclip', '-selection', 'clipboard', '-out']),
            ('xsel', ['xsel', '--clipboard', '--output']),
            ('wl-paste', ['wl-paste', '--no-newline']),
        ])
    for source, command in candidates:
        if command_runner is None and shutil.which(command[0]) is None:
            continue
        value = runner(command)
        if value is None:
            continue
        return value, source, None
    return None, None, 'no_clipboard_reader_available'


class ClipboardWatcher:
    def __init__(self, *, max_text_chars: int = 4096, command_runner: Callable[[list[str]], str | None] | None = None) -> None:
        self.max_text_chars = max(128, max_text_chars)
        self.command_runner = command_runner
        self._last_hash: str | None = None

    def poll(self) -> ClipboardCapture:
        text, source, reason = read_clipboard_text(self.command_runner)
        if text is None:
            return ClipboardCapture(status='unavailable', source=source, reason=reason)
        if text == '':
            current_hash = sha256(b'').hexdigest()
            if current_hash == self._last_hash:
                return ClipboardCapture(status='unchanged', source=source, content_hash=current_hash)
            self._last_hash = current_hash
            return ClipboardCapture(status='empty', source=source, content_hash=current_hash)
        raw_hash = sha256(text.encode('utf-8', errors='replace')).hexdigest()
        if raw_hash == self._last_hash:
            return ClipboardCapture(status='unchanged', source=source, content_hash=raw_hash)
        self._last_hash = raw_hash
        truncated = len(text) > self.max_text_chars
        if truncated:
            text = text[: self.max_text_chars]
        redacted_text, redacted = redact_clipboard_text(text)
        return ClipboardCapture(
            status='captured',
            content=redacted_text,
            content_hash=raw_hash,
            content_length=len(text),
            content_redacted=redacted,
            content_truncated=truncated,
            source=source,
        )
