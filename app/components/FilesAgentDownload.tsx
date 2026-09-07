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

type Props = { projectId?: string };
type FolderBinding = { code: string; expiresAt: string; rootLabel: string };

export default function FilesAgentDownload({ projectId }: Props = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<FilesAgentDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [revokingId, setRevokingId] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [rootLabel, setRootLabel] = useState('');
  const [binding, setBinding] = useState<FolderBinding | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);

  async function refreshDevices() {
    setDevicesLoading(true);
    try {
      const response = await fetch('/api/files-agent/devices', { credentials: 'same-origin', cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not load devices');
      const nextDevices: FilesAgentDevice[] = Array.isArray(result.devices) ? result.devices : [];
      setDevices(nextDevices);
      setSelectedDeviceId((current) => current || nextDevices.find((device) => !device.revoked_at)?.id || '');
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

  async function createFolderBinding(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    setBindingBusy(true);
    setBinding(null);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/tracemini/roots`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ device_id: selectedDeviceId, root_label: rootLabel }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'Folder connection could not be prepared');
      setBinding(result.binding);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Folder connection could not be prepared');
    } finally {
      setBindingBusy(false);
    }
  }

  return (
    <section className={projectId ? 'dashboardPanel desktopCliPanel' : 'card desktopCliPanel'} style={{ marginTop: 16 }}>
      <span className="pill">Desktop connection</span>
      <h2>Connect the Trace desktop CLI</h2>
      <p className="muted">
        Install the CLI on your computer, connect an approved project folder, then run Codex, Claude, or Hermes
        through it. Trace records file changes made by that approved AI CLI process tree only. It reports
        file-change metadata only and does not collect file contents, screenshots, input, browser activity,
        clipboard data, audio, or unrelated operating-system files.
      </p>
      <ol className="cliSteps">
        <li><strong>Download and install</strong><code>unzip neodym-ai-files-tracker.zip &amp;&amp; bash files-agent/install.sh</code></li>
        <li><strong>Connect a project folder</strong><span>{projectId ? 'Choose an enrolled device below and generate its one-time folder command.' : 'Create or open a project, then connect its exact local folder from the project workspace.'}</span></li>
        <li><strong>Run an approved AI CLI</strong><code>files-agent exec --agent codex -- codex</code></li>
      </ol>
      <button type="button" aria-label="Download AI files tracker" onClick={download} disabled={busy}>
        {busy ? 'Preparing secure download…' : 'Download Trace desktop CLI'}
      </button>
      <p className="muted smallNote">The download contains a short-lived, one-time enrollment token tied to your signed-in account. Do not share the package.</p>

      {projectId && <div className="folderConnection">
        <h3>Connect this project folder</h3>
        {devices.some((device) => !device.revoked_at) ? <form onSubmit={createFolderBinding}>
          <label>Enrolled device<select required value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>{devices.filter((device) => !device.revoked_at).map((device) => <option key={device.id} value={device.id}>{device.device_label || device.hostname || `Device ${device.id}`}</option>)}</select></label>
          <label>Folder label<input required maxLength={160} value={rootLabel} onChange={(event) => setRootLabel(event.target.value)} placeholder="Project name, not a filesystem path" /></label>
          <button disabled={bindingBusy || !selectedDeviceId || !rootLabel.trim()}>{bindingBusy ? 'Preparing command…' : 'Generate folder connection command'}</button>
        </form> : <p className="muted">Install and enroll the desktop CLI first. This page will then show your device here.</p>}
        {binding && <div className="bindingCommand" role="status">
          <strong>Run this once on {devices.find((device) => device.id === selectedDeviceId)?.device_label || 'the selected device'}:</strong>
          <code>files-agent bind --code {binding.code} --root /absolute/path/to/project</code>
          <p className="muted smallNote">Replace the example path with the exact local project folder. The one-time command expires at {new Date(binding.expiresAt).toLocaleString()}.</p>
        </div>}
      </div>}

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
      {error && <p className="bad" role="alert">{error}</p>}
    </section>
  );
}
