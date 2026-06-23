from __future__ import annotations

from datetime import datetime, timezone
import os
import sqlite3
import time
from typing import Any

from .db import cloud_queue_stats


def _rss_bytes_from_proc() -> int:
    try:
        with open('/proc/self/statm', 'r', encoding='utf-8') as handle:
            parts = handle.read().split()
        if len(parts) >= 2:
            return int(parts[1]) * os.sysconf('SC_PAGE_SIZE')
    except Exception:
        pass
    try:
        with open('/proc/self/status', 'r', encoding='utf-8') as handle:
            for line in handle:
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return 0


def _cpu_seconds() -> float:
    try:
        return float(time.process_time())
    except Exception:
        return 0.0


def collect_resource_usage(connection: sqlite3.Connection, *, username: str, host: str) -> dict[str, Any]:
    stats = cloud_queue_stats(connection)
    return {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'event_type': 'tracker_resource_usage',
        'username': username,
        'host': host,
        'hostname': host,
        'app_name': 'Neodym Tracker',
        'window_title': 'Tracker resource usage',
        'source': 'employee-tracker-agent',
        'process_rss_bytes': _rss_bytes_from_proc(),
        'process_cpu_seconds': _cpu_seconds(),
        'cloud_queue_pending_count': stats['pending_count'],
        'cloud_queue_pending_bytes': stats['pending_bytes'],
        'cloud_queue_dropped_count': stats['dropped_count'],
        'cloud_queue_dropped_bytes': stats['dropped_bytes'],
    }
