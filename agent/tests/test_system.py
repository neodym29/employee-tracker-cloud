from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from employee_tracker.system import (
    OpenWindowInfo,
    ProcessInfo,
    diff_process_maps,
    process_map_by_pid,
    read_process_info,
    summarize_current_open_state,
    summarize_warp_activity,
)
from employee_tracker.workspace import scan_workspace


class ProcessSystemTests(unittest.TestCase):
    def test_read_process_info_from_fake_proc_directory(self) -> None:
        with TemporaryDirectory() as tmp:
            pid_dir = Path(tmp) / '4321'
            pid_dir.mkdir()
            (pid_dir / 'stat').write_text(
                '4321 (python3) R 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345 0 0\n',
                encoding='utf-8',
            )
            (pid_dir / 'cmdline').write_bytes(b'python3\x00worker.py\x00--sync\x00')
            (pid_dir / 'comm').write_text('python3\n', encoding='utf-8')
            (pid_dir / 'status').write_text('Name:\tpython3\nUid:\t0\t0\t0\t0\n', encoding='utf-8')

            exe_target = Path(tmp) / 'python3'
            exe_target.write_text('', encoding='utf-8')
            cwd_target = Path(tmp) / 'repo'
            cwd_target.mkdir()
            (pid_dir / 'exe').symlink_to(exe_target)
            (pid_dir / 'cwd').symlink_to(cwd_target)

            process = read_process_info(pid_dir)

        self.assertIsNotNone(process)
        assert process is not None
        self.assertEqual(process.pid, 4321)
        self.assertEqual(process.ppid, 100)
        self.assertEqual(process.process_name, 'python3')
        self.assertEqual(process.command_line, 'python3 worker.py --sync')
        self.assertEqual(process.state, 'R')
        self.assertEqual(process.start_time_ticks, 12345)
        self.assertEqual(process.uid, 0)
        self.assertEqual(process.exe_path, str(exe_target))
        self.assertEqual(process.cwd, str(cwd_target))

    def test_diff_process_maps_detects_started_exited_and_pid_reuse(self) -> None:
        previous = process_map_by_pid(
            [
                ProcessInfo(1, 0, 'init', '/sbin/init', '/', 'init', 'S', 0, 'root', 100),
                ProcessInfo(5, 1, 'bash', '/usr/bin/bash', '/tmp', 'bash', 'S', 1000, 'jerry', 200),
            ]
        )
        current = process_map_by_pid(
            [
                ProcessInfo(1, 0, 'init', '/sbin/init', '/', 'init', 'S', 0, 'root', 100),
                ProcessInfo(5, 1, 'python', '/usr/bin/python3', '/tmp', 'python app.py', 'R', 1000, 'jerry', 999),
                ProcessInfo(7, 1, 'ssh', '/usr/bin/ssh', '/home/jerry', 'ssh server', 'S', 1000, 'jerry', 300),
            ]
        )

        started, exited = diff_process_maps(previous, current)

        self.assertEqual([process.pid for process in started], [5, 7])
        self.assertEqual([process.pid for process in exited], [5])

    def test_summarize_warp_activity_prefers_interesting_child_command(self) -> None:
        processes = [
            ProcessInfo(100, 1, 'warp-terminal', '/usr/bin/warp-terminal', '/home/jerry', '/usr/bin/warp-terminal', 'S', 1000, 'jerry', 1),
            ProcessInfo(101, 100, 'warp', '/opt/warpdotdev/warp-terminal/warp', '/home/jerry', 'warp terminal-server --parent-pid=100', 'S', 1000, 'jerry', 2),
            ProcessInfo(102, 101, 'bash', '/usr/bin/bash', '/home/jerry', 'bash --rcfile /dev/fd/63', 'S', 1000, 'jerry', 3),
            ProcessInfo(103, 102, 'python3', '/usr/bin/python3', '/home/jerry/project', 'python3 run_tracker.py', 'R', 1000, 'jerry', 4),
        ]
        windows = [
            OpenWindowInfo(
                window_id='0xc00005',
                title='Warp',
                pid=100,
                app_name='warp-terminal',
                wm_class='dev.warp.Warp/dev.warp.Warp',
                is_active=True,
            )
        ]

        summaries = summarize_warp_activity(processes, windows)

        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0].warp_pid, 100)
        self.assertEqual(summaries[0].shell_pid, 102)
        self.assertEqual(summaries[0].observed_pid, 103)
        self.assertEqual(summaries[0].observed_process_name, 'python3')
        self.assertEqual(summaries[0].observed_command_line, 'python3 run_tracker.py')


    def test_summarize_current_open_state_recognizes_common_browser_workarounds(self) -> None:
        processes = [
            ProcessInfo(200, 1, 'firefox', '/usr/bin/firefox', '/home/jerry', 'firefox', 'S', 1000, 'jerry', 1),
            ProcessInfo(201, 200, 'firefox', '/usr/bin/firefox', '/home/jerry', 'firefox -contentproc', 'S', 1000, 'jerry', 2),
            ProcessInfo(300, 1, 'opera', '/usr/bin/opera', '/home/jerry', '/usr/bin/opera', 'S', 1000, 'jerry', 3),
            ProcessInfo(301, 300, 'opera', '/usr/bin/opera', '/home/jerry', '/usr/bin/opera --type=renderer', 'S', 1000, 'jerry', 4),
        ]

        apps, subwindows = summarize_current_open_state(processes, [])

        self.assertEqual({app.app_key for app in apps}, {'firefox', 'opera'})
        self.assertEqual({app.app_name for app in apps}, {'Firefox', 'Opera'})
        self.assertEqual(subwindows, [])


if __name__ == '__main__':
    unittest.main()
