import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('parity_agent', Path(__file__).parents[1] / 'files-agent/files_agent.py')
a = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = a
spec.loader.exec_module(a)

class ParityPipeline(unittest.TestCase):
    def test_git_payload_is_narrow_and_unattributed(self):
        metadata = {'repository_key': 'github.com/acme/repo', 'provenance': {
            'branch': 'main', 'head_sha': 'a'*40, 'index_digest': 'secret',
            'upstream_head_sha': None, 'parent_count': 1}}
        event = a.git_hook_record('commit', metadata)
        self.assertNotIn('agent', event)
        self.assertNotIn('run_id', event)
        self.assertEqual(set(event['provenance']), {'branch', 'head_sha'})

    def test_run_id_shared_with_trace(self):
        with tempfile.TemporaryDirectory() as d:
            q = a.Queue(Path(d)/'q.sqlite3')
            with patch.object(a, 'select_binding', return_value={'binding_id':'b'}), patch.object(a, 'repository_metadata', return_value={'kind':'non_git','repository_key':None}):
                a.enqueue_tracemini(q, {}, d, 'codex', [], run_id='a'*32)
            self.assertEqual(q.pending_trace('b')[0]['payload']['run_id'], 'a'*32)

    def test_offline_hook_outbox_survives_restart_and_sanitizes(self):
        import io
        import json
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            metadata = {'kind':'git','repository_key':'github.com/acme/repo','provenance':{}}
            config = {'bindings':[{'binding_id':'b'}], 'endpoint':'https://example.com/api/files-agent/ingest'}
            with patch.object(a, 'paths', return_value=(state/'config.json',state)), patch.object(a, 'load_config', return_value=config), patch.object(a, 'repository_metadata', return_value=metadata), patch.object(a, 'repository_fingerprint', return_value={'inode':1}), patch.object(a, 'select_binding', return_value={'binding_id':'b'}), patch.object(a.sys, 'stdin', io.StringIO('refs/heads/main '+ 'a'*40 +' refs/heads/release '+ '0'*40 +'\n')), patch.object(a, '_post_json', side_effect=AssertionError('hook must not use HTTP')):
                self.assertEqual(a.main(['hook-event','--hook','pre-push','--root',d,'--','fork','https://user:SECRET@example.com:8443/Case/Repo.git?token=PRIVATE#x']), 0)
            q = a.Queue(state/'queue.sqlite3')
            self.assertEqual(q.trace_count(), 0)
            with q._connection() as db:
                rows = db.execute('SELECT * FROM push_outbox').fetchall()
                self.assertEqual(len(rows), 1)
                self.assertNotIn('SECRET', rows[0]['payload'])
                self.assertNotIn('PRIVATE', rows[0]['payload'])
                payload = json.loads(rows[0]['payload'])
                self.assertEqual(payload['remote_url'], 'https://example.com:8443/Case/Repo.git')
            with patch.object(a, '_post_json', side_effect=RuntimeError('offline')):
                with self.assertRaises(RuntimeError): a.flush_pushes(config,state)
            with patch.object(a, '_post_json', return_value={'pushId':'17'}) as post:
                self.assertEqual(a.flush_pushes(config,state),1)
                self.assertEqual(post.call_args.args[2]['branch'],'refs/heads/release')
            item = {**payload,'work_id':'17'}
            self.assertEqual(a.push_destination(state,item),payload['remote_url'])
            self.assertIsNone(a.push_destination(state,{**item,'branch':'refs/heads/main'}))
            self.assertIsNone(a.push_destination(state,{**item,'work_id':'18'}))

    def test_reconcile_real_git_missed_commit_stage_and_dedupe(self):
        import subprocess
        import json
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)/'state'; state.mkdir()
            root = Path(d)/'repo'; root.mkdir()
            def git(*args):
                return subprocess.check_output(['git','-C',str(root),*args],text=True,stderr=subprocess.DEVNULL).strip()
            git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test')
            git('remote','add','origin','https://example.com/repo.git')
            (root/'file').write_text('one')
            git('add','.'); git('commit','-m','first')
            fp = a.repository_fingerprint(str(root))
            config = {'discovery_roots':[str(root)], 'bindings':[{'binding_id':'b','root':str(root)}], 'clones':[{'path':str(root),'fingerprint':fp,'repository_key':'example.com/repo','binding_id':'b','history_heads':a._history_heads(str(root)),'index_mtime':a._index_mtime(str(root))}]}
            self.assertEqual(a.reconcile_tracked_clones(config,state),0)
            (root/'file').write_text('two'); git('add','.'); git('commit','-m','missed')
            self.assertEqual(a.reconcile_tracked_clones(config,state),1)
            q = a.Queue(state/'queue.sqlite3')
            event = q.pending_trace('b')[0]['payload']
            self.assertEqual(event['action'],'commit_history')
            self.assertNotIn('agent',event)
            q.ack_trace(q.pending_trace('b'))
            self.assertEqual(a.reconcile_tracked_clones(config,state),0)
            (root/'file').write_text('three'); git('add','.')
            self.assertEqual(a.reconcile_tracked_clones(config,state),0)
            with q._connection() as db:
                payload = json.loads(db.execute('SELECT payload FROM reconcile_state').fetchone()[0])
                payload['pending_index']['at'] -= 3
                db.execute('UPDATE reconcile_state SET payload=?',(json.dumps(payload),))
            self.assertEqual(a.reconcile_tracked_clones(config,state),1)
            self.assertEqual(q.pending_trace('b')[0]['payload']['kind'],'stage')
            config['clones'][0]['fingerprint'] = {'inode':0}
            self.assertEqual(a.reconcile_tracked_clones(config,state),0)

    def test_exact_destination_ref(self):
        metadata={'kind':'git','repository_key':'github.com/acme/repo','provenance':{}}
        with patch.object(a.subprocess, 'check_output', return_value='a'*40+'\trefs/heads/main\n') as call:
            self.assertTrue(a._verified_push('/tmp', metadata, 'refs/heads/main', 'a'*40, 'https://example.com/Fork.git'))
            self.assertIn('https://example.com/Fork.git', call.call_args.args[0])
            self.assertIn('refs/heads/main', call.call_args.args[0])

if __name__ == '__main__':
    unittest.main()
