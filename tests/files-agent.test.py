#!/usr/bin/env python3
"""Tests for the privacy-safe files-only CLI payload (stdlib unittest only)."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.error import URLError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = ROOT / "files-agent" / "files_agent.py"


def load_module():
    spec = importlib.util.spec_from_file_location("files_agent", PAYLOAD)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_module()

    def test_parses_only_successful_mutations_and_resolves_paths(self):
        trace = '''100 chdir("/work/project") = 0
100 openat(AT_FDCWD</work/project>, "new.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</work/project/new.txt>
100 write(3</work/project/new.txt>, "SECRET THAT MUST NEVER APPEAR", 29) = 29
100 openat(AT_FDCWD</work/project>, "read.txt", O_RDONLY) = 4</work/project/read.txt>
100 write(4</work/project/read.txt>, "x", 1) = -1 EBADF (Bad file descriptor)
100 mkdirat(AT_FDCWD</work/project>, "folder", 0777) = 0
100 renameat2(AT_FDCWD</work/project>, "new.txt", AT_FDCWD</work/project>, "renamed.txt", RENAME_NOREPLACE) = 0
100 unlinkat(AT_FDCWD</work/project>, "missing", 0) = -1 ENOENT (No such file or directory)
'''.splitlines()
        events = self.m.TraceParser("/start", ["/state/queue.sqlite3"]).parse(trace)
        projected = {(e.action, e.path, e.bytes) for e in events}
        self.assertIn(("create", "/work/project/new.txt", 0), projected)
        self.assertIn(("write", "/work/project/new.txt", 29), projected)
        self.assertIn(("mkdir", "/work/project/folder", 0), projected)
        self.assertIn(("rename_from", "/work/project/new.txt", 0), projected)
        self.assertIn(("rename_to", "/work/project/renamed.txt", 0), projected)
        self.assertNotIn("SECRET", json.dumps([e.as_dict() for e in events]))
        self.assertFalse(any(e.path.endswith("read.txt") for e in events))
        self.assertFalse(any(e.path.endswith("missing") for e in events))

    def test_fd_operations_openat2_relative_dirfd_coalesce_and_exclusions(self):
        trace = '''9 openat2(5</tmp/base>, "a.bin", {flags=O_RDWR|O_CREAT|O_CLOEXEC, mode=0600, resolve=0}, 24) = 7</tmp/base/a.bin>
9 pwrite64(7</tmp/base/a.bin>, "private", 7, 0) = 7
9 writev(7</tmp/base/a.bin>, [{iov_base="more", iov_len=4}], 1) = 4
9 ftruncate(7</tmp/base/a.bin>, 2) = 0
9 fallocate(7</tmp/base/a.bin>, 0, 0, 10) = 0
9 copy_file_range(3</tmp/source>, NULL, 7</tmp/base/a.bin>, NULL, 8, 0) = 8
9 sendfile(7</tmp/base/a.bin>, 3</tmp/source>, NULL, 6) = 6
9 write(8</proc/self/fd/1>, "x", 1) = 1
9 write(10</state/queue.sqlite3-wal>, "x", 1) = 1
'''.splitlines()
        events = self.m.TraceParser("/", ["/state/queue.sqlite3"]).parse(trace)
        by_action = {e.action: e for e in events}
        self.assertEqual(by_action["write"].path, "/tmp/base/a.bin")
        self.assertEqual(by_action["write"].bytes, 25)
        self.assertEqual(by_action["write"].count, 5)
        self.assertEqual(by_action["truncate"].count, 1)
        self.assertFalse(any(e.path.startswith("/proc") or e.path.startswith("/state/queue") for e in events))

    def test_successful_path_truncate_is_traced_and_resolved(self):
        trace = ['44 chdir("/tmp/work") = 0',
                 '44 truncate("relative.bin", 17) = 0',
                 '44 truncate("failed.bin", 0) = -1 ENOENT (No such file or directory)']
        events = self.m.TraceParser("/wrong", []).parse(trace)
        self.assertEqual([(e.action, e.path) for e in events], [("truncate", "/tmp/work/relative.bin")])

    def test_workspace_boundary_excludes_agent_runtime_and_os_noise(self):
        trace = '''7 openat(AT_FDCWD</work/project>, "result.txt", O_WRONLY|O_CREAT, 0666) = 3</work/project/result.txt>
7 write(3</work/project/result.txt>, "private", 7) = 7
7 openat(AT_FDCWD</home/alice/.hermes>, "state.db", O_WRONLY|O_CREAT, 0600) = 4</home/alice/.hermes/state.db>
7 write(4</home/alice/.hermes/state.db>, "private", 7) = 7
7 creat("/tmp/helper", 0600) = 5</tmp/helper>
7 write(5</tmp/helper>, "private", 7) = 7
'''.splitlines()
        events = self.m.TraceParser("/work/project", [], allowed_roots=["/work/project"]).parse(trace)
        self.assertEqual({event.path for event in events}, {"/work/project/result.txt"})

    def test_writable_shared_mmap_emits_write_only_when_metadata_changes(self):
        with tempfile.TemporaryDirectory() as td:
            changed = Path(td) / "changed"
            untouched = Path(td) / "untouched"
            changed.write_bytes(b"one")
            untouched.write_bytes(b"two")

            def trace():
                yield f'5 openat(AT_FDCWD, "{changed}", O_RDONLY) = 3<{changed}>'
                yield f'5 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, 3<{changed}>, 0) = 0x1000'
                yield f'5 openat(AT_FDCWD, "{untouched}", O_RDONLY) = 4<{untouched}>'
                yield f'5 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, 4<{untouched}>, 0) = 0x2000'
                time.sleep(0.002)
                changed.write_bytes(b"changed-size")

            events = self.m.TraceParser(td, []).parse(trace())
            writes = {event.path for event in events if event.action == "write"}
            self.assertEqual(writes, {str(changed)})

    def test_successful_msync_attributes_only_the_matching_shared_mapping(self):
        trace = '''5 openat(AT_FDCWD</work>, "changed", O_RDWR) = 3</work/changed>
5 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, 3</work/changed>, 0) = 0x1000
5 openat(AT_FDCWD</work>, "untouched", O_RDWR) = 4</work/untouched>
5 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_SHARED, 4</work/untouched>, 0) = 0x3000
5 msync(0x1000, 4096, MS_SYNC) = 0
'''.splitlines()
        events = self.m.TraceParser("/work", []).parse(trace)
        writes = {event.path for event in events if event.action == "write"}
        self.assertEqual(writes, {"/work/changed"})

    def test_unfinished_lines_descendant_cwd_and_all_metadata_calls(self):
        trace = '''20 chdir("/tmp/tree") = 0
21 mkdir("child", 0777 <unfinished ...>
21 <... mkdir resumed>) = 0
21 symlink("target-value", "child/link") = 0
21 link("child/link", "hard") = 0
21 rename("hard", "moved") = 0
21 unlink("moved") = 0
21 rmdir("child") = 0
'''.splitlines()
        events = self.m.TraceParser("/tmp/tree", []).parse(trace)
        actions = {e.action for e in events}
        self.assertTrue({"mkdir", "symlink", "link_from", "link_to", "rename_from", "rename_to", "unlink", "rmdir"} <= actions)
        # Symlink target is not a touched file path and must not be collected.
        self.assertFalse(any(e.path.endswith("target-value") for e in events))

    def test_clone_fork_and_vfork_inherit_cwd_and_file_descriptors(self):
        trace = '''100 chdir("/parent") = 0
100 openat(AT_FDCWD, "shared.txt", O_WRONLY|O_CREAT, 0666) = 3
100 clone(child_stack=NULL, flags=SIGCHLD) = 101
101 write(3, "private", 7) = 7
100 fork() = 102
102 chdir("fork-child") = 0
102 mkdir("made", 0777) = 0
100 vfork() = 103
103 mkdir("vfork-child", 0777) = 0
'''.splitlines()
        events = self.m.TraceParser("/different-initial-cwd", []).parse(trace)
        projected = {(event.action, event.path, event.bytes) for event in events}
        self.assertIn(("write", "/parent/shared.txt", 7), projected)
        self.assertIn(("mkdir", "/parent/fork-child/made", 0), projected)
        self.assertIn(("mkdir", "/parent/vfork-child", 0), projected)

    def test_unfinished_vfork_defers_child_calls_until_state_is_inherited(self):
        trace = '''300 chdir("/parent-before-vfork") = 0
300 openat(AT_FDCWD, "inherited", O_WRONLY|O_CREAT, 0666) = 4
300 vfork( <unfinished ...>
301 write(4, "private", 5) = 5
301 mkdir("before-parent-resumes", 0777) = 0
300 <... vfork resumed>) = 301
'''.splitlines()
        events = self.m.TraceParser("/wrong-initial", []).parse(trace)
        projected = {(event.action, event.path, event.bytes) for event in events}
        self.assertIn(("write", "/parent-before-vfork/inherited", 5), projected)
        self.assertIn(("mkdir", "/parent-before-vfork/before-parent-resumes", 0), projected)

    def test_clone_fs_and_files_share_parent_child_state(self):
        trace = '''200 clone(child_stack=NULL, flags=CLONE_FS|CLONE_FILES|SIGCHLD) = 201
200 chdir("/after-clone") = 0
201 mkdir("from-child", 0777) = 0
201 openat(AT_FDCWD, "child-opened", O_WRONLY|O_CREAT, 0666) = 8
200 write(8, "private", 3) = 3
201 close(8) = 0
200 write(8, "must-not-count", 14) = 14
200 clone3({flags=CLONE_FS|CLONE_FILES, exit_signal=SIGCHLD}, 88) = 202
202 chdir("nested") = 0
200 mkdir("parent-follows", 0777) = 0
'''.splitlines()
        events = self.m.TraceParser("/different-initial-cwd", []).parse(trace)
        projected = {(event.action, event.path, event.bytes) for event in events}
        self.assertIn(("mkdir", "/after-clone/from-child", 0), projected)
        self.assertIn(("write", "/after-clone/child-opened", 3), projected)
        self.assertNotIn(("write", "/after-clone/child-opened", 17), projected)
        self.assertIn(("mkdir", "/after-clone/nested/parent-follows", 0), projected)


class QueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_module()

    def test_each_enqueue_contribution_is_an_immutable_row(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "queue.sqlite3"
            q = self.m.Queue(db)
            event = self.m.Event("write", "/tmp/a", 3, 1)
            q.enqueue("codex", "run-id", [event, event])
            rows = q.pending()
            self.assertEqual(len(rows), 2)
            self.assertEqual([(row["bytes"], row["count"]) for row in rows], [(3, 1), (3, 1)])
            self.assertEqual(len({row["event_id"] for row in rows}), 2)
            wrong_identity = dict(rows[0], event_id="not-the-uploaded-identity")
            q.ack([wrong_identity])
            self.assertEqual(q.count(), 2)
            q.ack(rows)
            self.assertEqual(q.count(), 0)
            self.assertEqual(db.stat().st_mode & 0o077, 0)

    def test_wire_event_id_is_stable_unique_and_not_reused_after_drain(self):
        with tempfile.TemporaryDirectory() as td:
            q = self.m.Queue(Path(td) / "queue.sqlite3")
            q.enqueue("codex", "first", [self.m.Event("write", "/tmp/a")])
            first = q.pending()[0]
            self.assertLessEqual(len(first["event_id"]), 200)
            q.ack([first])
            q.enqueue("codex", "second", [self.m.Event("write", "/tmp/b")])
            second = q.pending()[0]
            self.assertNotEqual(first["event_id"], second["event_id"])
            self.assertGreater(second["id"], first["id"])

    def test_existing_queue_schema_is_migrated_without_losing_rows(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "queue.sqlite3"
            with sqlite3.connect(db) as connection:
                connection.execute("""CREATE TABLE events (
                    id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, agent TEXT NOT NULL,
                    action TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
                    count INTEGER NOT NULL, occurred_at TEXT NOT NULL,
                    UNIQUE(run_id, agent, action, path))""")
                connection.execute("INSERT INTO events VALUES (1,'r','codex','write','/tmp/a',1,1,'now')")
            q = self.m.Queue(db)
            row = q.pending()[0]
            self.assertEqual(row["id"], 1)
            self.assertTrue(row["event_id"])
            q.ack([row])
            q.enqueue("codex", "new", [self.m.Event("write", "/tmp/b")])
            self.assertGreater(q.pending()[0]["id"], 1)

    def test_existing_coalescing_event_id_schema_becomes_immutable_without_losing_rows_or_id(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "queue.sqlite3"
            with sqlite3.connect(db) as connection:
                connection.execute("""CREATE TABLE events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
                    run_id TEXT NOT NULL, agent TEXT NOT NULL,
                    action TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
                    count INTEGER NOT NULL, occurred_at TEXT NOT NULL,
                    UNIQUE(run_id, agent, action, path))""")
                connection.execute(
                    "INSERT INTO events (event_id,run_id,agent,action,path,bytes,count,occurred_at) "
                    "VALUES ('stable','r','codex','write','/tmp/a',3,2,'now')"
                )
            q = self.m.Queue(db)
            row = q.pending()[0]
            self.assertEqual((row["event_id"], row["bytes"], row["count"]), ("stable", 3, 2))
            self.assertNotIn("revision", row)
            q.enqueue("codex", "r", [self.m.Event("write", "/tmp/a", 7, 4)])
            rows = q.pending()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["event_id"], "stable")
            self.assertNotEqual(rows[1]["event_id"], "stable")
            q.ack([row])
            self.assertEqual(q.count(), 1)


class UploadAndCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = self.home / "state"
        self.config = self.home / "config.json"
        self.requests = []
        self.pause_response = False
        self.upload_received = threading.Event()
        self.release_response = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                size = int(self.headers.get("content-length", "0"))
                outer.requests.append((self.path, dict(self.headers), json.loads(self.rfile.read(size))))
                outer.upload_received.set()
                if outer.pause_response:
                    outer.release_response.wait(timeout=10)
                self.send_response(202)
                self.end_headers()
            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def env(self):
        env = os.environ.copy()
        env.update({
            "FILES_AGENT_CONFIG": str(self.config),
            "FILES_AGENT_STATE_DIR": str(self.state),
            "FILES_AGENT_NO_BACKGROUND": "1",
        })
        return env

    def configure(self, auth="bearer", agents=None, agent_commands=None):
        agents = ["codex"] if agents is None else agents
        agent_commands = ({"codex": [os.path.realpath(sys.executable)]}
                          if agent_commands is None else agent_commands)
        self.config.write_text(json.dumps({
            "endpoint": f"http://127.0.0.1:{self.server.server_port}/v1/file-events",
            "device_token": "device-secret",
            "auth": auth,
            "agents": agents,
            "agent_commands": agent_commands,
        }))
        self.config.chmod(0o600)

    def run_cli(self, *args, check=True):
        return subprocess.run([sys.executable, str(PAYLOAD), *args], env=self.env(), text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def test_flush_uploads_safe_schema_and_bearer_then_clears_queue(self):
        self.configure()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 4, 1)])
        result = self.run_cli("flush")
        self.assertEqual(json.loads(result.stdout)["uploaded"], 1)
        self.assertEqual(len(self.requests), 1)
        path, headers, body = self.requests[0]
        self.assertEqual(path, "/v1/file-events")
        self.assertEqual(headers["Authorization"], "Bearer device-secret")
        self.assertEqual(set(body), {"device_id", "events"})
        self.assertEqual(set(body["events"][0]), {"event_id", "run_id", "agent", "action", "path", "bytes", "count", "occurred_at"})
        self.assertNotIn("device-secret", json.dumps(body))
        self.assertEqual(q.count(), 0)

    def test_flush_limits_each_request_to_250_and_drains_multiple_batches(self):
        self.configure()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [
            m.Event("write", f"/tmp/file-{index}", index, 1) for index in range(503)
        ])
        result = self.run_cli("flush")
        self.assertEqual(json.loads(result.stdout)["uploaded"], 503)
        self.assertEqual([len(item[2]["events"]) for item in self.requests], [250, 250, 3])
        self.assertTrue(all(len(item[2]["events"]) <= 250 for item in self.requests))
        self.assertEqual(q.count(), 0)

    def test_enqueue_during_upload_retains_and_then_uploads_only_the_new_delta(self):
        self.configure()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 4, 1)])
        self.pause_response = True
        config = json.loads(self.config.read_text())
        result = []
        errors = []

        def flush_queue():
            try:
                result.append(m.flush(q, config, self.state))
            except Exception as error:
                errors.append(error)

        worker = threading.Thread(target=flush_queue)
        worker.start()
        try:
            self.assertTrue(self.upload_received.wait(timeout=5), "initial upload was not received")
            first = self.requests[0][2]["events"][0]
            self.assertEqual((first["bytes"], first["count"]), (4, 1))

            # The matching contribution gets its own immutable queue row.
            q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 7, 2)])
            pending = q.pending()
            self.assertEqual(len(pending), 2)
            self.assertEqual([(row["bytes"], row["count"]) for row in pending], [(4, 1), (7, 2)])
            self.assertNotEqual(pending[0]["event_id"], pending[1]["event_id"])
        finally:
            self.pause_response = False
            self.release_response.set()
            worker.join(timeout=10)

        self.assertFalse(worker.is_alive(), "flush did not terminate")
        self.assertEqual(errors, [])
        self.assertEqual(result, [2])
        uploaded = [event for item in self.requests for event in item[2]["events"]]
        self.assertEqual([(event["bytes"], event["count"]) for event in uploaded], [(4, 1), (7, 2)])
        self.assertNotEqual(uploaded[0]["event_id"], uploaded[1]["event_id"])
        self.assertEqual(sum(event["bytes"] for event in uploaded), 11)
        self.assertEqual(sum(event["count"] for event in uploaded), 3)
        self.assertEqual(q.count(), 0)

    def test_ambiguous_accepted_response_keeps_original_identity_and_does_not_lose_delta(self):
        self.configure()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 4, 1)])
        original = q.pending()[0]
        accepted = {}
        requests = []
        first_request = True

        class Response:
            status = 202

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def accept_then_respond(req, timeout):
            nonlocal first_request
            events = json.loads(req.data)["events"]
            requests.append(events)
            # Model server-side event_id dedupe: retrying an accepted event is harmless.
            for event in events:
                accepted.setdefault(event["event_id"], event)
            if first_request:
                first_request = False
                # A matching contribution arrives while the first result is ambiguous.
                q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 7, 2)])
                raise URLError("connection closed after server accepted request")
            return Response()

        config = json.loads(self.config.read_text())
        with mock.patch.object(m.request, "urlopen", side_effect=accept_then_respond):
            with self.assertRaisesRegex(RuntimeError, "events retained"):
                m.flush(q, config, self.state)
            pending = q.pending()
            self.assertEqual(len(pending), 2)
            self.assertEqual(pending[0]["event_id"], original["event_id"])
            self.assertNotEqual(pending[1]["event_id"], original["event_id"])
            self.assertEqual(m.flush(q, config, self.state), 2)

        self.assertEqual(requests[0][0]["event_id"], original["event_id"])
        self.assertEqual(requests[1][0]["event_id"], original["event_id"])
        self.assertEqual(len(accepted), 2)
        self.assertEqual(sum(event["bytes"] for event in accepted.values()), 11)
        self.assertEqual(sum(event["count"] for event in accepted.values()), 3)
        self.assertEqual(q.count(), 0)

    def test_two_concurrent_flushers_do_not_upload_the_same_claimed_rows(self):
        self.configure()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [m.Event("write", f"/tmp/{i}") for i in range(30)])
        processes = [subprocess.Popen(
            [sys.executable, str(PAYLOAD), "flush", "--quiet"], env=self.env(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        results = [process.communicate(timeout=20) for process in processes]
        self.assertTrue(all(process.returncode == 0 for process in processes), results)
        uploaded = [event["event_id"] for item in self.requests for event in item[2]["events"]]
        self.assertEqual(len(uploaded), 30)
        self.assertEqual(len(set(uploaded)), 30)
        self.assertEqual(q.count(), 0)

    def test_x_device_token_and_http_failure_retains_queue(self):
        self.configure("x-device-token")
        self.server.shutdown()
        m = load_module()
        q = m.Queue(self.state / "queue.sqlite3")
        q.enqueue("codex", "session", [m.Event("write", "/tmp/file", 4, 1)])
        result = self.run_cli("flush", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(q.count(), 1)

    @unittest.skipUnless(Path("/usr/bin/strace").exists(), "strace unavailable")
    def test_exec_integration_preserves_stdio_exit_and_records_descendants(self):
        self.configure()
        script = self.home / "worker.py"
        output = self.home / "made.txt"
        script.write_text("import os,sys\np=os.environ['OUT']\npid=os.fork()\nif pid==0:\n open(p,'w').write('not uploaded')\n os._exit(0)\nos.waitpid(pid,0)\nprint('visible')\nsys.exit(7)\n")
        env = self.env()
        env["OUT"] = str(output)
        result = subprocess.run([sys.executable, str(PAYLOAD), "exec", "--agent", "codex", "--",
                                 sys.executable, str(script), "private-command-argument"], env=env,
                                cwd=self.home, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, "visible\n")
        status = self.run_cli("status")
        data = json.loads(status.stdout)
        self.assertGreaterEqual(data["pending"], 1)
        listed = json.loads(self.run_cli("list").stdout)
        self.assertTrue(any(e["path"] == str(output) for e in listed))
        serialized = json.dumps(listed)
        self.assertNotIn("not uploaded", serialized)
        self.assertNotIn("private-command-argument", serialized)

    @unittest.skipUnless(Path("/usr/bin/strace").exists(), "strace unavailable")
    def test_exec_records_changed_shared_mmap_but_not_untouched_mapping(self):
        self.configure()
        changed = self.home / "mapped-changed.bin"
        untouched = self.home / "mapped-untouched.bin"
        changed.write_bytes(b"abc")
        untouched.write_bytes(b"xyz")
        script = self.home / "mmap-worker.py"
        script.write_text(
            "import mmap,os\n"
            "for index,name in enumerate((os.environ['CHANGED'],os.environ['UNTOUCHED'])):\n"
            " f=open(name,'r+b')\n"
            " m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE)\n"
            " if index == 0: m[0:1]=b'Q'; m.flush()\n"
            " m.close(); f.close()\n"
        )
        env = self.env()
        env.update({"CHANGED": str(changed), "UNTOUCHED": str(untouched)})
        result = subprocess.run(
            [sys.executable, str(PAYLOAD), "exec", "--agent", "codex", "--",
             sys.executable, str(script)], env=env, cwd=self.home, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        listed = json.loads(self.run_cli("list").stdout)
        mmap_writes = {event["path"] for event in listed if event["action"] == "write"}
        self.assertIn(str(changed), mmap_writes)
        self.assertNotIn(str(untouched), mmap_writes)

    @unittest.skipUnless(Path("/usr/bin/strace").exists(), "strace unavailable")
    def test_exec_records_path_truncate(self):
        self.configure()
        target = self.home / "truncate-me"
        target.write_bytes(b"long")
        script = self.home / "truncate-worker.py"
        script.write_text("import os\nos.truncate(os.environ['TARGET'], 1)\n")
        env = self.env()
        env["TARGET"] = str(target)
        result = subprocess.run(
            [sys.executable, str(PAYLOAD), "exec", "--agent", "codex", "--",
             sys.executable, str(script)], env=env, cwd=self.home, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        listed = json.loads(self.run_cli("list").stdout)
        self.assertTrue(any(event["action"] == "truncate" and event["path"] == str(target)
                            for event in listed))

    def test_rejects_unapproved_agent_and_missing_separator(self):
        self.configure()
        bad = self.run_cli("exec", "--agent", "other", "--", "/bin/true", check=False)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("approved", bad.stderr.lower())

    def test_config_rejects_agents_outside_the_client_allowlist(self):
        self.configure(
            agents=["test-agent"],
            agent_commands={"test-agent": [os.path.realpath(sys.executable)]},
        )
        result = self.run_cli("flush", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hermes, codex, or claude", result.stderr.lower())

    def test_config_rejects_noncanonical_approved_agent_command(self):
        alias = self.home / "codex"
        alias.symlink_to(os.path.realpath(sys.executable))
        self.configure(agents=["codex"], agent_commands={"codex": [str(alias)]})
        result = self.run_cli("flush", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical absolute executable paths", result.stderr.lower())

    def test_exec_fails_closed_without_agents_or_command_mapping(self):
        self.configure(agents=[], agent_commands={})
        empty = self.run_cli("exec", "--agent", "codex", "--", sys.executable,
                             "-c", "pass", check=False)
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("nonempty", empty.stderr.lower())

        self.configure(agent_commands={})
        unmapped = self.run_cli("exec", "--agent", "codex", "--", sys.executable,
                                "-c", "pass", check=False)
        self.assertNotEqual(unmapped.returncode, 0)
        self.assertIn("agent_commands", unmapped.stderr)

    def test_exec_rejects_command_that_does_not_match_agent_mapping(self):
        self.configure(agent_commands={"codex": [os.path.realpath("/bin/true")]})
        result = self.run_cli("exec", "--agent", "codex", "--", sys.executable,
                              "-c", "pass", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr.lower())


class PackagingTests(unittest.TestCase):
    def test_manifest_and_installer_are_user_scoped_and_privacy_explicit(self):
        manifest = json.loads((ROOT / "files-agent" / "manifest.json").read_text())
        self.assertEqual(manifest["runtime"], "python3-stdlib")
        self.assertIn("strace", manifest["requires"])
        installer = (ROOT / "files-agent" / "install.sh.template").read_text()
        self.assertIn("{{ENDPOINT}}", installer)
        self.assertIn("{{DEVICE_TOKEN}}", installer)
        self.assertIn("$HOME/.local", installer)
        self.assertNotIn("sudo", installer)
        mode = PAYLOAD.stat().st_mode
        self.assertTrue(mode & 0o100)


if __name__ == "__main__":
    unittest.main()
