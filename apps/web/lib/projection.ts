import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DOMAINS, DOMAIN_META, isDomain, type Domain } from '../../../core/contracts/taxonomy.ts';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { parseWorkflowSpec } from '../../../core/workflow-engine/spec.ts';
import { REPO_ROOT } from '../../../core/repo.ts';
import { PROVIDERS } from '../../../core/llm/providers.ts';
import type { Sql } from '../../../core/db/client.ts';
import { requirePermission, type Identity } from '../../../governance/auth.ts';
import type { Projection, GraphNode, Metric, LiveActivityEvent } from './types.ts';

export const entityHref = (id:string,domain:Domain) => `?view=graph&domain=${domain.toLowerCase()}&node=${encodeURIComponent(id)}`;
export const evaluateHealth = (available:boolean,errors:number,failedRuns:number):Projection['status']['systemHealth'] => !available ? 'UNAVAILABLE' : errors || failedRuns ? 'DEGRADED' : 'UNKNOWN';
/** Events are constructed from an allowlist; raw SQL input/output and audit old/new never cross this boundary. */
const EVENT_SOURCES = new Set(['agent_runs','workflow_runs','knowledge_versions','research_runs','audit_log']);
const EVENT_STATES = new Set(['pending','running','success','error','completed','failed','cancelled','open','closed','insert','update','delete']);
const EVENT_TABLES = new Set(['agent_runs','workflow_runs','approval_queue','knowledge_versions','releases','tracks','rights_splits','trace_analyses','rd_backlog','governance_flags','records_flags']);
const ROW_ID = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const activityEvent = (source:string,row:Record<string,unknown>,domain:Domain):LiveActivityEvent => {
  if (!EVENT_SOURCES.has(source) || !ROW_ID.test(String(row.id))) throw new Error('Invalid activity provenance');
  const rawState=String(row.status??row.op??'created'), eventType=EVENT_STATES.has(rawState)?rawState:'created';
  const target=source==='audit_log'&&EVENT_TABLES.has(String(row.table_name))&&ROW_ID.test(String(row.row_id))?` · ${String(row.table_name)}:${String(row.row_id)}`:'';
  return {id:`${source}:${String(row.id)}`,source,sourceRef:`${source}:${String(row.id)}`,domain,eventType,
    summary:`${source.replaceAll('_',' ')}${target} · ${eventType}`,timestamp:new Date(String(row.timestamp)).toISOString(),severity:['error','failed'].includes(eventType)?'error':'info'};
};

