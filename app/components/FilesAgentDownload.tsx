'use client';

import { useEffect, useState } from 'react';

type FilesAgentDevice = {
  id: string;
  owner_email: string;
  device_label: string | null;
  hostname: string | null;
  platform: string | null;
  agent_version: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

export default function FilesAgentDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<FilesAgentDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [revokingId, setRevokingId] = useState('');

  async function refreshDevices() {
    setDevicesLoading(true);
    try {
      const response = await fetch('/api/files-agent/devices', { credentials: 'same-origin', cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not load devices');
      setDevices(Array.isArray(result.devices) ? result.devices : []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load devices');
    } finally {
      setDevicesLoading(false);
    }
  }

  useEffect(() => {
    void refreshDevices();
  }, []);

  async function download() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/files-agent/package', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/zip' },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Download failed');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'neodym-ai-files-tracker.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: FilesAgentDevice) {
    const label = device.device_label || device.hostname || `device ${device.id}`;
    if (!window.confirm(`Revoke ${label}? Its files-agent credential will stop working immediately.`)) return;
    setRevokingId(device.id);
    setError('');
    try {
      const response = await fetch(`/api/files-agent/devices/${encodeURIComponent(device.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Device revocation failed');
      setDevices((current) => current.map((item) => item.id === device.id ? result.device : item));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Device revocation failed');
    } finally {
      setRevokingId('');
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <span className="pill">Files only</span>
      <h2>AI files tracker</h2>
      <p className="muted">
        Reports file-change metadata only: path, action, time, and device. It does not collect file contents,
        screenshots, keyboard input, browser activity, clipboard data, or audio.
      </p>
      <button type="button" onClick={download} disabled={busy}>
        {busy ? 'Preparing secure download…' : 'Download AI files tracker'}
      </button>
      <p className="muted smallNote">The download contains a short-lived, one-time enrollment token tied to your signed-in account. Do not share the package.</p>

      <div style={{ marginTop: 20 }}>
        <h3>Enrolled files-agent devices</h3>
        <p className="muted smallNote">Revoke a lost or retired device to invalidate its credential immediately. Administrators can manage devices for their company.</p>
        {devicesLoading ? <p className="muted">Loading devices…</p> : devices.length === 0 ? <p className="muted">No files-agent devices enrolled.</p> : (
          <div style={{ display: 'grid', gap: 10 }}>
            {devices.map((device) => (
              <div key={device.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div><strong>{device.device_label || device.hostname || `Device ${device.id}`}</strong> <span className={device.revoked_at ? 'bad' : 'good'}>{device.revoked_at ? 'Revoked' : 'Active'}</span></div>
                <div className="muted smallNote">Owner: {device.owner_email} · {device.platform || 'Unknown platform'}{device.agent_version ? ` · v${device.agent_version}` : ''}</div>
                <div className="muted smallNote">Last seen: {new Date(device.last_seen_at).toLocaleString()}</div>
                {!device.revoked_at && (
                  <button type="button" onClick={() => revoke(device)} disabled={Boolean(revokingId)} style={{ marginTop: 8 }}>
                    {revokingId === device.id ? 'Revoking…' : 'Revoke device'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <p className="bad">{error}</p>}
    </section>
  );
}
