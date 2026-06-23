from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from employee_tracker.cloud import CloudUploader, CloudSettings
from employee_tracker.db import (
    cloud_queue_stats,
    connect,
    enqueue_cloud_payload,
    fetch_cloud_queue_batch,
    init_db,
    insert_resource_usage_snapshot,
)
from employee_tracker.resources import collect_resource_usage


class CloudBackpressureTests(unittest.TestCase):
    def test_cloud_queue_drains_only_configured_batch_size(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            init_db(db_path)
            uploaded: list[dict] = []
            with connect(db_path) as connection:
                for index in range(5):
                    enqueue_cloud_payload(connection, {'captured_at': f'2026-06-22T00:00:0{index}+00:00', 'event_type': 'activity_snapshot', 'index': index})
                uploader = CloudUploader(CloudSettings(
                    api_url='https://example.invalid/api/ingest',
                    token='token',
                    employee_email='employee@example.com',
                    company_domain='example.com',
                    device_key='employee@example.com:host:user',
                    upload_interval_seconds=1,
                    max_queue_batch_size=2,
                    queue_drain_pause_seconds=0.0,
                    max_queue_rows=100,
                    max_queue_bytes=10_000_000,
                ))
                uploader.upload_activity = lambda payload: uploaded.append(payload) or True  # type: ignore[method-assign]

                result = uploader.drain_queue(connection)

                self.assertEqual(result.uploaded, 2)
                self.assertEqual([payload['index'] for payload in uploaded], [0, 1])
                self.assertEqual(cloud_queue_stats(connection)['pending_count'], 3)
                remaining = [json.loads(row['payload_json'])['index'] for row in fetch_cloud_queue_batch(connection, limit=10)]
                self.assertEqual(remaining, [2, 3, 4])

    def test_cloud_queue_prunes_oldest_when_backlog_exceeds_row_cap(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            init_db(db_path)
            with connect(db_path) as connection:
                for index in range(5):
                    enqueue_cloud_payload(
                        connection,
                        {'captured_at': f'2026-06-22T00:00:0{index}+00:00', 'event_type': 'activity_snapshot', 'index': index},
                        max_rows=3,
                    )

                stats = cloud_queue_stats(connection)
                remaining = [json.loads(row['payload_json'])['index'] for row in fetch_cloud_queue_batch(connection, limit=10)]

                self.assertEqual(stats['pending_count'], 3)
                self.assertEqual(remaining, [2, 3, 4])
                self.assertEqual(stats['dropped_count'], 2)

    def test_resource_usage_datapoint_contains_memory_cpu_and_backlog(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            init_db(db_path)
            with connect(db_path) as connection:
                enqueue_cloud_payload(connection, {'captured_at': '2026-06-22T00:00:00+00:00', 'event_type': 'activity_snapshot'})
                usage = collect_resource_usage(connection, username='jerry', host='test-host')
                insert_resource_usage_snapshot(connection, usage)
                rows = connection.execute('select * from resource_usage_snapshots').fetchall()

                self.assertEqual(len(rows), 1)
                row = dict(rows[0])
                self.assertGreater(row['process_rss_bytes'], 0)
                self.assertGreaterEqual(row['cloud_queue_pending_count'], 1)
                self.assertIn('process_cpu_seconds', row)
                self.assertEqual(row['event_type'], 'tracker_resource_usage')


if __name__ == '__main__':
    unittest.main()
