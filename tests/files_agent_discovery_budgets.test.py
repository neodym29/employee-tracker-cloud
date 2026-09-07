#!/usr/bin/env python3
import runpy
from pathlib import Path
from unittest.mock import patch
import unittest

fixture = runpy.run_path(str(Path(__file__).with_name('files_agent_scan_contract.test.py')))
agent = fixture['agent']

class DiscoveryBudgets(fixture['ScanContract']):
    def test_no_recount_and_shared_directory_budget(self):
        with patch.object(agent.os, 'walk', side_effect=AssertionError('unbounded recount')), patch.object(agent.os, 'scandir', wraps=agent.os.scandir) as scan:
            result = agent.discover_approved_roots([str(self.state), str(self.repo)], max_directories=1)
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(result, [])
        self.assertTrue(result.partial)

    def test_wide_directory_entries_are_bounded(self):
        for i in range(20):
            (self.state / str(i)).touch()
        result = agent.discover_approved_roots([str(self.state)], max_entries=3)
        self.assertEqual(result.entries, 3)
        self.assertTrue(result.partial)

    def test_deadline_stops_inside_a_wide_directory(self):
        for i in range(20):
            (self.state / str(i)).touch()
        ticks = iter(i / 10 for i in range(100))
        with patch.object(agent.time, 'monotonic', side_effect=lambda: next(ticks)):
            result = agent.discover_approved_roots([str(self.state), str(self.repo)], timeout_seconds=0.5)
        self.assertTrue(result.partial)
        self.assertLess(result.entries, 20)
        self.assertEqual(result.directories, 1)

    def test_discovery_time_does_not_silently_erase_candidates(self):
        clock = [0.0]
        def discover(*args, **kwargs):
            clock[0] = 6.0
            return [str(self.repo)]
        with patch.object(agent, 'discover_approved_roots', side_effect=discover), patch.object(agent.time, 'monotonic', side_effect=lambda: clock[0]):
            posts = self.poll({'work_id':'41','kind':'scan','claim_token':'lease'})
        self.assertTrue(posts[0][1]['repositories'] or posts[1][1]['error'], 'not successful zero after discovery deadline')

    def test_partial_discovery_is_explicit_in_completion(self):
        class Partial(list):
            partial = True
        with patch.object(agent, 'discover_approved_roots', return_value=Partial([str(self.repo)])):
            posts = self.poll({'work_id':'41','kind':'scan','claim_token':'lease'})
        self.assertEqual(posts[1][1]['count'], 1)
        self.assertIn('partial', posts[1][1]['error'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
