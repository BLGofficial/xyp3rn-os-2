import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityEvent, buildProjection, evaluateHealth } from '../../apps/web/lib/projection.ts';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { registeredComponents } from '../../core/agent-registry/components.ts';
import type { Sql } from '../../core/db/client.ts';
import { authenticate, provisionUser, type Identity } from '../../governance/auth.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedRelease } from '../helpers/records-fixture.ts';

let db: TestDb, viewer: Identity, approver: Identity, relationId:string, registeredRunId:string;
const SECRET='fixture-secret-NEVER-PROJECT-938471';
beforeAll(async()=>{
  db=await createTestDb('phase16_projection',{migrated:true});
  const v=await provisionUser(db.sql,'projection-viewer','viewer'), a=await provisionUser(db.sql,'projection-approver','approver');
  viewer=(await authenticate(db.sql,v.token))!;approver=(await authenticate(db.sql,a.token))!;
  expect((await ingestSource(db.sql,{kind:'file',path:MUSIC_SYSTEM_MANIFEST,origin:'first_party'})).status).toBe('success');
  const modules=await db.sql`select id from modules order by id limit 2`;
  const [relation]=await db.sql`insert into relations(subject_type,subject_id,predicate,object_type,object_id)
    values ('module',${modules[0]!.id},'supports','module',${modules[1]!.id}) returning id`;
  relationId=relation!.id;
  const [run]=await db.sql`insert into agent_runs(agent_name,class,domain,input,output)
    values ('records-catalog','Execution','RECORDS',${db.sql.json({apiKey:SECRET})},${db.sql.json({token:SECRET})}) returning id`;
  registeredRunId=run!.id;
  await db.sql`insert into agent_runs(agent_name,class,domain,input) values ('not-registered','Execution','RECORDS','{}')`;
  await db.sql`insert into workflow_runs(workflow_name,spec_sha256,spec,input,output)
    values ('retrieve-and-summarize',${'d'.repeat(64)},${db.sql.json({secret:SECRET})},${db.sql.json({secret:SECRET})},${db.sql.json({secret:SECRET})})`;
  await db.sql`insert into research_projects(slug,title,description) values ('projection-open','Projection fixture',${SECRET}),('projection-closed','Closed fixture',${SECRET})`;
  await db.sql`update research_projects set status='closed' where slug='projection-closed'`;
  const {releaseId}=await seedRelease(db.sql,{releaseDate:'2026-12-01',splits:[{payee:'A',role:'writer',percentage:100}]});
  await db.sql.begin(async tx=>{await tx`set local role xyp_calendar`;await tx`select xyp_request_release_schedule(${releaseId})`;});
  await db.sql`insert into governance_flags(source_ref,kind,agent_run_id,result) values (${`agent_runs:${registeredRunId}`},'legal',${registeredRunId},${db.sql.json({status:'flagged',flags:[],secret:SECRET,body:SECRET})})`;
});
afterAll(async()=>db?.drop());

