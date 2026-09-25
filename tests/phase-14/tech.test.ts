import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createBacklogTool } from '../../tech/backlog.ts';
import { ingestTrace } from '../../tech/trace/intake.ts';
import { asRole, createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease } from '../helpers/records-fixture.ts';
import { ANALYSIS, RUBRIC } from '../helpers/trace-fixture.ts';

let db: TestDb, deps: DispatchDeps, fx: Awaited<ReturnType<typeof seedCreative>>;
const tmp=mkdtempSync(join(tmpdir(),'xyp-p14-'));
beforeAll(async()=>{
  db=await createTestDb('phase14_tech',{migrated:true});
  fx=await seedCreative(db.sql);
  deps={sql:db.sql,registry:createAgentRegistry({dir:join(REPO_ROOT,'agents')}),tools:createRuntimeTools({sql:db.sql}),handlers:HANDLERS};
});
afterAll(async()=>{await db?.drop();rmSync(tmp,{recursive:true,force:true});});
const ctx=()=>({runId:fx.runId,agentName:'tech-rd-backlog',log:()=>{}});

describe('TRACE intake service with real runtime and DB',()=>{
  it('validates malformed analysis and identifiers before creating run/artifact rows',async()=>{
    const [before]=await db.sql`select count(*)::int as n from agent_runs`;
    await expect(ingestTrace(deps,{analysis:{schema:'trace.analysis/v1'}})).rejects.toThrow('required');
    await expect(ingestTrace(deps,{analysis:ANALYSIS,takeId:'-'.repeat(36)})).rejects.toThrow('UUID');
    await expect(ingestTrace(deps,{analysis:ANALYSIS,takeId:crypto.randomUUID()})).rejects.toThrow('Take not found');
    await expect(ingestTrace(deps,{analysis:ANALYSIS,trackId:crypto.randomUUID()})).rejects.toThrow('Track not found');
    expect((await db.sql`select count(*)::int as n from agent_runs`)[0]!.n).toBe(before!.n);
  });
  it('persists exact measured input and report provenance, leaving unknown rubric score null',async()=>{
    const {trackIds:[track]}=await seedRelease(db.sql);
    const result=await ingestTrace(deps,{analysis:ANALYSIS,trackId:track});
    expect(result.score).toBeNull();
    const [stored]=await db.sql`select analysis,report_id,agent_run_id,track_id from trace_analyses where id=${result.id}`;
    expect(stored).toEqual({analysis:ANALYSIS,report_id:result.reportId,agent_run_id:result.agentRunId,track_id:track});
    expect((await db.sql`select mix_report_id from tracks where id=${track!}`)[0]!.mix_report_id).toBe(result.reportId);
    const takeResult=await ingestTrace(deps,{analysis:ANALYSIS,takeId:fx.takeId});
    expect(takeResult.score).toBeNull();
    expect(await db.sql`select 1 from take_scores where take_id=${fx.takeId}`).toHaveLength(0);
  });
  it('scores only canonical measured checks and links take, analysis, report, and agent run',async()=>{
    expect((await ingestSource(db.sql,{kind:'file',path:MUSIC_SYSTEM_MANIFEST,origin:'first_party'})).status).toBe('success');
    const path=join(tmp,'fixture-rubric.yaml');writeFileSync(path,RUBRIC());
    expect((await ingestSource(db.sql,{kind:'file',path,origin:'first_party'})).status).toBe('success');
    const result=await ingestTrace(deps,{analysis:ANALYSIS,takeId:fx.takeId});
    expect(result.score).toBe(0.25);
    const [score]=await db.sql`select agent_run_id,is_stub,score,detail from take_scores where take_id=${fx.takeId}`;
    expect(score!.agent_run_id).toBe(result.agentRunId);expect(score!.is_stub).toBe(false);
    expect(score!.detail).toMatchObject({traceId:result.id,reportId:result.reportId,checked:4});
    const [report]=await db.sql`select body from creative_artifacts where id=${result.reportId}`;
    expect(report!.body.checks.every((c:{ref:string;version:number})=>c.ref.startsWith('canonical_prompts:')&&c.version===1)).toBe(true);
  });
  it('refuses mismatched take/track and locked catalog before report dispatch',async()=>{
    const {releaseId,trackIds:[track]}=await seedRelease(db.sql,{releaseDate:'2026-12-01',splits:[{payee:'A',role:'writer',percentage:100}]});
    await expect(ingestTrace(deps,{analysis:ANALYSIS,trackId:track,takeId:fx.takeId})).rejects.toThrow('does not match');
    await db.sql`update releases set status='pending_schedule' where id=${releaseId}`;
    await expect(ingestTrace(deps,{analysis:ANALYSIS,trackId:track})).rejects.toThrow('draft');
  });
  it('prevents direct invalid schema and trail mutations, including service role',async()=>{
    await expectPgError(()=>db.sql`insert into trace_analyses(analysis,report_id,agent_run_id) values ('{}',${fx.mixReportId},${fx.runId})`,'23514');
    await expectPgError(()=>db.sql`insert into trace_analyses(analysis,report_id,agent_run_id) values ('{"schema":null}',${fx.mixReportId},${fx.runId})`,'23514');
    for(const role of ['service_role','xyp_trace']) {
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`delete from trace_analyses`),'42501');
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`truncate trace_analyses`),'42501');
    }
    await expectPgError(()=>db.sql`update trace_analyses set analysis=analysis`,'55000');
  });
});

