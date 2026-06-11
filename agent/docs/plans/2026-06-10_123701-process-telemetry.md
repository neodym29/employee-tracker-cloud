# Process Telemetry Implementation Plan

> **For Hermes:** Implement the process telemetry increment task-by-task with tests and verification.

**Goal:** Extend the existing employee tracker so it records system-wide process inventory and lifecycle changes without app-specific plugins.

**Architecture:** Keep the current SQLite + polling collector architecture. Add a `/proc`-backed process scanner in `system.py`, persist both point-in-time process snapshots and start/exit lifecycle events in `db.py`, and export the new datasets from the CLI.

**Tech Stack:** Python 3.10+, stdlib only, SQLite, Linux `/proc`.

---

## Planned tasks

1. Add tests that define expected process metadata parsing and lifecycle diff behavior.
2. Implement `/proc` process scanning helpers in `system.py`.
3. Extend the SQLite schema plus insert/fetch helpers for process snapshots and lifecycle events.
4. Update the collector to diff current vs previous process state and persist start/exit/snapshot records.
5. Extend CSV export for the new datasets.
6. Run the test suite and a small CLI smoke test.

## Files likely to change

- `src/employee_tracker/system.py`
- `src/employee_tracker/db.py`
- `src/employee_tracker/collector.py`
- `src/employee_tracker/cli.py`
- `README.md`
- `tests/test_system.py`
- `tests/test_db.py`
- `tests/test_cli.py`

## Verification

- `python3 -m unittest discover -s tests -v`
- `python3 -m employee_tracker.cli init-db`
- `python3 -m employee_tracker.cli export-csv --output /tmp/employee-tracker.csv --dataset processes`
