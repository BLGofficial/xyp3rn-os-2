import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../../core/db/client.ts';
import { defineTool, type Tool } from '../../../core/tool-registry/registry.ts';
import { SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { createSunoAdapter, type SunoPrompt } from './adapters.ts';
import { recordStubScores, STUB_SCORER } from './score-hook.ts';

/** The DB role Suno execution writes run as (migration 20260924190000): the Suno trail only. */
export const EXECUTION_ROLE = 'xyp_execution';

type Deps = { readonly sql: Sql; readonly env: Readonly<Record<string, string | undefined>>; readonly fetch?: typeof fetch };

const asExecution = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(EXECUTION_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * submit_suno (capability external.execute): submits one formula artifact through the named
 * adapter. The prompt is read from the artifact itself, never from the caller, so what is sent is
 * exactly what the formula agent wrote. The full prompt is logged to the run BEFORE the external
 * call: the Governance audit trail (Phase 15) holds even when the provider rejects it.
 * @param deps - pool (writes as xyp_execution), env with Suno configuration, fetch override (tests)
 * @returns the tool definition
 */
export const createSubmitSunoTool = (deps: Deps): Tool =>
  defineTool({
    name: 'submit_suno',
    capability: 'external.execute',
    description: 'Submit a x3lius.suno-prompt/v1 artifact to Suno via the named adapter (manual | sunoapi); records the submission.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { formulaArtifactId?: unknown; adapter?: unknown };
      const adapter = createSunoAdapter(String(a.adapter), { env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      if (typeof a.formulaArtifactId !== 'string') throw new Error('submit_suno: formulaArtifactId is required');
      const [artifact] = await asExecution(deps.sql, (tx) => tx<{ schema_id: string; body: Record<string, unknown> }[]>`
        select schema_id, body from creative_artifacts where id = ${a.formulaArtifactId as string}`);
      if (!artifact) throw new Error(`submit_suno: no artifact ${a.formulaArtifactId}`);
      if (artifact.schema_id !== SUNO_PROMPT_SCHEMA_ID) throw new Error(`submit_suno expects a ${SUNO_PROMPT_SCHEMA_ID} artifact, got ${artifact.schema_id}`);
      const b = artifact.body;
      const prompt: SunoPrompt = { title: b.title as string, style: b.style as string, excludeStyles: b.excludeStyles as string[], lyrics: b.lyrics as string };
      const sunoModel = b.sunoModel as string;

      ctx.log('info', `submit_suno prompt (${adapter.name}, ${sunoModel}): ${JSON.stringify(prompt)}`);
      const sent = await adapter.submit({ prompt, sunoModel });
      const [row] = await asExecution(deps.sql, (tx) => tx<{ id: string }[]>`
        insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt, provider_task_id, provider_response)
        values (${a.formulaArtifactId as string}, ${ctx.runId}, ${adapter.name}, ${sunoModel}, ${tx.json(prompt as unknown as postgres.JSONValue)},
                ${sent.providerTaskId}, ${sent.providerResponse === null ? null : tx.json(sent.providerResponse as postgres.JSONValue)})
        returning id`);
      const status = adapter.name === 'manual' ? 'awaiting-takes' : 'submitted';
      ctx.log('info', `submit_suno → submission ${row!.id} (${adapter.name}${sent.providerTaskId ? `, task ${sent.providerTaskId}` : ''}): ${status}`);
      return { submissionId: row!.id, adapter: adapter.name, sunoModel, providerTaskId: sent.providerTaskId, status };
    },
  });

/**
 * capture_suno_takes (capability external.execute): records a submission's takes — the
 * operator's (manual) or the provider's (sunoapi, one poll) — and runs the scoring hook, which
 * is a STUB until Phase 12. Re-capturing a take already recorded writes nothing.
 * @param deps - pool (writes as xyp_execution), env with Suno configuration, fetch override (tests)
 * @returns the tool definition
 */
export const createCaptureSunoTakesTool = (deps: Deps): Tool =>
  defineTool({
    name: 'capture_suno_takes',
    capability: 'external.execute',
    description: 'Capture the takes of a Suno submission (operator-supplied for manual, polled for sunoapi) and hook each into scoring (stub until Phase 12).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { submissionId?: unknown; takes?: unknown };
      if (typeof a.submissionId !== 'string') throw new Error('capture_suno_takes: submissionId is required');
      const [sub] = await asExecution(deps.sql, (tx) => tx<{ adapter: string; provider_task_id: string | null }[]>`
        select adapter, provider_task_id from suno_submissions where id = ${a.submissionId as string}`);
      if (!sub) throw new Error(`capture_suno_takes: no submission ${a.submissionId}`);
      const adapter = createSunoAdapter(sub.adapter, { env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const got = await adapter.capture({ providerTaskId: sub.provider_task_id, ...(a.takes !== undefined ? { takes: a.takes as unknown[] } : {}) });
      if (got.status === 'pending') {
        ctx.log('info', `capture_suno_takes: submission ${a.submissionId} still pending at the provider`);
        return { submissionId: a.submissionId, status: 'pending', inserted: 0, alreadyCaptured: 0, takes: [] };
      }
      const written = await asExecution(deps.sql, async (tx) => {
        const takes: { id: string; audio_url: string }[] = [];
        for (const t of got.takes) {
          const r = await tx<{ id: string; audio_url: string }[]>`
            insert into suno_takes (submission_id, agent_run_id, provider_take_id, audio_url, title, duration_seconds, metadata)
            values (${a.submissionId as string}, ${ctx.runId}, ${t.providerTakeId ?? null}, ${t.audioUrl}, ${t.title ?? null},
                    ${t.durationSeconds ?? null}, ${tx.json((t.metadata ?? {}) as postgres.JSONValue)})
            on conflict (submission_id, audio_url) do nothing
            returning id, audio_url`;
          takes.push(...r);
        }
        const scores = await recordStubScores(tx, takes.map((t) => t.id), ctx.runId);
        return { takes, scores };
      });
      ctx.log('info', `capture_suno_takes: ${written.takes.length} new take(s), ${got.takes.length - written.takes.length} already captured; scoring: STUB (${STUB_SCORER})`);
      return {
        submissionId: a.submissionId,
        status: 'captured',
        inserted: written.takes.length,
        alreadyCaptured: got.takes.length - written.takes.length,
        takes: written.takes.map((t) => ({ id: t.id, audioUrl: t.audio_url })),
        scoring: { status: 'stub', scorer: STUB_SCORER, rows: written.scores.length },
      };
    },
  });
