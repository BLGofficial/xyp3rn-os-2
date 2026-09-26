import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from './db.ts';

/**
 * The research brief (AOS-04 §4, R2): a question, its intended use, the URLs the owner allows, an optional
 * owner selection, and its targets. Validated before anything is written; the DB checks again.
 */

export type ResearchTarget =
  | { readonly kind: 'lineage'; readonly artifactLineageId: string; readonly role?: string }
  | { readonly kind: 'workflow'; readonly workflowName: string; readonly role?: string }
  | { readonly kind: 'decision'; readonly decisionKey: string; readonly role?: string };

export type Brief = {
  readonly projectSlug: string;
  readonly question: string;
  readonly intendedUse?: string;
  readonly urls?: readonly string[];
  readonly specialists?: readonly string[];
  readonly targets?: readonly ResearchTarget[];
};

const REPO = join(import.meta.dirname, '..');
/** Where checked-in workflow specs live (a new spec directory is added here). */
const WORKFLOW_DIRS = ['core/workflows', 'records/workflows', 'records/x3lius', 'tech/workflows'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param repoRoot - checkout root (default this one)
 * @returns every `**F<n>.` decision heading in docs/ARCHITECTURE.md
 */
export const decisionKeys = (repoRoot = REPO): Set<string> =>
  new Set([...readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8').matchAll(/^\*\*(F\d+)\./gm)].map((m) => m[1]!));

/**
 * @param repoRoot - checkout root (default this one)
 * @returns the checked-in workflow files, named by their `name:` line
 */
export const workflowFiles = (repoRoot = REPO): { name: string; path: string }[] =>
  WORKFLOW_DIRS.flatMap((d) => {
    let files: string[];
    try {
      files = readdirSync(join(repoRoot, d));
    } catch {
      return [];
    }
    return files.filter((f) => f.endsWith('.workflow.yaml')).map((f) => {
      const path = join(repoRoot, d, f);
      const name = /^name:\s*(\S+)/m.exec(readFileSync(path, 'utf8'))?.[1] ?? f.replace(/\.workflow\.yaml$/, '');
      return { name, path };
    });
  });

/**
 * @param b - the brief
 * @param known - registered specialists and ARCHITECTURE decision keys; `workflows` defaults to workflowFiles()
 * @param opts - `requireIntendedUse` for the AOS-04 brief ops (web form, `pnpm research ask`)
 * @returns every problem, empty when valid
 */
export const validateBrief = (
  b: Brief,
  known: { readonly specialists: ReadonlySet<string>; readonly decisions: ReadonlySet<string>; readonly workflows?: ReadonlySet<string> },
  opts: { readonly requireIntendedUse?: boolean } = {},
): string[] => {
  const errors: string[] = [];
  if (b.question.trim() === '') errors.push('question is required');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.projectSlug)) errors.push(`projectSlug must be kebab case: ${b.projectSlug}`);
  if (opts.requireIntendedUse && (b.intendedUse ?? '').trim() === '') errors.push('intendedUse is required');
  (b.urls ?? []).forEach((u, i) => {
    if (!/^https?:\/\/\S+$/.test(u)) errors.push(`urls[${i}] is not an http(s) URL: ${u}`);
  });
  const unknown = (b.specialists ?? []).filter((s) => !known.specialists.has(s));
  if (unknown.length > 0) errors.push(`specialists: unknown ${unknown.join(', ')}`);
  if (b.specialists && b.specialists.length === 0) errors.push('specialists: pick at least one, or leave it unset for the keyword selection');
  const flows = known.workflows ?? new Set(workflowFiles().map((w) => w.name));
  (b.targets ?? []).forEach((t, i) => {
    if (t.kind === 'decision' && !known.decisions.has(t.decisionKey)) errors.push(`targets[${i}]: no decision ${t.decisionKey} in docs/ARCHITECTURE.md`);
    if (t.kind === 'workflow' && !flows.has(t.workflowName)) errors.push(`targets[${i}]: no workflow ${t.workflowName}`);
    if (t.kind === 'lineage' && !UUID.test(t.artifactLineageId)) errors.push(`targets[${i}]: artifactLineageId is not a uuid`);
    if (t.role !== undefined && t.role.trim() === '') errors.push(`targets[${i}]: role is blank`);
  });
  return errors;
};

/**
 * Unlinks a brief target without deleting it (research_link_retractions).
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param linkId - research_links id
 * @param reason - why
 * @throws Error for a blank reason; the DB refuses an unknown or already retracted link
 */
export const retractResearchLink = async (sql: Sql, linkId: string, reason: string): Promise<void> => {
  if (reason.trim() === '') throw new Error('a retraction needs a reason');
  await asRole(sql, RESEARCH_ROLE, (tx) => tx`insert into research_link_retractions (research_link_id, reason) values (${linkId}, ${reason.trim()})`);
};
