#!/usr/bin/env python3
"""Regression fixtures mirror claimDeviceWork in lib/tracemini-discovery.ts."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('scan_contract_agent', Path(__file__).resolve().parents[1] / 'files-agent/files_agent.py')
assert SPEC is not None and SPEC.loader is not None
agent = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent
SPEC.loader.exec_module(agent)
BASE = 'https://work.example/api/files-agent'
SHA = 'a' * 40


def server_fingerprint(fp):
    # fingerprint() canonicalization and safe-integer validation, not a CLI-shaped fixture.
    assert set(fp) <= {'device_id', 'device', 'inode', 'birthtime_ns', 'birthtime', 'git_device', 'git_inode'}
    result = {'device_id': fp.get('device_id', fp.get('device'))}
    for source, target in [('inode', 'inode'), ('birthtime_ns', 'birthtime_ns'), ('birthtime', 'birthtime_ns'), ('git_device', 'git_device'), ('git_inode', 'git_inode')]:
        if source in fp:
            assert type(fp[source]) is int and 0 <= fp[source] <= 2**53 - 1
            result[target] = fp[source]
    return json.loads(json.dumps(result))


class ScanContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'fixture'], check=True)
        self.state = Path(self.tmp.name) / 'state'
        self.state.mkdir()
        self.config = {'endpoint': BASE + '/ingest', 'discovery_roots': [str(self.repo)]}
        self.metadata = agent.repository_metadata(str(self.repo))

    def poll(self, item):
        posts = []
        def post(url, config, body):
            posts.append((url, json.loads(json.dumps(body))))
            return {'work': [item]} if url == BASE + '/work' else {'ok': True}
        with patch.object(agent, '_post_json', side_effect=post), patch.object(agent, '_atomic_json_write'), patch.object(agent, 'install_managed_git_hooks'), patch.object(agent, 'uninstall_managed_git_hooks'), patch.object(agent, '_verified_push', return_value=True):
            agent.poll_discovery_work(self.config, self.state)
        self.assertEqual(posts[0][0], BASE + '/work')
        return posts[1:]

    def test_scan_urls_identity_and_null_optional_shas(self):
        posts = self.poll({'work_id': '41', 'kind': 'scan', 'claim_token': 'scan-lease'})
        self.assertEqual(posts[0][0], BASE + '/repository-candidates')
        self.assertEqual(posts[0][1]['scan_id'], '41')
        self.assertEqual(posts[0][1]['claim_token'], 'scan-lease')
        repo = posts[0][1]['repositories'][0]
        self.assertIsNone(repo['upstream_head_sha'])
        self.assertIsNone(repo['remote_branch_sha'])
        self.assertEqual(repo['fingerprint'], server_fingerprint(repo['fingerprint']))
        self.assertEqual(posts[1], (BASE + '/scans/41/complete', {'kind': 'scan', 'work_id': '41', 'claim_token': 'scan-lease', 'count': 1, 'error': None}))

    def test_metadata_optional_shas_are_null(self):
        self.assertIsNone(self.metadata['provenance']['upstream_head_sha'])
        self.assertIsNone(self.metadata['provenance']['remote_branch_sha'])

    def test_fingerprint_roundtrip(self):
        fp = agent.repository_fingerprint(str(self.repo))
        self.assertEqual(fp, server_fingerprint(fp))

    def test_birthtime_nanoseconds_never_exceed_server_safe_integer(self):
        stat = SimpleNamespace(st_mode=0o40755, st_dev=1, st_ino=2, st_birthtime_ns=1700000000000000000)
        with patch.object(agent, 'git_common_dir', return_value=str(self.repo / '.git')), patch.object(agent.os, 'stat', return_value=stat):
            fp = agent.repository_fingerprint(str(self.repo))
        self.assertEqual(fp, server_fingerprint(fp))

    def test_selection_roundtrip_start_and_stop(self):
        fp = server_fingerprint(agent.repository_fingerprint(str(self.repo)))
        for desired in (True, False):
            with self.subTest(desired=desired):
                item = {'work_id': '42', 'kind': 'selection', 'revision': 7, 'desired_tracking': desired, 'claim_token': 'selection-lease', 'repository_key': self.metadata['repository_key'], 'fingerprint': fp}
                item['binding'] = {'binding_id': 'binding', 'binding_secret': 'secret', 'root_hash': 'a'*64}
                # A bound history import must serialize the object fingerprint, not concatenate it.
                with patch.object(agent, 'select_binding', return_value={'binding_id': 'binding'}), patch.object(agent, 'Queue') as queue:
                    posts = self.poll(item)
                    if desired:
                        queue.return_value.enqueue_trace.assert_called_once()
                self.assertEqual(posts, [(BASE + '/repository-selections/42/complete', {'kind': 'selection', 'work_id': '42', 'claim_token': 'selection-lease', 'revision': 7, 'tracked': desired})])
                self.assertEqual(bool(self.config.get('clones')), desired)

    def test_push_roundtrip(self):
        item = {'work_id': '43', 'kind': 'push', 'candidate_id': '42', 'expected_head_sha': SHA, 'branch': 'main', 'claim_token': 'push-lease', 'occurred_at': '2020-01-01T00:00:00.000Z', 'repository_key': self.metadata['repository_key'], 'fingerprint': server_fingerprint(agent.repository_fingerprint(str(self.repo)))}
        item['branch'] = 'refs/heads/main'
        completion = {'kind': 'push', 'work_id': '43', 'claim_token': 'push-lease', 'status': 'pending', 'expected_head_sha': SHA, 'branch': item['branch']}
        # Unknown destinations must remain pending even if remote verification is mocked true.
        self.assertEqual(self.poll(item), [(BASE + '/pushes/43/complete', completion)])
        queue = agent.Queue(self.state / 'queue.sqlite3')
        agent.queue_push(queue, 'binding', {**item, 'remote_url': 'https://example.com/Fork.git'})
        self.config['bindings'] = [{'binding_id': 'binding'}]
        with patch.object(agent, '_post_json', return_value={'pushId': '43'}):
            self.assertEqual(agent.flush_pushes(self.config, self.state), 1)
        self.assertEqual(agent.push_destination(self.state, item), 'https://example.com/Fork.git')
        self.assertEqual(self.poll(item), [(BASE + '/pushes/43/complete', {**completion, 'status': 'verified'})])
        self.assertEqual(self.poll({**item, 'branch': 'refs/heads/other'}),
                         [(BASE + '/pushes/43/complete', {**completion, 'branch': 'refs/heads/other'})])


if __name__ == '__main__':
    unittest.main(verbosity=2)
