'use client';

import FilesAgentDownload from './FilesAgentDownload';

export default function DesktopCliConnection({ projectId }: { projectId?: string }) {
  return <FilesAgentDownload projectId={projectId} />;
}