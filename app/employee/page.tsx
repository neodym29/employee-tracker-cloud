export default function Employee() {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://<your-vercel-domain>';
  const script = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p ~/.config/employee-tracker
cat > ~/.config/employee-tracker/cloud.env <<'ENV'
EMPLOYEE_TRACKER_COMPANY_DOMAIN=neodym.ai
EMPLOYEE_TRACKER_EMPLOYEE_EMAIL=ibrahim@neodym.ai
EMPLOYEE_TRACKER_CLOUD_API=${base}/api/ingest
EMPLOYEE_TRACKER_INGEST_KEY=<set-by-admin>
ENV
# After the local tracker has cloud upload support enabled:
# python3 -m employee_tracker.cli run --cloud-env ~/.config/employee-tracker/cloud.env`;
  return (
    <section className="card">
      <span className="pill">Employee setup</span>
      <h1>Ibrahim PC enrollment</h1>
      <p className="muted">This is the device-connection piece: the installer writes the employee identity + cloud ingest endpoint, so events uploaded from Ibrahim’s PC are tied to ibrahim@neodym.ai.</p>
      <pre>{script}</pre>
      <p className="warn">Do not expose the real INGEST_API_KEY publicly. Put it into a private installer or one-time enrollment token.</p>
    </section>
  );
}
