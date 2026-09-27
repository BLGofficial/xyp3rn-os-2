import type { Selection } from '../../../../core/orchestrator/scope-select.ts';
import { briefAction, decideFindingAction, decidePromotionAction, promoteAction, retractLinkAction } from '../research-actions';

// Research's forms and small pieces (AOS-04 §17). Server components; every decision asks for a reason.

type Target = { kind: string; target: string; label: string; role: string | null; linkId: string; via: string };

export const TargetChips = ({ targets }: { targets: readonly Target[] }) => (
  <>{targets.length === 0 ? <span className="meta">none</span> : targets.map((t) => (
    <span key={t.linkId} className="tag">
      {t.kind}: {t.kind === 'song' ? <a href={`/songs/${t.target}`}>{t.label}</a> : t.kind === 'lineage' ? <a href={`/vault/lineages/${t.target}`}>{t.label}</a> : t.label}
      {t.role ? ` (${t.role})` : ''}
    </span>
  ))}</>
);

/** The brief's research links with an unlink form each (a song is unlinked on its own page). */
export const TargetList = ({ targets, back }: { targets: readonly Target[]; back: string }) => (
  <table>
    <thead><tr><th>Kind</th><th>Target</th><th>Role</th><th /></tr></thead>
    <tbody>
      {targets.map((t) => (
        <tr key={t.linkId}>
          <td>{t.kind}</td>
          <td><TargetChips targets={[{ ...t, role: null }]} /></td>
          <td className="meta">{t.role ?? '—'}</td>
          <td>
            {t.via === 'research_links' ? (
              <form action={retractLinkAction} className="flex gap-1">
                <input type="hidden" name="linkId" value={t.linkId} /><input type="hidden" name="back" value={back} />
                <input name="reason" placeholder="why" required size={10} aria-label={`unlink reason for ${t.kind} ${t.label}`} />
                <button className="px-1 text-xs">Unlink</button>
              </form>
            ) : <span className="meta">unlink on the song page</span>}
          </td>
        </tr>
      ))}
      {targets.length === 0 && <tr><td colSpan={4} className="meta">no target</td></tr>}
    </tbody>
  </table>
);

