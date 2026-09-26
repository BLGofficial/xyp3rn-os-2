import type { StudioVersionRow } from '../../server/studio-loaders';
import { decideStudioVersion, recipeAction, tagSetAction } from '../studio-actions';
import { Status, Time } from '../ui';

// Studio's shared pieces (AOS-03 §6). Server components only.

type Section = { readonly kind: string; readonly label: string; readonly numbered: boolean; readonly cues: readonly string[] };

/** Every version of a recipe or tag set lineage, with the owner's decision on each draft. */
export const VersionTable = ({ versions, approvedVersion, back }: { versions: readonly StudioVersionRow[]; approvedVersion: number | null; back: string }) => (
  <table>
    <thead><tr><th>V</th><th>Status</th><th>By</th><th>Written</th><th>Decision</th><th>Decide</th></tr></thead>
    <tbody>
      {versions.map((v) => (
        <tr key={v.id}>
          <td>v{v.version}{v.version === approvedVersion ? ' ◆' : ''}</td>
          <td><Status status={v.status} /></td>
          <td>{v.agentName}</td>
          <td className="meta"><Time at={v.createdAt} /></td>
          <td className="meta">{v.decidedBy ? <>{v.decidedBy} at <Time at={v.decidedAt} />: {v.decisionReason}</> : '—'}</td>
          <td>
            {v.status === 'draft' && (
              <form action={decideStudioVersion} className="flex gap-2">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="artifactId" value={v.id} />
                <input name="reason" placeholder="reason" required size={16} aria-label={`reason for v${v.version}`} />
                <button name="decision" value="approve">Approve</button>
                <button name="decision" value="reject">Reject</button>
              </form>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

type Recipe = { name?: string; style?: string; excludeStyles?: string[]; mood?: string[]; production?: string[]; notes?: string[] };

/** A new recipe, or (with parentId) the next version of one, prefilled with the current version. */
export const RecipeForm = ({ back, parentId, current = {} }: { back: string; parentId?: string; current?: Recipe }) => (
  <form action={recipeAction} className="grid gap-2 md:grid-cols-2">
    <input type="hidden" name="back" value={back} />
    {parentId && <input type="hidden" name="parentId" value={parentId} />}
    <label className="field">Name<input name="name" required defaultValue={current.name ?? ''} /></label>
    <label className="field">Exclude styles (comma or line separated; sent to Suno)<input name="excludeStyles" defaultValue={(current.excludeStyles ?? []).join(', ')} /></label>
    <label className="field md:col-span-2">Style of Music (sent to Suno verbatim)<textarea name="style" required rows={3} defaultValue={current.style ?? ''} /></label>
    <label className="field">Mood (comma separated)<input name="mood" defaultValue={(current.mood ?? []).join(', ')} /></label>
    <label className="field">Production direction (one per line)<textarea name="production" rows={3} defaultValue={(current.production ?? []).join('\n')} /></label>
    <label className="field md:col-span-2">Tested notes (one per line: what worked, what didn't)<textarea name="notes" rows={3} defaultValue={(current.notes ?? []).join('\n')} /></label>
    <div><button type="submit">{parentId ? 'Save as the next version' : 'Create recipe'}</button></div>
  </form>
);

/**
 * A new tag set, or (with parentId) the next version of one: one row per section kind; a ticked row is
 * tagged. Rows default to the current version's entries, else to the code labels.
 */
export const TagSetForm = ({ back, kinds, parentId, current }: { back: string; kinds: readonly Section[]; parentId?: string; current?: { name: string; sections: readonly Section[]; notes: readonly string[] } }) => {
  const of = (kind: string) => current?.sections.find((s) => s.kind === kind);
  return (
    <form action={tagSetAction}>
      <input type="hidden" name="back" value={back} />
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      <label className="field mb-2">Name<input name="name" required defaultValue={current?.name ?? ''} /></label>
      <table>
        <thead><tr><th>Tag</th><th>Kind</th><th>Label</th><th>Numbered</th><th>Cues (comma separated; each becomes a [tag])</th></tr></thead>
        <tbody>
          {kinds.map((k) => {
            const c = of(k.kind);
            return (
              <tr key={k.kind}>
                <td><input type="checkbox" name={`include:${k.kind}`} defaultChecked={current ? c !== undefined : true} aria-label={`tag ${k.kind}`} /></td>
                <td>{k.kind}</td>
                <td><input name={`label:${k.kind}`} defaultValue={c?.label ?? k.label} size={14} aria-label={`${k.kind} label`} /></td>
                <td><input type="checkbox" name={`numbered:${k.kind}`} defaultChecked={c ? c.numbered : k.numbered} aria-label={`${k.kind} numbered`} /></td>
                <td><input name={`cues:${k.kind}`} defaultValue={(c?.cues ?? []).join(', ')} size={36} aria-label={`${k.kind} cues`} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label className="field my-2">Notes (one per line; never sent to Suno)<textarea name="notes" rows={2} defaultValue={(current?.notes ?? []).join('\n')} /></label>
      <button type="submit">{parentId ? 'Save as the next version' : 'Create tag set'}</button>
    </form>
  );
};

/** How a tag set renders a section: the tag lines Suno sees before its words. */
export const tagPreview = (s: Section): string => [`[${s.label}${s.numbered ? ' 1' : ''}]`, ...s.cues.map((c) => `[${c}]`)].join(' ');
