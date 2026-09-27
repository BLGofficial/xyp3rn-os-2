import { catalogLoaders, runtime } from '../../lib/server';
import { TaskForm, Tasks } from '../catalog-ui';
import { ErrorBanner, first } from '../ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['open', 'done', 'cancelled'] as const;

// Tasks (AOS-02 B2): each move is an event, so a task's history is kept; the list shows the latest.
export default async function TasksPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const status = STATUSES.find((s) => s === first(searchParams.status)) ?? 'open';
  const tasks = await (await catalogLoaders()).taskList((await runtime()).sql, status);
  const back = `/tasks?status=${status}`;
  return (
    <section>
      <h1>Tasks</h1>
      <ErrorBanner error={searchParams.error} />
      <nav className="mt-2 flex gap-4 text-sm">
        {STATUSES.map((s) => (s === status ? <span key={s} aria-current="true" className="font-medium text-ink-1 underline decoration-mercury underline-offset-4">{s}</span> : <a key={s} href={`/tasks?status=${s}`}>{s}</a>))}
      </nav>
      <div className="mt-4"><Tasks tasks={tasks} back={back} /></div>

      <h2>New task</h2>
      <TaskForm back={back} />
    </section>
  );
}