describe('research-backed proposal-only backlog',()=>{
  const source=async(tags:string[])=>{
    const [project]=await db.sql`insert into research_projects(slug,title) values (${crypto.randomUUID()},'[FIXTURE]') returning id`;
    const [question]=await db.sql`insert into research_questions(project_id,question) values (${project!.id},'[FIXTURE]') returning id`;
    const [run]=await db.sql`insert into research_runs(question_id) values (${question!.id}) returning id`;
    const [row]=await db.sql`insert into research_sources(research_run_id,kind,uri,title,content_sha256,tags)
      values (${run!.id},'observation','fixture:test','[FIXTURE]',${crypto.randomUUID().replaceAll('-','').repeat(2)},${tags}) returning id`;
    return row!.id as string;
  };
  it('requires frontier/emerging source tags in tool and DB',async()=>{
    const tool=createBacklogTool(db.sql), invalid=await source(['ordinary']);
    await expect(tool.handler(ctx(),{sourceId:invalid,title:'Feature',rationale:'Evidence'})).rejects.toThrow('tagged');
    await expectPgError(()=>asRole(db.sql,'xyp_planning',(tx)=>tx`insert into rd_backlog(source_id,title,rationale,agent_run_id) values (${invalid},'Feature','Evidence',${fx.runId})`),'23514');
    for(const tag of ['frontier','emerging']) {
      const id=await source([tag]);const proposed=await tool.handler(ctx(),{sourceId:id,title:'Feature',rationale:'Evidence'}) as {status:string;source_id:string};
      expect(proposed).toMatchObject({status:'proposed',source_id:id});
    }
  });
  it('planning cannot accept, implement, rewrite, or delete proposals',async()=>{
    const id=await source(['frontier']);
    await expectPgError(()=>asRole(db.sql,'xyp_planning',(tx)=>tx`insert into rd_backlog(source_id,title,rationale,status,agent_run_id) values (${id},'Feature','Evidence','accepted',${fx.runId})`),'42501');
    await expectPgError(()=>asRole(db.sql,'xyp_planning',(tx)=>tx`update rd_backlog set status='accepted'`),'42501');
    await expectPgError(()=>asRole(db.sql,'xyp_planning',(tx)=>tx`delete from rd_backlog`),'42501');
    await expectPgError(()=>asRole(db.sql,'xyp_planning',(tx)=>tx`update canonical_prompts set body='implementation'`),'42501');
  });
});
