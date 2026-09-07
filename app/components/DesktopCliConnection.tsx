'use client';
import TraceNodeInstall from './trace-node/Install';
import Discovery from './trace-node/Discovery';
// Account discovery is not a dummy project and is separate from the Python collector.
export default function DesktopCliConnection({ projectId: _projectId }: { projectId?: string }) {
  return <><TraceNodeInstall /><Discovery /></>;
}