export const buildProjection = async (sql:Sql,identity:Identity):Promise<Projection> => {
  requirePermission(identity,'system.read');
  const generatedAt=new Date().toISOString(); const registry=createAgentRegistry({dir:join(REPO_ROOT,'agents'),log:()=>{}});
  const nodes:GraphNode[]=[]; const edges:Projection['edges']=[]; const events:LiveActivityEvent[]=[]; const errors:string[]=[]; const truncated:string[]=[];
  const metric=(value:number|null,source:string,query:string,note?:string):Metric=>({value,source,query,generatedAt,...(note?{note}:{})});
  const add=(id:string,domain:Domain,label:string,entityType:string,sourceRef:string,metadata:Record<string,unknown>={},status='registered',kind:GraphNode['kind']='satellite',sourceType:GraphNode['sourceType']='file')=> {
    const node:GraphNode={id,domain,label,entityType,sourceRef,metadata,status,kind,sourceType,entityId:id.slice(id.indexOf(':')+1),href:entityHref(id,domain)}; nodes.push(node); return node;
  };
  const version=(JSON.parse(readFileSync(join(REPO_ROOT,'package.json'),'utf8')) as {version:string}).version;
  add('hub:xyp3rn','CORE','XYP3RN','system','package.json',{version},'registered','hub');
  for(const domain of DOMAINS) add(`domain:${domain}`,domain,DOMAIN_META[domain].label,'domain','core/contracts/taxonomy.ts',{},'registered','domain');
  for(const component of registry.components()) add(`component:${component.domain}:${component.id}`,component.domain,component.label,'component',component.sourceRef,{description:component.description??'Registered architecture component',health:'Not measured'});
  for(const a of registry.list()) add(`agent:${a.name}`,a.domain,a.name.replaceAll('-',' '),'agent',relative(REPO_ROOT,a.path).replaceAll('\\','/'),{name:a.name,class:a.class,model:a.model,tools:a.tools,contract:a.contract,refuses:a.refuses,recentRuns:[]},'unknown');
  for(const folder of ['core/workflows','records/x3lius']) for(const file of readdirSync(join(REPO_ROOT,folder)).filter(f=>f.endsWith('.workflow.yaml'))) {
    const sourceRef=`${folder}/${file}`; const parsed=parseWorkflowSpec(readFileSync(join(REPO_ROOT,sourceRef),'utf8'),new Set(registry.list().map(a=>a.name)));
    if(!parsed.ok){errors.push(`Invalid workflow: ${sourceRef}`);continue;}
    const n=add(`workflow:${parsed.spec.name}`,folder.startsWith('records')?'RECORDS':'CORE',parsed.spec.name,'workflow',sourceRef,{description:parsed.spec.description,steps:parsed.spec.steps.map(s=>({id:s.id,agent:s.agent,dependsOn:s.dependsOn})),recentExecutions:[]});
    for(const step of parsed.spec.steps) {
      edges.push({id:`${n.id}:${step.id}`,fromId:n.id,toId:`agent:${step.agent}`,relation:'workflow',status:'registered',sourceRef:`${sourceRef}#${step.id}`});
      for(const dependency of step.dependsOn) {
        const prior=parsed.spec.steps.find(s=>s.id===dependency)!;
        edges.push({id:`${n.id}:${dependency}->${step.id}`,fromId:`agent:${prior.agent}`,toId:`agent:${step.agent}`,relation:'workflow',status:'registered',sourceRef:`${sourceRef}#${step.id}.dependsOn`});
      }
    }
  }
  let configured=0;
  for(const [provider,config] of Object.entries(PROVIDERS)) {
    const present=Boolean(process.env[config.keyEnv]); if(present) configured++;
    add(`provider:${provider}`,'TECH',provider,'provider','core/llm/providers.ts',{configured:present,health:'Not probed',models:[...new Set(registry.list().map(a=>a.model).filter(m=>m.startsWith(`${provider}:`)))],latency:null,usage:null},present?'configured':'unconfigured','satellite','configuration');
  }
  const infra=[['connectors','APIs & Connectors','core/llm/providers.ts','Configured provider adapters'],['pipeline','Data Pipeline','knowledge/ingestion/ingest.ts','Ingestion, retrieval and research'],['security','Security Layer','governance/auth.ts','RBAC, approval and immutable audit'],['infrastructure','Scalable Infrastructure','core/db/client.ts','Local PostgreSQL and Node.js runtime'],['deployment','Global Deployment','package.json','No deployment source configured']];
  for(const [id,label,sourceRef,description] of infra) add(`infra:${id}`,'CORE',label!,'infrastructure',sourceRef!,{description},id==='deployment'?'unconfigured':'registered');
  const status:Projection['status']={systemHealth:'UNKNOWN',agentsOnline:metric(null,'agent_runs','COUNT(DISTINCT registered agent_name) WHERE status=pending'),agentsTotal:metric(registry.list().length,'agents/*.agent.md','AgentRegistry.list().length'),workflowsActive:metric(null,'workflow_runs',"COUNT(*) WHERE status='running'"),knowledgeNodes:metric(null,'canonical_prompts + modules','COUNT(current version of each slug)'),researchTasksOpen:metric(null,'research_projects',"COUNT(*) WHERE status='open'"),recordsProjectsOpen:metric(null,'releases',"COUNT(*) WHERE status NOT IN ('released','cancelled')"),apiConnections:metric(configured,'core/llm/providers.ts','Count adapters with configured credentials','Configured does not imply connected or healthy'),uptimePercent:metric(null,'No uptime monitor','Unavailable','Not measured'),generatedAt};
  let available=false; let failedRuns=0;
  try {
    await sql.begin('read only',async tx=>{
      await tx`set local role xyp_readonly`;
      const [counts]=await tx<{agents:string[];workflows:number;knowledge:number;research:number;records:number;failures:number}[]>`
      select coalesce((select array_agg(distinct agent_name) from agent_runs where status='pending'),'{}') as agents,
      (select count(*)::int from workflow_runs where status='running') as workflows,
      ((select count(distinct slug) from canonical_prompts)+(select count(distinct slug) from modules))::int as knowledge,
      (select count(*)::int from research_projects where status='open') as research,
      (select count(*)::int from releases where status not in ('released','cancelled')) as records,
      (select count(*)::int from agent_runs where status='error' and created_at>now()-interval '15 minutes') as failures`;
      status.agentsOnline.value=counts!.agents.filter(n=>registry.get(n)).length; status.workflowsActive.value=counts!.workflows; status.knowledgeNodes.value=counts!.knowledge;status.researchTasksOpen.value=counts!.research;status.recordsProjectsOpen.value=counts!.records;failedRuns=counts!.failures;
      const recent=await tx<Record<string,unknown>[]>`select id,agent_name,domain::text,status::text,created_at as timestamp,latency_ms from agent_runs order by created_at desc limit 100`;
      for(const a of nodes.filter(n=>n.entityType==='agent')) {
        const runs=recent.filter(r=>r.agent_name===a.metadata.name);
        a.status=counts!.agents.includes(String(a.metadata.name))?'pending':runs[0]?String(runs[0].status):'unknown';
        a.metadata.recentRuns=runs.slice(0,5).map(r=>({id:r.id,status:r.status,timestamp:r.timestamp,latencyMs:r.latency_ms,sourceRef:`agent_runs:${String(r.id)}`}));
      }
      for(const r of recent) events.push(activityEvent('agent_runs',r,isDomain(r.domain)?r.domain:'CORE'));
      const specs=[
        {table:'sources',domain:'KNOWLEDGE' as Domain,type:'source',query:'select id,title as label,kind::text,created_at from sources order by created_at desc limit 201'},
        {table:'modules',domain:'KNOWLEDGE' as Domain,type:'knowledge',query:"select distinct on(slug) id,title as label,version,source_id,created_at from modules order by slug,version desc limit 201"},
        {table:'canonical_prompts',domain:'KNOWLEDGE' as Domain,type:'knowledge',query:"select distinct on(slug) id,title as label,version,source_id,model_tag,created_at from canonical_prompts order by slug,version desc limit 201"},
        {table:'research_projects',domain:'RESEARCH_INTELLIGENCE' as Domain,type:'research',query:'select id,title as label,status::text,created_at from research_projects order by created_at desc limit 201'},
        {table:'research_findings',domain:'RESEARCH_INTELLIGENCE' as Domain,type:'research',query:"select id,claim as label,confidence,model_tag,created_at from research_findings order by created_at desc limit 201"},
        {table:'releases',domain:'RECORDS' as Domain,type:'record',query:'select id,title as label,status::text,release_date,upc,created_at from releases order by created_at desc limit 201'},
        {table:'tracks',domain:'RECORDS' as Domain,type:'record',query:'select id,title as label,isrc,release_id,mix_report_id,created_at from tracks order by created_at desc limit 201'},
        {table:'rd_backlog',domain:'TECH' as Domain,type:'tech',query:'select id,title as label,status,source_id,created_at from rd_backlog order by created_at desc limit 201'},
      ];
      if(identity.permissions.includes('governance.read')) specs.push({table:'approval_queue',domain:'GOVERNANCE',type:'approval',query:"select id,item_type::text as label,status::text,requested_at as created_at,decided_by from approval_queue order by requested_at desc limit 201"},{table:'governance_flags',domain:'GOVERNANCE',type:'governance',query:"select id,kind as label,source_ref,case when result->>'status' in ('flagged','no-rule-violations','conflict','requires-human-review') then result->>'status' else 'unknown' end as status,case when jsonb_typeof(result->'flags')='array' then jsonb_array_length(result->'flags') else null end as flag_count,created_at from governance_flags order by created_at desc limit 201"});
      for(const spec of specs){const rows=await tx.unsafe<Record<string,unknown>[]>(spec.query);if(rows.length>200)truncated.push(spec.table); for(const row of rows.slice(0,200)) add(`${spec.table}:${String(row.id)}`,spec.domain,String(row.label).slice(0,140),spec.type,`${spec.table}:${String(row.id)}`,{...row,query:spec.query},String(row.status??'recorded'),'satellite','database');}
      const relationRows=await tx<{id:string;subject_type:string;subject_id:string;object_type:string;object_id:string}[]>`select id,subject_type::text,subject_id,object_type::text,object_id from relations order by id limit 1001`;
      if(relationRows.length>1000)truncated.push('relations');
      const prefixes:Record<string,string>={source:'sources',module:'modules',canonical_prompt:'canonical_prompts',agent:'agent',workflow:'workflow'};
      for(const r of relationRows.slice(0,1000)) if(prefixes[r.subject_type]&&prefixes[r.object_type]) edges.push({id:`relation:${r.id}`,fromId:`${prefixes[r.subject_type]}:${r.subject_id}`,toId:`${prefixes[r.object_type]}:${r.object_id}`,relation:'knowledge',status:'recorded',sourceRef:`relations:${r.id}`});
      const workRuns=await tx<Record<string,unknown>[]>`select id,workflow_name,status::text,created_at as timestamp from workflow_runs order by created_at desc limit 30`;
      for(const r of workRuns){events.push(activityEvent('workflow_runs',r,'CORE'));const node=nodes.find(n=>n.id===`workflow:${String(r.workflow_name)}`);if(node){(node.metadata.recentExecutions as unknown[]).push(r);if(node.status==='registered')node.status=String(r.status);}}
      const kv=await tx<Record<string,unknown>[]>`select id,canonical_id,version,created_at as timestamp from knowledge_versions order by created_at desc limit 30`;
      for(const r of kv)events.push(activityEvent('knowledge_versions',r,'KNOWLEDGE'));
      const research=await tx<Record<string,unknown>[]>`select id,status::text,created_at as timestamp from research_runs order by created_at desc limit 30`;
      for(const r of research)events.push(activityEvent('research_runs',r,'RESEARCH_INTELLIGENCE'));
      if(identity.permissions.includes('governance.read')){const audits=await tx<Record<string,unknown>[]>`select id,table_name,row_id,op,at as timestamp from audit_log order by at desc limit 30`; for(const r of audits)events.push(activityEvent('audit_log',r,'GOVERNANCE'));}
      available=true;
    });
  }catch {
    available=false;
    errors.push('Runtime database projection unavailable');
    for(let i=nodes.length-1;i>=0;i--)if(nodes[i]!.sourceType==='database')nodes.splice(i,1);
    for(let i=edges.length-1;i>=0;i--)if(edges[i]!.sourceRef.startsWith('relations:'))edges.splice(i,1);
    events.length=0;truncated.length=0;
    for(const key of ['agentsOnline','workflowsActive','knowledgeNodes','researchTasksOpen','recordsProjectsOpen'] as const)status[key].value=null;
    for(const node of nodes){if(node.entityType==='agent'){node.status='unknown';node.metadata.recentRuns=[];}if(node.entityType==='workflow'){node.status='registered';node.metadata.recentExecutions=[];}}
  }
  errors.push(...registry.validateAll().map(f=>`Registry rejected ${relative(REPO_ROOT,f.path)}`));
  const ids=new Set(nodes.map(n=>n.id));
  for(const node of nodes.filter(n=>n.kind!=='hub'))edges.push({id:`owner:${node.id}`,fromId:node.kind==='domain'?'hub:xyp3rn':`domain:${node.domain}`,toId:node.id,relation:'ownership',status:'registered',sourceRef:node.kind==='domain'?'core/contracts/taxonomy.ts':node.sourceRef});
  status.systemHealth=evaluateHealth(available,errors.length,failedRuns);
  return {nodes,edges:edges.filter(e=>ids.has(e.fromId)&&ids.has(e.toId)),events:events.sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,50),status,identity,version,domains:DOMAINS.map(id=>({id,...DOMAIN_META[id]})),errors,generatedAt,truncated};
};
