from __future__ import annotations

import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Iterator

TEXTUAL_SUFFIXES = {
    '.py', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.css', '.html', '.htm', '.sh', '.rb', '.go', '.rs',
    '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sql', '.xml', '.csv', '.env',
}

LANGUAGE_BY_SUFFIX = {
    '.py': 'python', '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.json': 'json', '.md': 'markdown', '.txt': 'text', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.ini': 'ini', '.cfg': 'ini', '.css': 'css', '.html': 'html', '.htm': 'html', '.sh': 'shell',
    '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
    '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php', '.sql': 'sql', '.xml': 'xml', '.csv': 'csv', '.env': 'text',
    '.ppt': 'presentation', '.pptx': 'presentation', '.key': 'presentation', '.odp': 'presentation',
    '.doc': 'document', '.docx': 'document', '.odt': 'document', '.pdf': 'pdf',
    '.xls': 'spreadsheet', '.xlsx': 'spreadsheet', '.ods': 'spreadsheet',
}

METADATA_ONLY_SUFFIXES = {
    '.ppt', '.pptx', '.key', '.odp', '.doc', '.docx', '.odt', '.pdf', '.xls', '.xlsx', '.ods',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.xz', '.bz2', '.iso', '.dmg', '.deb', '.rpm', '.appimage',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.mp4', '.mov', '.mkv', '.avi', '.webm',
    '.mp3', '.wav', '.flac', '.ogg', '.sqlite', '.db', '.bin', '.exe', '.so', '.dll',
}

EXCLUDED_DIR_NAMES = {
    '.git', '.hg', '.svn', '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', 'venv',
    'env', '__pycache__', 'node_modules', 'dist', 'build', 'out', 'target', 'screenshots',
    'snap', '.npm', '.cargo', '.rustup', '.local', '.var', '.mozilla', '.config',
}

EXCLUDED_FILE_NAMES = {
    'activity.sqlite3', 'activity.sqlite3-wal', 'activity.sqlite3-shm',
}

BINARY_SNIFF_BYTES = 8192
CHUNK_SIZE = 1024 * 1024
MAX_FILE_BYTES_TO_READ = 20 * 1024 * 1024


@dataclass(frozen=True)
class FileSnapshot:
    absolute_path: str
    relative_path: str
    file_size: int
    mtime_ns: int
    line_count: int | None
    sha256: str
    language: str | None


def language_for_path(path: Path) -> str | None:
    return LANGUAGE_BY_SUFFIX.get(path.suffix.lower())


def _metadata_hash(stat_size: int, mtime_ns: int, path: Path) -> str:
    payload = f'{path.name}:{stat_size}:{mtime_ns}'.encode('utf-8', errors='replace')
    return sha256(payload).hexdigest()


def _analyze_file(path: Path, stat_size: int, mtime_ns: int) -> tuple[str, int | None, str | None]:
    suffix = path.suffix.lower()
    language = language_for_path(path)
    if suffix in METADATA_ONLY_SUFFIXES:
        return _metadata_hash(stat_size, mtime_ns, path), None, language
    if stat_size > MAX_FILE_BYTES_TO_READ:
        if language is None and suffix in TEXTUAL_SUFFIXES:
            language = 'text'
        return _metadata_hash(stat_size, mtime_ns, path), None, language

    digest = sha256()
    textual = suffix in TEXTUAL_SUFFIXES
    line_count = 0
    last_chunk_had_newline = True
    saw_bytes = False
    sniff = b''

    with path.open('rb') as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            saw_bytes = True
            digest.update(chunk)
            if len(sniff) < BINARY_SNIFF_BYTES:
                sniff += chunk[: BINARY_SNIFF_BYTES - len(sniff)]
            if textual:
                line_count += chunk.count(b'\n')
                last_chunk_had_newline = chunk.endswith(b'\n')

    if not textual:
        if b'\x00' in sniff:
            textual = False
        else:
            try:
                sniff.decode('utf-8')
                textual = True
            except UnicodeDecodeError:
                textual = False

    if textual and language is None:
        language = 'text'

    if textual:
        if saw_bytes and not last_chunk_had_newline:
            line_count += 1
        return digest.hexdigest(), line_count, language
    return digest.hexdigest(), None, language


def collect_snapshot(path: Path, workspace_root: Path, previous: dict[str, object] | None = None) -> FileSnapshot | None:
    try:
        stat_result = path.stat()
        if previous is not None and previous.get('file_size') == stat_result.st_size and previous.get('mtime_ns') == stat_result.st_mtime_ns:
            return FileSnapshot(
                absolute_path=str(path),
                relative_path=path.relative_to(workspace_root).as_posix(),
                file_size=stat_result.st_size,
                mtime_ns=stat_result.st_mtime_ns,
                line_count=previous.get('line_count') if isinstance(previous.get('line_count'), int) else None,
                sha256=str(previous.get('sha256') or _metadata_hash(stat_result.st_size, stat_result.st_mtime_ns, path)),
                language=previous.get('language') if isinstance(previous.get('language'), str) else None,
            )
        file_hash, line_count, language = _analyze_file(path, stat_result.st_size, stat_result.st_mtime_ns)
    except OSError:
        return None

    return FileSnapshot(
        absolute_path=str(path),
        relative_path=path.relative_to(workspace_root).as_posix(),
        file_size=stat_result.st_size,
        mtime_ns=stat_result.st_mtime_ns,
        line_count=line_count,
        sha256=file_hash,
        language=language,
    )


def scan_workspace(workspace_root: Path, previous_state: dict[str, dict[str, object]] | None = None) -> Iterator[FileSnapshot]:
    workspace_root = workspace_root.resolve()
    if not workspace_root.exists():
        return iter(())

    def _iterator() -> Iterator[FileSnapshot]:
        for directory, dir_names, file_names in os.walk(workspace_root):
            current_directory = Path(directory)
            dir_names[:] = [
                name for name in dir_names
                if name not in EXCLUDED_DIR_NAMES and not name.startswith('.')
            ]
            file_names.sort()
            for file_name in file_names:
                if file_name in EXCLUDED_FILE_NAMES:
                    continue
                file_path = current_directory / file_name
                previous = previous_state.get(file_path.relative_to(workspace_root).as_posix()) if previous_state else None
                snapshot = collect_snapshot(file_path, workspace_root, previous)
                if snapshot is not None:
                    yield snapshot

    return _iterator()
