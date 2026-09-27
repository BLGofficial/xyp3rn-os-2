'use server';

import { attempt, local, opt, text } from './action-kit';
import { researchOps, runtime } from '../lib/server';

// Research's writes (AOS-04 §8) through apps/web/server/research-ops.ts. A refusal (the brief check's, the
// gate's or the DB's reason) comes back as ?error=.

const lines = (v: string) => v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const all = (form: FormData, k: string) => form.getAll(k).map(String).map((s) => s.trim()).filter(Boolean);

export async function briefAction(form: FormData) {
  return attempt('/research', async () => {
    const rt = await runtime();
    const targets = [
      ...all(form, 'lineageId').map((id) => ({ kind: 'lineage' as const, artifactLineageId: id })),
      ...all(form, 'workflowName').map((n) => ({ kind: 'workflow' as const, workflowName: n })),
      ...lines(text(form, 'decisionKeys').replace(/[ ,]+/g, '\n')).map((k) => ({ kind: 'decision' as const, decisionKey: k.toUpperCase() })),
    ];
    return (await researchOps()).startBrief(rt.deps, {
      projectSlug: opt(form, 'projectSlug') ?? 'research', question: text(form, 'question'), intendedUse: text(form, 'intendedUse'),
      urls: lines(text(form, 'urls')), targets, songIds: all(form, 'songId'),
      // Ticked: the owner's picks replace the keyword selection (none picked is refused, never "everyone").
      ...(form.get('override') === 'on' ? { specialists: all(form, 'specialist') } : {}),
    });
  }, (r) => `/research/runs/${r.researchRunId}`);
}

export async function rerunAction(form: FormData) {
  const runId = text(form, 'runId');
  return attempt(`/research/runs/${runId}`, async () => (await researchOps()).rerun((await runtime()).deps, runId), (r) => `/research/runs/${r.researchRunId}`);
}

export async function decideFindingAction(form: FormData) {
  const decision = text(form, 'decision') === 'accept' ? 'accept' : 'reject';
  return attempt(local(text(form, 'back'), '/research/library'), async () => {
    const rt = await runtime();
    return (await researchOps()).decideFindingOp(rt.sql, text(form, 'findingId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function promoteAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/research/library'), async () => (await researchOps()).promoteOp((await runtime()).sql, {
    findingId: text(form, 'findingId'), proposed_kind: text(form, 'kind') === 'module' ? 'module' : 'canonical_prompt',
    target_slug: text(form, 'targetSlug'), title: text(form, 'title'), body: text(form, 'body'), domain: text(form, 'domain'),
  }));
}

export async function decidePromotionAction(form: FormData) {
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'reject';
  return attempt(local(text(form, 'back'), '/research/library'), async () => {
    const rt = await runtime();
    return (await researchOps()).decidePromotionOp(rt.sql, text(form, 'approvalId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function retractLinkAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/research'), async () => (await researchOps()).retractLinkOp((await runtime()).sql, text(form, 'linkId'), text(form, 'reason')));
}
