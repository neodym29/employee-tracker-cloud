export default function NexusMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="16" fill="#201C35" />
    <circle cx="32" cy="32" r="22" stroke="#7468BD" strokeWidth="3" opacity=".72" />
    <path d="M12 23a22 22 0 0 1 40 0" stroke="#B9A9FF" strokeWidth="4" strokeLinecap="round" />
    <path d="M22 24a13 13 0 1 1-1 16" stroke="#FAF8FF" strokeWidth="5" strokeLinecap="round" />
    <circle cx="32" cy="32" r="6" fill="#7BE3D4" />
  </svg>;
}
