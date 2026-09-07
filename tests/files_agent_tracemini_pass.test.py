import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = ROOT / "files-agent" / "files_agent.py"


def load_module():
    spec = importlib.util.spec_from_file_location("files_agent_tracemini_pass", PAYLOAD)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TraceMiniCorrectionPass(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_module()

    def git_repo(self, path: Path, initial="one"):
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        for key, value in (("user.email", "test@example.invalid"), ("user.name", "Test")):
            subprocess.run(["git", "-C", str(path), "config", key, value], check=True)
        (path / "file").write_text(initial)
        subprocess.run(["git", "-C", str(path), "add", "file"], check=True)
        subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)

    def test_worktree_git_file_is_discovered_without_following_links(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "root"
            root.mkdir()
            main = root / "main"
            worktree = root / "worktree"
            self.git_repo(main)
            subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "feature", str(worktree)], check=True)
            self.assertIn(os.path.realpath(worktree), self.m.discover_repositories(str(root)))

    def test_global_limits_are_shared_across_all_approved_roots(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            roots = []
            for name in ("one", "two"):
                root = base / name
                root.mkdir()
                self.git_repo(root / "repo")
                roots.append(str(root))
            found = self.m.discover_approved_roots(roots, max_repositories=1, max_directories=100)
            self.assertEqual(len(found), 1)

    def test_managed_hook_preserves_original_and_restores_only_owned_wrapper(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            self.git_repo(repo)
            hooks = repo / ".git" / "hooks"
            original = hooks / "post-commit"
            original.write_text("#!/bin/sh\nprintf '%s:%s' \"$1\" \"$(cat)\" > hook-output\n")
            original.chmod(0o700)
            executable = str(Path(__file__).resolve().parents[1] / "files-agent" / "files_agent.py")
            self.m.install_managed_git_hooks(str(repo), "", "device", executable=executable)
            wrapper = original.read_text()
            self.assertTrue((hooks / "post-commit.tracemini-original").exists())
            self.assertTrue((hooks / "post-commit.tracemini-owner").exists())
            self.assertIn(executable, wrapper)
            self.assertIn("--type commit", wrapper)
            self.m.uninstall_managed_git_hooks(str(repo))
            self.assertEqual(original.read_text(), "#!/bin/sh\nprintf '%s:%s' \"$1\" \"$(cat)\" > hook-output\n")

    def test_work_completion_payload_echoes_claim_token_revision_and_desired_state(self):
        payload = self.m.work_completion_payload(
            "scan", "scan-1", "claim-1", 7, True, count=3, error=None
        )
        self.assertEqual(payload, {
            "kind": "scan", "work_id": "scan-1", "claim_token": "claim-1",
            "count": 3, "error": None,
        })
        for tracked in (True, False):
            with self.subTest(tracked=tracked):
                self.assertEqual(self.m.work_completion_payload(
                    "selection", "42", "selection-claim", 7, tracked
                ), {
                    "kind": "selection", "work_id": "42",
                    "claim_token": "selection-claim", "revision": 7,
                    "tracked": tracked,
                })

    def test_hook_executes_existing_hook_first_with_args_stdin_and_status(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            self.git_repo(repo)
            hook = repo / ".git" / "hooks" / "post-commit"
            hook.write_text("#!/bin/sh\ncat > hook-stdin\nprintf '%s:%s' \"$1\" \"$2\" > hook-args\nexit 7\n")
            hook.chmod(0o700)
            self.m.install_managed_git_hooks(str(repo), "", "device", executable=str(PAYLOAD))
            result = subprocess.run([str(hook), "first", "second"], cwd=repo, input="hook input\n", text=True)
            self.assertEqual(result.returncode, 7)
            self.assertEqual((repo / "hook-stdin").read_text(), "hook input\n")
            self.assertEqual((repo / "hook-args").read_text(), "first:second")


if __name__ == "__main__":
    unittest.main()
