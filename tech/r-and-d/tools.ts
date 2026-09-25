import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';

/** The DB role the R&D backlog reads and writes as (migration 20260925120000). */
export const PLANNER_ROLE = 'xyp_planner';
/** Whose evidence the backlog reads: the Phase 6B Frontier Scanner (research_sources carry no tags). */
export const FRONTIER_SPECIALIST = 'frontier-tool-scanner-researcher';
export const MAX_EVIDENCE = 50;
export const RD_COMPONENTS = ['products', 'audio-tools', 'ai-systems', 'r-and-d'] as const;
export type RdComponent = (typeof RD_COMPONENTS)[number];

const asPlanner = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>, mode = ''): Promise<T> =>
  sql.begin(mode, async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(PLANNER_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/** One piece of the Frontier Scanner's evidence, with the source that backs it. */
export type FrontierEvidence = {
  readonly id: string; readonly claim: string; readonly modelTag: string; readonly confidence: number; readonly createdAt: string;
  readonly source: { readonly id: string; readonly kind: string; readonly uri: string; readonly title: string; readonly reliability: number | null; readonly retrievedAt: string };
};

/**
 * read_frontier_evidence (research.read, Phase 14): the Frontier Scanner's evidence with its source,
 * newest first, leaving out evidence a backlog item already cites (so a run proposes from what is new).
 * @param deps - pool; reads as xyp_planner, read only
 * @returns the tool definition
 */
export const createReadFrontierEvidenceTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_frontier_evidence',
    capability: 'research.read',
    description: "The Frontier Scanner's evidence not yet cited by an R&D backlog item, with its sources.",
    handler: async (_ctx, args) => {
      const limit = (args as { limit?: unknown } | null)?.limit ?? 20;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_EVIDENCE) {
        throw new Error(`read_frontier_evidence: limit must be an integer from 1 to ${MAX_EVIDENCE}`);
      }
      return asPlanner(deps.sql, async (tx) => {
        const rows = await tx<{
          id: string; claim: string; model_tag: string; confidence: string; created_at: string;
          source_id: string; kind: string; uri: string; title: string; reliability: string | null; retrieved_at: string;
        }[]>`
          select e.id, e.claim, e.model_tag, e.confidence::text, e.created_at::text,
                 s.id as source_id, s.kind::text, s.uri, s.title, s.reliability::text, s.retrieved_at::text
          from research_evidence e join research_sources s on s.id = e.research_source_id
          where e.specialist = ${FRONTIER_SPECIALIST}
            and not exists (select from rd_backlog_evidence b where b.research_evidence_id = e.id)
          order by e.created_at desc, e.id
          limit ${limit as number}`;
        const [cited] = await tx<{ n: number }[]>`select count(distinct research_evidence_id)::int as n from rd_backlog_evidence`;
        const evidence: FrontierEvidence[] = rows.map((r) => ({
          id: r.id, claim: r.claim, modelTag: r.model_tag, confidence: Number(r.confidence), createdAt: r.created_at,
          source: { id: r.source_id, kind: r.kind, uri: r.uri, title: r.title, reliability: r.reliability === null ? null : Number(r.reliability), retrievedAt: r.retrieved_at },
        }));
        return { evidence, alreadyCited: cited!.n };
      }, 'read only');
    },
  });

export type BacklogItem = { readonly title: string; readonly component: RdComponent; readonly proposal: string; readonly rationale: string; readonly evidenceIds: readonly string[] };

/**
 * write_rd_backlog (plan.write, Phase 14): writes each item with its evidence links under its own
 * savepoint. The DB queues every item for a human (approval_queue, rd_backlog_item) and refuses one
 * citing nothing, or citing evidence not the Frontier Scanner's. A title already in the backlog is
 * reported as a duplicate and skipped, never fatal.
 * @param deps - pool; writes as xyp_planner (no grant on approval_queue: the DB queues, humans decide)
 * @returns the tool definition
 */
export const createWriteRdBacklogTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_rd_backlog',
    capability: 'plan.write',
    description: 'Write R&D backlog proposals (each queued for a human decision); duplicates are skipped.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { items?: unknown; model?: unknown };
      if (!Array.isArray(a.items)) throw new Error('write_rd_backlog: items must be an array');
      if (typeof a.model !== 'string' || a.model.trim() === '') throw new Error('write_rd_backlog: model must name the model that proposed them');
      const items = a.items as BacklogItem[];
      return asPlanner(deps.sql, async (tx) => {
        const written: { id: string; title: string }[] = [];
        const duplicates: string[] = [];
        for (const it of items) {
          try {
            const id = await tx.savepoint(async (sp) => {
              const [row] = await sp<{ id: string }[]>`
                insert into rd_backlog (title, component, proposal, rationale, model, agent_run_id)
                values (${it.title}, ${it.component}, ${it.proposal}, ${it.rationale}, ${a.model as string}, ${ctx.runId}) returning id`;
              for (const e of it.evidenceIds) {
                await sp`insert into rd_backlog_evidence (rd_backlog_id, research_evidence_id) values (${row!.id}, ${e})`;
              }
              return row!.id;
            });
            written.push({ id, title: it.title });
          } catch (e) {
            if ((e as { code?: string }).code !== '23505') throw e;
            duplicates.push(it.title);
          }
        }
        ctx.log('info', `write_rd_backlog: ${written.length} written (each queued for a human), ${duplicates.length} duplicate(s) skipped`);
        return { written, duplicates };
      });
    },
  });