export const BriefForm = (p: {
  question: string; preview: Selection | null;
  specialists: readonly { name: string; scope: string }[]; workflows: readonly string[]; decisions: readonly string[];
  songs: readonly { id: string; title: string }[]; lineages: readonly { id: string; name: string; kind: string }[];
}) => {
  const picked = new Set(p.preview?.selected.map((s) => s.name) ?? []);
  const scoreOf = new Map([...(p.preview?.selected ?? []), ...(p.preview?.notSelected ?? [])].map((s) => [s.name, s]));
  return (
    <form action={briefAction} className="mt-2 grid gap-3">
      <label className="field">Question <textarea name="question" required defaultValue={p.question} rows={2} className="w-full normal-case tracking-normal" /></label>
      <label className="field">Intended use (what the answer is for) <textarea name="intendedUse" required rows={2} className="w-full normal-case tracking-normal" /></label>
      <label className="field">Source URLs, one per line (the only external pages the specialists may read)
        <textarea name="urls" rows={3} className="w-full normal-case tracking-normal" placeholder="https://…" />
      </label>
      <fieldset className="grid gap-2 border border-rule p-2">
        <legend className="meta px-1">Links (what the research informs)</legend>
        <label className="field">Songs <select name="songId" multiple className="w-full normal-case">{p.songs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <label className="field">Recipes, tag sets, lyrics <select name="lineageId" multiple className="w-full normal-case">{p.lineages.map((l) => <option key={l.id} value={l.id}>{l.kind}: {l.name}</option>)}</select></label>
        <label className="field">Workflows <select name="workflowName" multiple className="w-full normal-case">{p.workflows.map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <label className="field">Decisions (e.g. F41 F40) <input name="decisionKeys" list="decision-keys" className="w-full" /></label>
        <datalist id="decision-keys">{p.decisions.map((d) => <option key={d} value={d} />)}</datalist>
      </fieldset>
      <fieldset className="grid gap-1 border border-rule p-2">
        <legend className="meta px-1">Specialists</legend>
        <label><input type="checkbox" name="override" /> Use my picks below instead of the keyword selection</label>
        {p.specialists.map((s) => {
          const sc = scoreOf.get(s.name);
          return (
            <label key={s.name} className="block text-sm">
              <input type="checkbox" name="specialist" value={s.name} defaultChecked={picked.has(s.name)} /> {s.name}
              <span className="meta"> — score {sc?.score ?? 0}{sc && sc.matched.length > 0 ? ` (${sc.matched.join(', ')})` : ''}</span>
            </label>
          );
        })}
      </fieldset>
      <div><button type="submit">Open the brief and run it</button></div>
    </form>
  );
};

export const DecideForm = ({ findingId, back }: { findingId: string; back: string }) => (
  <form action={decideFindingAction} className="mt-2 flex flex-wrap items-end gap-2">
    <input type="hidden" name="findingId" value={findingId} /><input type="hidden" name="back" value={back} />
    <label className="field">Reason <input name="reason" required /></label>
    <button type="submit" name="decision" value="accept">Accept into the library</button>
    <button type="submit" name="decision" value="reject">Reject</button>
  </form>
);

export const PromoteForm = ({ findingId, back, topic, domains }: { findingId: string; back: string; topic: string; domains: readonly string[] }) => (
  <form action={promoteAction} className="mt-2 grid gap-2">
    <input type="hidden" name="findingId" value={findingId} /><input type="hidden" name="back" value={back} />
    <label className="field">Kind <select name="kind"><option value="canonical_prompt">canonical prompt</option><option value="module">module</option></select></label>
    <label className="field">Target slug <input name="targetSlug" required defaultValue={topic.replace(/\./g, '-')} /></label>
    <label className="field">Title <input name="title" required /></label>
    <label className="field">Body (the canonical text) <textarea name="body" required rows={3} className="normal-case tracking-normal" /></label>
    <label className="field">Domain <select name="domain" defaultValue="RECORDS">{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
    <div><button type="submit">Propose for canonical (goes to the gate, then to you)</button></div>
  </form>
);

export const ApprovalForm = ({ approvalId, back }: { approvalId: string; back: string }) => (
  <form action={decidePromotionAction} className="mt-2 flex flex-wrap items-end gap-2">
    <input type="hidden" name="approvalId" value={approvalId} /><input type="hidden" name="back" value={back} />
    <label className="field">Reason <input name="reason" required /></label>
    <button type="submit" name="decision" value="approve">Approve canonical</button>
    <button type="submit" name="decision" value="reject">Reject</button>
  </form>
);

// The run page's no-JS fallback for RunRefresh (a meta refresh, rendered inside <noscript> only while the
// run is running and has no finding yet, so it can't reset a half-typed reason).
export const AutoRefresh = ({ seconds }: { seconds: number }) => <meta httpEquiv="refresh" content={String(seconds)} />;

/** The workbench's words for how a specialist's step ended (§17); each is also a status class. */
export const OUTCOME: Readonly<Record<string, { readonly word: string; readonly cls: string }>> = {
  running: { word: 'Running', cls: 'status-running' },
  completed: { word: 'Completed', cls: 'status-success' },
  'no-sources': { word: 'No sources', cls: 'status-none' },
  declined: { word: 'Declined', cls: 'status-warning' },
  failed: { word: 'Failed', cls: 'status-failed' },
  'timed-out': { word: 'Timed out', cls: 'status-failed' },
};

/** Elapsed time from recorded timestamps: `1 h 02 min`, `3 min 05 s`, `12 s`. */
export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : m > 0 ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
};

type ResearchOf = {
  readonly briefs: readonly { questionId: string; question: string; latestRun: { id: string; status: string } | null }[];
  readonly findings: readonly { findingId: string; runId: string; claimTopic: string; claim: string; canonicalStatus: string }[];
};

/** The Research section of a song, recipe or tag set page: the briefs that link it and their accepted findings. */
export const ResearchSection = ({ research }: { research: ResearchOf }) => (
  <>
    <h2>Research</h2>
    <table>
      <thead><tr><th>Brief</th><th>Latest run</th></tr></thead>
      <tbody>
        {research.briefs.map((b) => (
          <tr key={b.questionId}>
            <td>{b.latestRun ? <a href={`/research/runs/${b.latestRun.id}`}>{b.question}</a> : b.question}</td>
            <td>{b.latestRun ? <span className={`status-${b.latestRun.status}`}>{b.latestRun.status}</span> : '—'}</td>
          </tr>
        ))}
        {research.briefs.length === 0 && <tr><td colSpan={2} className="meta">no brief links this yet — <a href="/research">open one</a></td></tr>}
      </tbody>
    </table>
    {research.findings.map((f) => (
      <p key={f.findingId} className="mt-1">
        <a href={`/research/runs/${f.runId}`}>{f.claimTopic}</a>: {f.claim} <span className="meta">(in the library; canonical: {f.canonicalStatus})</span>
      </p>
    ))}
  </>
);
