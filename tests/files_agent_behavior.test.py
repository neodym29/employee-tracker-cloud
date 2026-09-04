#!/usr/bin/env python3
"""Executable behavior tests for the shipped files-agent and TraceMini runtime."""
import hashlib
import hmac
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import zipfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = ROOT / "files-agent" / "files_agent.py"


def load_module(path=PAYLOAD):
    spec = importlib.util.spec_from_file_location("files_agent_behavior", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TraceMiniQueueBehavior(unittest.TestCase):
    def test_restart_idempotency_binding_scoped_ack_and_batch_limit(self):
        m = load_module()
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "queue.sqlite3"
            q = m.Queue(db)
            records = [{"event_key": "same", "kind": "commit"}]
            q.enqueue_trace("binding-a", records)
            q.enqueue_trace("binding-a", records)
            q.enqueue_trace("binding-b", records)
            self.assertEqual(q.trace_count(), 2)
            self.assertEqual([r["binding_id"] for r in q.pending_trace("binding-a")], ["binding-a"])
            q.ack_trace([{**q.pending_trace("binding-a")[0], "event_key": "wrong"}])
            self.assertEqual(q.trace_count(), 2)
            q.ack_trace(q.pending_trace("binding-a"))
            self.assertEqual(q.trace_count(), 1)
            self.assertEqual(q.pending_trace("binding-b")[0]["event_key"], "same")
            q.enqueue_trace("binding-a", [{"event_key": str(i), "kind": "file_activity"} for i in range(251)])
            self.assertEqual(len(q.pending_trace("binding-a", 250)), 250)

    def test_failed_upload_retains_rows_and_success_acks_exact_snapshot(self):
        m = load_module()
        with tempfile.TemporaryDirectory() as td:
            state = Path(td)
            q = m.Queue(state / "queue.sqlite3")
            q.enqueue_trace("b", [{"event_key": "one", "kind": "commit"}, {"event_key": "two", "kind": "dirty"}])
            config = {"tracemini_endpoint": "http://127.0.0.1:1/trace", "device_token": "device", "bindings": [{"binding_id": "b", "binding_secret": "secret", "root": state.as_posix()}], "max_retries": 1}
            with self.assertRaises(RuntimeError):
                m.flush_tracemini(config, state)
            self.assertEqual(q.trace_count(), 2)

            class Response:
                status = 202
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def read(self, *_): return b"{}"
            with mock.patch.object(m.request, "urlopen", return_value=Response()):
                self.assertEqual(m.flush_tracemini(config, state), 2)
            self.assertEqual(q.trace_count(), 0)

    def test_retries_are_bounded_exponential_and_nonce_changes(self):
        m = load_module()
        calls = []
        def fail(req, timeout):
            calls.append(req.headers.get("X-tracemini-nonce"))
            raise m.URLError("temporary")
        with mock.patch.object(m.request, "urlopen", side_effect=fail), mock.patch.object(m.time, "sleep") as pause:
            with self.assertRaises(RuntimeError):
                m._post_json("http://example.test/x", {"device_token": "d", "max_retries": 4}, {"x": 1}, {"binding_id": "b", "binding_secret": "s"})
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(set(calls)), 4)
        self.assertEqual([c.args[0] for c in pause.call_args_list], [0.25, 0.5, 1.0])


class BindingAndGitBehavior(unittest.TestCase):
    def test_binding_longest_canonical_root_and_fail_closed_ambiguity(self):
        m = load_module()
        with tempfile.TemporaryDirectory() as td:
            base = Path(td) / "base"; child = base / "child"; sibling = Path(td) / "base-two"
            child.mkdir(parents=True); sibling.mkdir()
            link = Path(td) / "link"; link.symlink_to(child, target_is_directory=True)
            config = {"bindings": [{"root": str(base), "binding_id": "base", "binding_secret": "s"}, {"root": str(child), "binding_id": "child", "binding_secret": "s"}]}
            self.assertEqual(m.select_binding(config, str(child))["binding_id"], "child")
            self.assertIsNone(m.select_binding(config, str(sibling)))
            self.assertIsNone(m.select_binding({"bindings": [{"root": str(link), "binding_id": "bad", "binding_secret": "s"}]}, str(child)))

    def test_repository_discovery_is_private_and_remote_validation_is_strict(self):
        m = load_module()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
            (root / "x").write_text("x")
            subprocess.run(["git", "-C", str(root), "add", "x"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "message"], check=True)
            for remote in ("https://user:pass@example.com/acme/x.git", "https://example.com/acme/x.git?q=1", "https://example.com/acme/x.git#frag", "git@example.com:acme/x.git"):
                if remote.startswith("git@"):
                    self.assertEqual(m.canonical_repository_key(remote, str(root), "a"), "example.com/acme/x")
                else:
                    with self.assertRaises(RuntimeError): m.canonical_repository_key(remote, str(root), "a")
            metadata = m.repository_metadata(str(root))
            self.assertNotIn("remote_url", metadata)
            self.assertEqual(metadata["kind"], "git")

    def test_bare_remote_push_verification_is_exact_branch_only(self):
        m = load_module()
        with tempfile.TemporaryDirectory() as td:
            root, bare = Path(td) / "work", Path(td) / "remote.git"
            subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            for key, value in (("user.email", "test@example.invalid"), ("user.name", "Test")):
                subprocess.run(["git", "-C", str(root), "config", key, value], check=True)
            subprocess.run(["git", "-C", str(root), "remote", "add", "origin", f"file://{bare}"], check=True)
            (root / "x").write_text("one"); subprocess.run(["git", "-C", str(root), "add", "x"], check=True); subprocess.run(["git", "-C", str(root), "commit", "-qm", "one"], check=True); subprocess.run(["git", "-C", str(root), "push", "-qu", "origin", "HEAD:main"], check=True)
            subprocess.run(["git", "-C", str(root), "checkout", "-qb", "main"], check=True)
            before = m.repository_metadata(str(root)); old = before["provenance"]["head_sha"]
            (root / "x").write_text("two"); subprocess.run(["git", "-C", str(root), "commit", "-qam", "two"], check=True); after = m.repository_metadata(str(root))
            self.assertNotEqual(old, after["provenance"]["head_sha"])
            self.assertEqual(m.verify_remote(str(root), f"file://{bare}", "refs/heads/main"), old)
            with self.assertRaises(RuntimeError): m.verify_remote(str(root), f"file://{bare}", "HEAD")


