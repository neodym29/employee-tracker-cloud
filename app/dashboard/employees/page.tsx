import { redirect } from 'next/navigation';

export default function LegacyEmployeeDashboardPage() {
  redirect('/dashboard/projects');
}
