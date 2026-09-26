export default function NexusMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="3" opacity=".24" />
    <circle className="nexusMarkOuter" cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray="100 64" opacity=".7" />
    <circle className="nexusMarkInner" cx="32" cy="32" r="17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="79 28" />
    <circle cx="32" cy="32" r="3.5" fill="currentColor" />
  </svg>;
}
