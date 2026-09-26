export type EngineerUpdatesGroup = {
  id: string;
  name: string;
  projects: Array<{ id: string; title: string }>;
  updates: Array<{
    id: string;
    projectId: string;
    projectTitle: string;
    summary: string;
    occurredAt: string;
    importedHistory: boolean;
  }>;
};

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export default function EngineerUpdates({ groups, projectScoped = false }: { groups: EngineerUpdatesGroup[]; projectScoped?: boolean }) {
  return <section className={`engineerUpdates ${projectScoped ? 'projectScoped' : ''}`} aria-labelledby={projectScoped ? 'project-engineer-updates-title' : 'engineer-updates-title'}>
    <header className="engineerUpdatesHeader">
      <div><span className="sectionLabel">Team activity</span><h2 id={projectScoped ? 'project-engineer-updates-title' : 'engineer-updates-title'}>Engineer updates</h2></div>
      <p>{projectScoped ? 'Recent work recorded for this project, grouped by engineer.' : 'Recent work across your projects, grouped by engineer.'}</p>
    </header>
    {groups.length ? <div className="engineerUpdatesGrid">{groups.map((group) => <article className="engineerUpdateCard" key={group.id}>
      <div className="engineerUpdateIdentity"><span aria-hidden="true">{group.name.trim().charAt(0).toUpperCase() || 'E'}</span><div><h3>{group.name}</h3><p>{group.projects.length} project{group.projects.length === 1 ? '' : 's'}</p></div></div>
      {group.updates.length ? <ol>{group.updates.map((update) => <li key={update.id}>
        {!projectScoped && <a href={`/projects/${update.projectId}`}>{update.projectTitle}</a>}
        <p>{update.summary}</p>
        <div><time dateTime={update.occurredAt}>{dateLabel(update.occurredAt)}</time>{update.importedHistory && <span>Earlier history</span>}</div>
      </li>)}</ol> : <div className="engineerUpdatesEmpty"><p>No recorded changes yet.</p><div>{group.projects.map((project) => <a key={project.id} href={`/projects/${project.id}`}>{project.title}</a>)}</div></div>}
    </article>)}</div> : <div className="engineerUpdatesEmpty"><p>No engineers are connected to these projects yet.</p></div>}
    <p className="engineerUpdatesNote">Grouped by the engineer whose connected Neo Nexus device reported the work.</p>
  </section>;
}
