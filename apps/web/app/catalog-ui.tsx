import { creditAction, moveTaskAction, taskAction, uncreditAction } from './catalog-actions';
import { ScrollTable, Status, Time } from './ui';

// Pieces the Command Center screens share (AOS-02 §6). Server components only.
// The option lists mirror the DB checks in 20260925150000_command_center.sql; the DB still decides,
// so a stale list here shows up as a refusal on the page, not as bad data.

export const CREDIT_ROLES = ['writer', 'composer', 'lyricist', 'producer', 'vocalist', 'featured_artist', 'performer', 'arranger',
  'recording_engineer', 'mixing_engineer', 'mastering_engineer', 'artwork', 'other'] as const;
export const PLATFORMS = ['spotify', 'apple_music', 'youtube', 'youtube_music', 'soundcloud', 'bandcamp', 'tidal', 'deezer', 'amazon_music',
  'tiktok', 'instagram', 'other'] as const;
export const DELIVERY_STATUSES = ['submitted', 'in_review', 'approved', 'live', 'rejected', 'takedown_requested', 'taken_down'] as const;

type Check = { readonly severity: string; readonly subjectKind: string; readonly subjectTitle: string; readonly code: string; readonly message: string };

export const Checks = ({ checks }: { checks: readonly Check[] }) =>
  checks.length === 0 ? <p className="meta">no open checks</p> : (
    <ScrollTable label="Checks">
      <tbody>{checks.map((c, i) => (
        <tr key={`${c.code}:${i}`}>
          <td><span className={c.severity === 'blocker' ? 'status-blocked' : 'status-warning'}>{c.severity}</span></td><td>{c.subjectKind}</td><td>{c.subjectTitle}</td><td>{c.message}</td>
        </tr>
      ))}</tbody>
    </ScrollTable>
  );

type Credit = { readonly id: string; readonly personName: string; readonly role: string; readonly note: string | null };

/** A credit list with its retract forms; `back` is the page to return to. */
export const Credits = ({ credits, back }: { credits: readonly Credit[]; back: string }) => (
  <ul className="text-sm">
    {credits.map((c) => (
      <li key={c.id} className="flex flex-wrap items-center gap-2">
        <span>{c.personName} · {c.role}{c.note ? ` · ${c.note}` : ''}</span>
        <form action={uncreditAction} className="flex gap-1">
          <input type="hidden" name="creditId" value={c.id} />
          <input type="hidden" name="back" value={back} />
          <input name="reason" placeholder="why" required size={10} aria-label="retract reason" />
          <button className="btn-quiet">Retract</button>
        </form>
      </li>
    ))}
    {credits.length === 0 && <li className="meta">no credits</li>}
  </ul>
);

/** Credit a person (any of their names or aliases) on a song or a track. */
export const CreditForm = ({ target, back }: { target: { songId: string } | { trackId: string }; back: string }) => (
  <form action={creditAction} className="flex flex-wrap items-end gap-2">
    {'songId' in target ? <input type="hidden" name="songId" value={target.songId} /> : <input type="hidden" name="trackId" value={target.trackId} />}
    <input type="hidden" name="back" value={back} />
    <label className="field">Person<input name="person" required size={14} placeholder="name or alias" /></label>
    <label className="field">Role<select name="role" defaultValue="writer">{CREDIT_ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
    <label className="field">Note<input name="note" size={10} /></label>
    <button type="submit">Credit</button>
  </form>
);

type Task = {
  readonly id: string; readonly title: string; readonly status: string; readonly statusNote: string | null; readonly statusAt: string; readonly dueDate: string | null;
  readonly songId: string | null; readonly songTitle: string | null; readonly releaseId: string | null; readonly releaseTitle: string | null;
};

/** Tasks with their target, due date, status and the move form (open ↔ done / cancelled). */
export const Tasks = ({ tasks, back, showTarget = true }: { tasks: readonly Task[]; back: string; showTarget?: boolean }) =>
  tasks.length === 0 ? <p className="meta">no tasks</p> : (
    <ScrollTable label="Tasks">
      <tbody>{tasks.map((t) => (
        <tr key={t.id}>
          <td>{t.title}{t.status === 'open' && <a className="mt-1 block text-sm" href={`/tasks?prepare=${encodeURIComponent(t.title)}#task-brief`}>Prepare agent task →</a>}</td>
          {showTarget && <td className="meta">{t.songTitle ? <a href={`/songs/${t.songId}`}>{t.songTitle}</a> : t.releaseTitle ? <a href={`/releases/${t.releaseId}`}>{t.releaseTitle}</a> : 'general'}</td>}
          <td className="meta">{t.dueDate ?? 'no date'}</td>
          <td><Status status={t.status} />{t.statusNote && <span className="meta"> {t.statusNote}</span>} <span className="meta"><Time at={t.statusAt} /></span></td>
          <td>
            <form action={moveTaskAction} className="flex gap-1">
              <input type="hidden" name="taskId" value={t.id} />
              <input type="hidden" name="back" value={back} />
              <select name="status" defaultValue={t.status === 'open' ? 'done' : 'open'} aria-label="new status">
                {['open', 'done', 'cancelled'].filter((s) => s !== t.status).map((s) => <option key={s}>{s}</option>)}
              </select>
              <input name="note" placeholder="note" size={10} aria-label="note" />
              <button className="btn-quiet">Move</button>
            </form>
          </td>
        </tr>
      ))}</tbody>
    </ScrollTable>
  );

/** A new task, optionally on one song or release. */
export const TaskForm = ({ target, back }: { target?: { songId: string } | { releaseId: string }; back: string }) => (
  <form action={taskAction} className="flex flex-wrap items-end gap-2">
    {target && ('songId' in target ? <input type="hidden" name="songId" value={target.songId} /> : <input type="hidden" name="releaseId" value={target.releaseId} />)}
    <input type="hidden" name="back" value={back} />
    <label className="field grow">Task<input name="title" required /></label>
    <label className="field">Due<input name="dueDate" type="date" /></label>
    <button type="submit">Add task</button>
  </form>
);