describe('canonical data projection',()=>{
  it('every node and edge points at a real source and never invents unresolved endpoints',async()=>{
    const data=await buildProjection(db.sql,approver);
    expect(data.errors).toEqual([]);expect(data.nodes.length).toBeGreaterThan(30);
    const ids=new Set(data.nodes.map(n=>n.id));expect(ids.size).toBe(data.nodes.length);
    for(const node of data.nodes){
      expect(node.href).toContain(encodeURIComponent(node.id));
      if(node.sourceType==='database'){
        const [table,id]=node.sourceRef.split(':');
        expect(table).toMatch(/^[a-z_]+$/);
        expect((await db.sql.unsafe(`select id from public.${table} where id=$1`,[id!])).length).toBe(1);
      }else expect(existsSync(join(REPO_ROOT,node.sourceRef)),node.sourceRef).toBe(true);
    }
    for(const edge of data.edges){expect(ids.has(edge.fromId),edge.id).toBe(true);expect(ids.has(edge.toId),edge.id).toBe(true);expect(edge.sourceRef).toBeTruthy();}
    expect(new Set(data.edges.map(e=>e.id)).size).toBe(data.edges.length);
    expect(data.edges.find(e=>e.sourceRef===`relations:${relationId}`)).toMatchObject({relation:'knowledge',status:'recorded'});
    expect(data.edges.some(e=>e.relation==='workflow'&&data.nodes.find(n=>n.id===e.fromId)?.domain==='CORE'&&data.nodes.find(n=>n.id===e.toId)?.domain==='KNOWLEDGE')).toBe(true);
    expect(data.edges.some(e=>e.sourceRef.endsWith('.dependsOn'))).toBe(true);
  });
  it('counts actual registered pending agents and actual DB objects, without invented health or uptime',async()=>{
    const data=await buildProjection(db.sql,viewer),registry=createAgentRegistry({dir:join(REPO_ROOT,'agents')});
    const [counts]=await db.sql`select ((select count(distinct slug) from modules)+(select count(distinct slug) from canonical_prompts))::int as knowledge,
      (select count(*)::int from workflow_runs where status='running') as workflows,
      (select count(*)::int from research_projects where status='open') as research,
      (select count(*)::int from releases where status not in ('released','cancelled')) as records`;
    expect(data.status.agentsOnline.value).toBe(1);expect(data.status.agentsTotal.value).toBe(registry.list().length);
    expect(data.status.workflowsActive.value).toBe(counts!.workflows);expect(data.status.knowledgeNodes.value).toBe(counts!.knowledge);
    expect(data.status.researchTasksOpen.value).toBe(counts!.research);expect(data.status.recordsProjectsOpen.value).toBe(counts!.records);
    expect(data.status.uptimePercent.value).toBeNull();expect(data.status.systemHealth).toBe('UNKNOWN');
    expect(data.status.apiConnections.note).toContain('does not imply connected');
    expect(data.nodes.find(n=>n.id==='infra:deployment')!.status).toBe('unconfigured');
    for(const node of data.nodes.filter(n=>n.entityType==='provider'))expect(node.metadata).toMatchObject({health:'Not probed',latency:null,usage:null});
    expect(JSON.stringify(data)).not.toMatch(/99\.9%|Europe.*latency|US-East.*healthy/i);
  });
  it('denies unauthorized projection; viewer cannot read approval, flags, or audit events',async()=>{
    await expect(buildProjection(db.sql,{...viewer,permissions:[]})).rejects.toThrow('Forbidden');
    const low=await buildProjection(db.sql,viewer), high=await buildProjection(db.sql,approver);
    expect(low.nodes.some(n=>['approval','governance'].includes(n.entityType))).toBe(false);
    expect(low.events.some(e=>e.source==='audit_log')).toBe(false);
    expect(high.nodes.some(n=>n.entityType==='approval')).toBe(true);expect(high.nodes.some(n=>n.entityType==='governance')).toBe(true);
    expect(high.events.some(e=>e.source==='audit_log')).toBe(true);
    const flag=high.nodes.find(n=>n.entityType==='governance')!;
    expect(flag.metadata.flag_count).toBe(0);expect(flag.metadata.result).toBeUndefined();
  });
  it('never exposes raw run payloads, audit bodies, descriptions, or configured provider credentials',async()=>{
    const prior=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY=SECRET;
    try {
      const data=await buildProjection(db.sql,approver),serialized=JSON.stringify(data);
      expect(serialized).not.toContain(SECRET);
      const event=data.events.find(e=>e.sourceRef===`agent_runs:${registeredRunId}`)!;
      expect(event.eventType).toBe('pending');
      expect(data.events.some(e=>e.source==='audit_log'&&e.summary.includes(`agent_runs:${registeredRunId}`))).toBe(true);
      expect(data.nodes.find(n=>n.id==='provider:openrouter')!.metadata.configured).toBe(true);
    }finally{if(prior===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=prior;}
  });
  it('reports missing DB as unavailable while preserving file-backed registrations and null database metrics',async()=>{
    const unavailable={begin:async()=>{throw new Error(`connection ${SECRET}`);}} as unknown as Sql;
    const data=await buildProjection(unavailable,viewer);
    expect(data.status.systemHealth).toBe('UNAVAILABLE');expect(data.errors).toEqual(['Runtime database projection unavailable']);
    expect(data.nodes.every(n=>n.sourceType!=='database')).toBe(true);expect(data.events).toEqual([]);
    expect(data.status.agentsOnline.value).toBeNull();expect(data.status.agentsTotal.value).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain(SECRET);
  });
  it('discards partially read DB values if the read transaction fails at completion',async()=>{
    const unavailable={begin:async(_options:string,fn:(tx:unknown)=>Promise<void>)=>db.sql.begin(async tx=>{await fn(tx);throw new Error('connection lost');})} as unknown as Sql;
    const data=await buildProjection(unavailable,approver);
    expect(data.status.systemHealth).toBe('UNAVAILABLE');expect(data.status.knowledgeNodes.value).toBeNull();
    expect(data.nodes.some(n=>n.sourceType==='database')).toBe(false);expect(data.events).toEqual([]);
    expect(data.nodes.filter(n=>n.entityType==='agent').every(n=>n.status==='unknown')).toBe(true);
  });
  it('limits table projection explicitly while counts retain full source totals',async()=>{
    await db.sql`insert into research_projects(slug,title) select 'fixture-many-'||n,'Fixture '||n from generate_series(1,205) n`;
    const data=await buildProjection(db.sql,viewer);
    expect(data.truncated).toContain('research_projects');
    expect(data.nodes.filter(n=>n.id.startsWith('research_projects:'))).toHaveLength(200);
    expect(data.status.researchTasksOpen.value).toBe(206);
  });
});

describe('safe events and component registrations',()=>{
  it('event constructor only emits allowlisted fields/states and rejects untrusted identifiers',()=>{
    const id=crypto.randomUUID(),event=activityEvent('agent_runs',{id,status:SECRET,input:{token:SECRET},output:SECRET,old:SECRET,new:SECRET,timestamp:'2026-09-25T12:00:00Z'},'CORE');
    expect(event.eventType).toBe('created');expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(()=>activityEvent(SECRET,{id,timestamp:'2026-09-25T12:00:00Z'},'CORE')).toThrow('provenance');
    expect(()=>activityEvent('agent_runs',{id:SECRET,timestamp:'2026-09-25T12:00:00Z'},'CORE')).toThrow('provenance');
    expect(evaluateHealth(true,0,1)).toBe('DEGRADED');expect(evaluateHealth(true,0,0)).toBe('UNKNOWN');
  });
  it('registers actual six-domain implementation files including Records ops',()=>{
    const components=registeredComponents(REPO_ROOT);
    expect(new Set(components.map(c=>c.domain)).size).toBe(6);
    expect(components.filter(c=>c.domain==='RECORDS').map(c=>c.id)).toEqual(['x3lius-music-system','catalog','rights-splits','release-calendar']);
    for(const component of components)expect(existsSync(join(REPO_ROOT,component.sourceRef)),component.sourceRef).toBe(true);
    expect(registeredComponents(join(REPO_ROOT,'does-not-exist'))).toEqual([]);
  });
});
