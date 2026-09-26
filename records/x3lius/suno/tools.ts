import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../../core/db/client.ts';
import { defineTool, type Tool } from '../../../core/tool-registry/registry.ts';
import { SUNO_PACKAGE_SCHEMA_ID } from '../creative/schemas.ts';
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
 * submit_suno (capability external.execute): submits one Suno prompt package through the named
 * adapter. Since AOS-03 only a x3lius.suno-package/v1 is submitted, and only once the owner has
 * approved each version it names and a workflow run built it (S4): readiness is asked before any
 * adapter call, so a draft never leaves the system, and the DB gate refuses it again on insert. The
 * prompt is read from the package itself, never from the caller. The full prompt is logged to the run
 * BEFORE the external call: the Governance audit trail (Phase 15) holds even when the provider rejects it.
 * @param deps - pool (writes as xyp_execution), env with Suno configuration, fetch override (tests)
 * @returns the tool definition
 */
export const createSubmitSunoTool = (deps: Deps): Tool =>
  defineTool({
    name: 'submit_suno',
    capability: 'external.execute',
    description: 'Submit a ready x3lius.suno-package/v1 (approved versions, built in a workflow) to Suno via the named adapter (manual | sunoapi); records the submission.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { packageId?: unknown; formulaArtifactId?: unknown; adapter?: unknown };
      const adapter = createSunoAdapter(String(a.adapter), { env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      if (a.formulaArtifactId !== undefined) {
        throw new Error('submit_suno takes packageId since AOS-03: a x3lius.suno-package/v1 built by build-suno-package from approved versions (a Phase 9 formula can seed a style recipe: x3lius-studio-editor recipeFrom)');
      }
      if (typeof a.packageId !== 'string') throw new Error('submit_suno: packageId is required');
      const packageId = a.packageId;
      const [artifact] = await asExecution(deps.sql, (tx) => tx<{ schema_id: string; body: Record<string, unknown> }[]>`
        select schema_id, body from creative_artifacts where id = ${packageId}`);
      if (!artifact) throw new Error(`submit_suno: no artifact ${packageId}`);
      if (artifact.schema_id !== SUNO_PACKAGE_SCHEMA_ID) {
        throw new Error(`submit_suno expects a ${SUNO_PACKAGE_SCHEMA_ID} (build one with build-suno-package), got ${artifact.schema_id}`);
      }
      const [ready] = await asExecution(deps.sql, (tx) => tx<{ reasons: string[] }[]>`select xyp_suno_package_ready(${packageId}) as reasons`);
      if (ready!.reasons.length > 0) throw new Error(`submit_suno: package ${packageId} is not ready to hand off: ${ready!.reasons.join('; ')}`);
      const b = artifact.body;
      const prompt: SunoPrompt = { title: b.title as string, style: b.style as string, excludeStyles: b.excludeStyles as string[], lyrics: b.lyrics as string };
      const sunoModel = b.sunoModel as string;

      ctx.log('info', `submit_suno prompt (${adapter.name}, ${sunoModel}): ${JSON.stringify(prompt)}`);
      const sent = await adapter.submit({ prompt, sunoModel });
      const [row] = await asExecution(deps.sql, (tx) => tx<{ id: string }[]>`
        insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt, provider_task_id, provider_response)
        values (${packageId}, ${ctx.runId}, ${adapter.name}, ${sunoModel}, ${tx.json(prompt as unknown as postgres.JSONValue)},
                ${sent.providerTaskId}, ${sent.providerResponse === null ? null : tx.json(sent.providerResponse as postgres.JSONValue)})
        returning id`);
      const status = adapter.name === 'manual' ? 'awaiting-takes' : 'submitted';
      ctx.log('info', `submit_suno → submission ${row!.id} (${adapter.name}${sent.providerTaskId ? `, task ${sent.providerTaskId}` : ''}): ${status}`);
      return { submissionId: row!.id, packageId, adapter: adapter.name, sunoModel, providerTaskId: sent.providerTaskId, status };
    },
  });

/**
 * capture_suno_takes (capability external.execute): records a submission's takes — the
 * operator's (manual) or the provider's (sunoapi, one poll) — and runs the scoring hook, which
 * is a STUB until Phase 12. Re-capturing a take already recorded writes nothing. Since AOS-03 (S3) a
 * manual take may be the audio file itself, uploaded to the Vault first (the DB checks it is audio).
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
        const takes: { id: string; audio_url: string | null; source_id: string | null }[] = [];
        for (const t of got.takes) {
          // A take already recorded (the same URL, or the same Vault file) writes nothing.
          const r = await tx<{ id: string; audio_url: string | null; source_id: string | null }[]>`
            insert into suno_takes (submission_id, agent_run_id, provider_take_id, audio_url, source_id, title, duration_seconds, metadata)
            values (${a.submissionId as string}, ${ctx.runId}, ${t.providerTakeId ?? null}, ${t.audioUrl ?? null}, ${t.sourceId ?? null},
                    ${t.title ?? null}, ${t.durationSeconds ?? null}, ${tx.json((t.metadata ?? {}) as postgres.JSONValue)})
            on conflict do nothing
            returning id, audio_url, source_id`;
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
        takes: written.takes.map((t) => ({ id: t.id, audioUrl: t.audio_url, sourceId: t.source_id })),
        scoring: { status: 'stub', scorer: STUB_SCORER, rows: written.scores.length },
      };
    },
  });

/**
 * rate_take (capability feedback.write): the owner's rating of one take, 1 to 5, with what to keep
 * and what to change next time (PLAN §3F). Append-only; the latest rating is current. The owner's
 * feedback, never a Critic score (take_scores stay the Critic's, F30).
 * @param deps - pool (writes as xyp_execution)
 * @returns the tool definition
 */
export const createRateTakeTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'rate_take',
    capability: 'feedback.write',
    description: 'Record the owner’s rating of a take (1–5) with optional notes on what to keep and what to change (append-only; latest is current).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { takeId?: unknown; rating?: unknown; keep?: unknown; change?: unknown };
      if (typeof a.takeId !== 'string') throw new Error('rate_take: takeId is required');
      if (!Number.isInteger(a.rating) || (a.rating as number) < 1 || (a.rating as number) > 5) throw new Error('rate_take: rating must be an integer from 1 to 5');
      for (const k of ['keep', 'change'] as const) {
        if (a[k] !== undefined && typeof a[k] !== 'string') throw new Error(`rate_take: ${k} must be a string`);
      }
      const [row] = await asExecution(deps.sql, (tx) => tx<{ id: string }[]>`
        insert into take_ratings (take_id, rating, keep, change, agent_run_id)
        values (${a.takeId as string}, ${a.rating as number}, ${(a.keep as string | undefined) ?? null}, ${(a.change as string | undefined) ?? null}, ${ctx.runId})
        returning id`);
      ctx.log('info', `rate_take → take ${a.takeId} rated ${a.rating}`);
      return { ratingId: row!.id, takeId: a.takeId, rating: a.rating, keep: a.keep ?? null, change: a.change ?? null };
    },
  });