class PackagedArtifactBehavior(unittest.TestCase):
    def test_extracted_generated_zip_imports_and_runs_in_isolated_home(self):
        # The package route is exercised through the same build artifact consumed by users.
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        route = ROOT / ".next/server/app/api/files-agent/package/route.js"
        self.assertTrue(route.exists())
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "agent.zip"
            script = "const fs=require('fs'),Module=require('module'),ts=require('typescript'); const source=fs.readFileSync(process.argv[1],'utf8'); const mod=new Module(process.argv[1]); mod.filename=process.argv[1]; mod.paths=Module._nodeModulePaths(process.cwd()); mod._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,process.argv[1]); fs.writeFileSync(process.argv[2],mod.exports.buildFilesAgentPackage(process.cwd(),'http://127.0.0.1:9','fae_test','2099-01-01T00:00:00Z'));"
            result = subprocess.run(["node", "-e", script, str(ROOT / "lib/files-agent-package.ts"), str(out)], cwd=ROOT / "files-agent", text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(out) as archive:
                archive.extractall(Path(td) / "extracted")
            bundled = Path(td) / "extracted/files-agent/files_agent.py"
            self.assertTrue(bundled.exists())
            env = os.environ.copy(); env["HOME"] = str(Path(td) / "home"); env["FILES_AGENT_CONFIG"] = str(Path(td) / "home/config.json"); env["FILES_AGENT_STATE_DIR"] = str(Path(td) / "home/state")
            result = subprocess.run([sys.executable, str(bundled), "status"], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"configured": false', result.stdout)


class TraceMiniHttpProtocol(unittest.TestCase):
    def test_bind_heartbeat_and_ingest_use_exact_paths_headers_and_proofs(self):
        m = load_module()
        seen = []
        code = "tmb_one-use-code"
        binding_secret = "binding-secret"
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                raw = self.rfile.read(length)
                body = json.loads(raw)
                path = urlsplit(self.path).path
                binding = self.headers.get("X-TraceMini-Binding", "")
                secret = code if path.endswith("/bind") else binding_secret
                canonical = "\n".join(("POST", path, self.headers["X-TraceMini-Timestamp"], self.headers["X-TraceMini-Nonce"], hashlib.sha256(raw).hexdigest()))
                expected = hmac.new(secret.encode(), canonical.encode(), "sha256").hexdigest()
                self.assert_valid = (self.headers.get("Authorization") == "Bearer device" and self.headers.get("Content-Type") == "application/json" and hmac.compare_digest(expected, self.headers.get("X-TraceMini-Signature", "")))
                seen.append((path, body, self.assert_valid, binding))
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps({"binding_id": "b", "binding_secret": binding_secret, "root_hash": body.get("root_hash")} if path.endswith("/bind") else {"ok": True}).encode())
            def log_message(self, *_args): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                root, state, config_path = Path(td) / "repo", Path(td) / "state", Path(td) / "config.json"
                root.mkdir(); config = {"endpoint": f"http://127.0.0.1:{server.server_port}/api/files-agent/ingest", "tracemini_endpoint": f"http://127.0.0.1:{server.server_port}/api/files-agent/tracemini", "bind_url": f"http://127.0.0.1:{server.server_port}/api/files-agent/tracemini/bind", "heartbeat_url": f"http://127.0.0.1:{server.server_port}/api/files-agent/tracemini/heartbeat", "device_token": "device", "agents": ["codex"], "agent_commands": {"codex": [os.path.realpath(sys.executable)]}, "bindings": []}
                config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
                env = os.environ.copy(); env.update({"FILES_AGENT_CONFIG": str(config_path), "FILES_AGENT_STATE_DIR": str(state)})
                result = subprocess.run([sys.executable, str(PAYLOAD), "bind", "--code", code, "--root", str(root)], env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                bound = json.loads(config_path.read_text()); self.assertNotIn(code, config_path.read_text()); self.assertEqual(config_path.stat().st_mode & 0o077, 0)
                q = m.Queue(state / "queue.sqlite3"); q.enqueue_trace("b", [{"event_key": "event", "kind": "file_activity"}])
                m.heartbeat(bound); self.assertEqual(m.flush_tracemini(bound, state), 1)
                self.assertEqual([item[0] for item in seen], ["/api/files-agent/tracemini/bind", "/api/files-agent/tracemini/heartbeat", "/api/files-agent/tracemini"])
                self.assertTrue(all(item[2] for item in seen))
        finally:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    unittest.main()
