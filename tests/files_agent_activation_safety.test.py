#!/usr/bin/env python3
"""Executable fresh Track and approved-root regression cases (no network/services)."""
import runpy
from pathlib import Path
from unittest.mock import patch
import unittest
import json
import subprocess

fixture = runpy.run_path(str(Path(__file__).with_name('files_agent_scan_contract.test.py')))
agent = fixture['agent']

class ActivationSafety(fixture['ScanContract']):
    def item(self):
        return {'kind': 'selection', 'work_id': '42', 'revision': 2,
                'claim_token': 'a'*32, 'desired_tracking': True,
                'repository_key': self.metadata['repository_key'],
                'fingerprint': agent.repository_fingerprint(str(self.repo)),
                'binding': {'binding_id': 'b'*43, 'binding_secret': 's'*43, 'root_hash': 'a'*64}}

    def activate(self, item, install=None):
        posts = []
        def post(url, config, body):
            posts.append(body)
            return {'work': [item]} if url.endswith('/work') else {'completed': True}
        config_path = self.state / 'config.json'
        with patch.object(agent, '_post_json', side_effect=post), patch.object(agent, 'paths', return_value=(config_path, self.state)), patch.object(agent, 'install_managed_git_hooks', side_effect=install):
            agent.poll_discovery_work(self.config, self.state)
        return posts[-1], config_path

    def test_fresh_track_persists_binding_before_hooks_and_history_is_metadata(self):
        item = self.item()
        def install(*args, **kwargs):
            saved = json.loads((self.state/'config.json').read_text())
            self.assertEqual(saved['bindings'][0]['binding_secret'], item['binding']['binding_secret'])
        completion, path = self.activate(item, install)
        self.assertTrue(completion['tracked'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        rows = agent.Queue(self.state/'queue.sqlite3').pending_trace(item['binding']['binding_id'])
        self.assertTrue(rows)
        event = rows[0]['payload']
        self.assertIsNone(event.get('agent'))
        self.assertIsNone(event.get('run_id'))
        self.assertEqual(set(event['provenance']), {'head_sha', 'files_changed', 'branch'})

    def test_missing_binding_never_reports_success(self):
        item = self.item(); item.pop('binding')
        completion, _ = self.activate(item)
        self.assertFalse(completion['tracked'])
        self.assertTrue(completion.get('error'))

    def test_hook_failure_never_reports_success(self):
        completion, _ = self.activate(self.item(), RuntimeError('hook installation rejected'))
        self.assertFalse(completion['tracked'])
        self.assertTrue(completion.get('error'))

    def test_custom_hooks_path_is_rejected_without_writes(self):
        destination = self.state/'custom-hooks'
        subprocess.run(['git', '-C', str(self.repo), 'config', 'core.hooksPath', str(destination)], check=True)
        with self.assertRaises(RuntimeError):
            agent.install_managed_git_hooks(str(self.repo), '', '')
        self.assertFalse(destination.exists())
        self.assertFalse((self.repo/'.git/hooks/post-commit').exists())

    def test_external_common_dir_is_rejected_without_writes(self):
        external = self.state/'external.git'
        subprocess.run(['git', 'clone', '--bare', '-q', str(self.repo), str(external)], check=True)
        linked = self.repo/'linked'
        subprocess.run(['git', '--git-dir', str(external), 'worktree', 'add', '-q', str(linked)], check=True)
        with self.assertRaises(RuntimeError):
            agent.install_managed_git_hooks(str(linked), '', '')
        self.assertFalse((external/'hooks/post-commit').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
