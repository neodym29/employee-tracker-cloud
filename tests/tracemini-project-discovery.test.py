import importlib.util
import os
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("files_agent", ROOT / "files-agent" / "files_agent.py")
agent = importlib.util.module_from_spec(SPEC)
sys.modules["files_agent"] = agent
SPEC.loader.exec_module(agent)


class TraceMiniDiscoveryTests(unittest.TestCase):
    def test_discovery_is_bounded_and_skips_symlinks_and_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "good").mkdir()
            subprocess.run(["git", "init", "-q", str(root / "good")], check=True)
            (root / "node_modules" / "hidden").mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(root / "node_modules" / "hidden")], check=True)
            (root / "link").symlink_to(root / "good", target_is_directory=True)
            found = agent.discover_repositories(str(root), max_depth=12, max_directories=100, max_repositories=10, timeout_seconds=5)
            self.assertEqual([str(root / "good")], found)

    def test_canonical_remote_identity_rejects_credentials_and_normalizes_git_hosts(self):
        self.assertEqual("github.com/acme/project", agent.canonical_repository_key("git@github.com:acme/project.git", "/tmp/project", "a" * 40))
        self.assertEqual("github.com/acme/project", agent.canonical_repository_key("https://github.com/acme/project.git", "/tmp/project", "a" * 40))
        with self.assertRaises(RuntimeError):
            agent.canonical_repository_key("https://user:secret@example.com/acme/project.git", "/tmp/project", "a" * 40)

    def test_fingerprint_has_device_identity_and_hooks_preserve_originals(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / ".git" / "hooks").mkdir(parents=True, exist_ok=True)
            original = repo / ".git" / "hooks" / "post-commit"
            original.write_text("#!/bin/sh\nprintf original\n")
            fingerprint = agent.repository_fingerprint(str(repo))
            self.assertIn("device_id", fingerprint)
            self.assertIn("inode", fingerprint)
            agent.install_managed_git_hooks(str(repo), "https://example.test", "device-1")
            self.assertIn("printf original", original.read_text())
            self.assertIn("TraceMini", original.read_text())

    def test_worktree_git_file_resolves_common_git_dir(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            worktree = root / "worktree"
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "config", "user.email", "test@example.test"], check=True)
            subprocess.run(["git", "-C", str(source), "config", "user.name", "Test"], check=True)
            (source / "README").write_text("x")
            subprocess.run(["git", "-C", str(source), "add", "README"], check=True)
            subprocess.run(["git", "-C", str(source), "commit", "-qm", "init"], check=True)
            subprocess.run(["git", "-C", str(source), "worktree", "add", "-q", str(worktree)], check=True)
            self.assertEqual(agent.git_root(str(worktree)), str(worktree))
            self.assertEqual(agent.repository_metadata(str(worktree))["kind"], "git")

    def test_hooks_are_atomic_owned_and_uninstall_does_not_remove_foreign_hook(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            hook = repo / ".git" / "hooks" / "post-commit"
            hook.write_text("#!/bin/sh\nprintf original\n")
            hook.chmod(0o755)
            agent.install_managed_git_hooks(str(repo), "https://example.test", "device-1")
            installed = hook.read_text()
            self.assertIn("printf original", installed)
            self.assertIn("TraceMini managed hook", installed)
            self.assertTrue(hook.stat().st_mode & 0o100)
            agent.uninstall_managed_git_hooks(str(repo))
            self.assertEqual(hook.read_text(), "#!/bin/sh\nprintf original\n")
            foreign = repo / ".git" / "hooks" / "post-merge"
            foreign.write_text("#!/bin/sh\nprintf foreign\n")
            agent.uninstall_managed_git_hooks(str(repo))
            self.assertTrue(foreign.exists())

    def test_approve_root_reloads_existing_config_and_preserves_bindings(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            state = Path(temporary) / "state"
            root = Path(temporary) / "approved"
            root.mkdir()
            config_path.write_text('{"endpoint":"https://example.test","device_token":"fad_x","agents":["codex"],"agent_commands":{"codex":["/usr/bin/true"]},"bindings":[{"root":"/tmp","binding_id":"b","binding_secret":"s"}]}')
            old_config, old_state = os.environ.get("FILES_AGENT_CONFIG"), os.environ.get("FILES_AGENT_STATE_DIR")
            os.environ["FILES_AGENT_CONFIG"], os.environ["FILES_AGENT_STATE_DIR"] = str(config_path), str(state)
            try:
                updated = agent.approve_discovery_root(str(root))
                self.assertIn(str(root), updated["discovery_roots"])
                self.assertEqual(updated["bindings"][0]["binding_id"], "b")
                self.assertEqual(agent.load_config()["discovery_roots"], [str(root)])
            finally:
                if old_config is None: os.environ.pop("FILES_AGENT_CONFIG", None)
                else: os.environ["FILES_AGENT_CONFIG"] = old_config
                if old_state is None: os.environ.pop("FILES_AGENT_STATE_DIR", None)
                else: os.environ["FILES_AGENT_STATE_DIR"] = old_state


if __name__ == "__main__":
    unittest.main()
