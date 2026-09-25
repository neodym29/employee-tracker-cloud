import { requireApprovedSession } from '@/lib/auth';
import { readEmployeeDailyDashboard } from '@/lib/employee-daily-dashboard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function day(value: string | null) {
  if (!value) return 'No updates yet';
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'Asia/Karachi' }).format(date);
}

export default async function ProjectUpdatesPage() {
  const session = await requireApprovedSession();
  let data = null;
  let error = '';
  try { data = await readEmployeeDailyDashboard(session); }
  catch { error = 'Project updates could not be loaded. Please try again.'; }

  return <div className="dashboardShell statusDashboardShell projectUpdatesDashboard">
    <section className="dashboardHeading projectUpdatesHeading">
      <div>
        <div className="eyebrow"><span className="liveDot" /> Daily report</div>
        <h1>Project updates</h1>
        <p>Plain-language changes reported by each project&apos;s connected Codex plugin.</p>
      </div>
      <div className="summaryDay"><span>Latest update</span><strong>{day(data?.latestSummaryDate ?? null)}</strong></div>
    </section>
    {error && <div className="errorBanner" role="alert">{error}</div>}
    {data && (data.projects.length || data.otherWork) ? <section className="projectUpdatesReport" aria-label="Latest project changes">
      {data.projects.map((project) => <article className="projectUpdateSection" key={project.id}>
        <header>
          <a href={`/projects/${project.id}`}>{project.title}</a>
          <time dateTime={project.date}>{day(project.date)}</time>
        </header>
        <ul>
          {project.updates.map((update) => <li key={update.id}>
            {update.summary}
          </li>)}
        </ul>
      </article>)}
      {data.otherWork && <article className="projectUpdateSection otherWorkSection">
        <header><h2>Other work</h2><time dateTime={data.otherWork.date}>{day(data.otherWork.date)}</time></header>
        <ul>{data.otherWork.updates.map((update) => <li key={update.id}>{update.summary}</li>)}</ul>
      </article>}
    </section> : !error && <section className="dashboardPanel projectUpdatesEmpty">
      <h2>No project changes yet</h2>
      <p>Updates will appear here as simple bullets after a connected Codex plugin reports meaningful work.</p>
    </section>}
    <p className="projectUpdatesNote">Only plain-language updates intentionally reported by the Codex plugin appear here.</p>
  </div>;
}
