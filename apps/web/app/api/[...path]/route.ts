import type { NextRequest } from 'next/server';
import { sql } from '../../../lib/db';
import { bodyOf, json, sameOrigin, tokenOf } from '../../../lib/http';
import { buildProjection } from '../../../lib/projection';
import { authenticate, decideAuthenticated, requirePermission } from '../../../../../governance/auth';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const attempts=new Map<string,{count:number;until:number}>();

export async function GET(request:NextRequest){
  try{
    const identity=await authenticate(sql,tokenOf(request));if(!identity)return json({error:'Authentication required'},401);
    const path=request.nextUrl.pathname;
    if(path==='/api/session')return json({identity});
    if(path==='/api/projection')return json(await buildProjection(sql,identity));
    if(path.startsWith('/api/ask/')){
      // Run status for the caller's own request; other users' request ids are indistinguishable from unknown ones.
      try{requirePermission(identity,'runtime.execute');}catch{return json({error:'Forbidden'},403);}
      const job=(await import('../../../lib/ask-jobs')).findJob(identity.id,path.slice('/api/ask/'.length));
      return job?json(job.view):json({error:'Unknown or expired request'},404);
    }
    return json({error:'Not found'},404);
  }catch{return json({error:'Service unavailable'},503);}
}

export async function POST(request:NextRequest){
  if(!sameOrigin(request))return json({error:'Same-origin request required'},403);
  try{
    const path=request.nextUrl.pathname;
    const input=await bodyOf(request);
    if(path==='/api/session'){
      const key=request.headers.get('x-forwarded-for')??'local';const now=Date.now();
      for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);
      if(attempts.size>1024)return json({error:'Try again later'},429);
      const entry=attempts.get(key)??{count:0,until:now+60000};entry.count++;attempts.set(key,entry);if(entry.count>8)return json({error:'Try again later'},429);
      const token=typeof input.token==='string'?input.token:'';const identity=await authenticate(sql,token);
      if(!identity)return json({error:'Invalid or expired token'},401);
      attempts.delete(key);const response=json({identity});response.cookies.set('mercury_session',token,{httpOnly:true,sameSite:'strict',secure:request.nextUrl.protocol==='https:',path:'/',maxAge:8*60*60});return response;
    }
    const token=tokenOf(request);const identity=await authenticate(sql,token);if(!identity)return json({error:'Authentication required'},401);
    if(path==='/api/logout'){
      // Logout clears browser access. Session expiry and operator revocation remain authoritative.
      const response=json({ok:true});response.cookies.set('mercury_session','',{maxAge:0,path:'/'});return response;
    }
    if(path==='/api/health-check'){
      requirePermission(identity,'runtime.execute');
      const {createRuntimeDeps}=await import('../../../../../core/runtime/deps');const {dispatch}=await import('../../../../../core/orchestrator/dispatch');
      const result=await dispatch(createRuntimeDeps(sql),'health-check',{origin:'mercury-command-center'});return json({runId:result.runId,status:result.status,latencyMs:result.latencyMs});
    }
    if(path==='/api/ask'){
      // Explicit Send from Mercury (typed, pasted or Wispr-dictated text). Same front door as `pnpm ask`:
      // planRequest → runPlan → domain entrypoint (dispatch still authorizes every agent tool).
      // No domain-level permissions exist in the role table; runtime.execute is the execution gate.
      requirePermission(identity,'runtime.execute');
      const request=typeof input.request==='string'?input.request.trim():'';
      const requestId=typeof input.requestId==='string'?input.requestId:'';
      const projectSlug=input.projectSlug===undefined?'ad-hoc':input.projectSlug;
      if(!request||request.length>4000)return json({error:'request must be 1-4000 characters'},400);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))return json({error:'requestId must be a UUID'},400);
      if(typeof projectSlug!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectSlug))return json({error:'projectSlug must be a lowercase slug'},400);
      const {ENTRYPOINTS,planRequest}=await import('../../../../../core/orchestrator/orchestrate');const {formatReply,refsOf,runPlan}=await import('../../../../../core/orchestrator/ask');
      const {createJob,findJob,MAX_RUNNING_PER_USER}=await import('../../../lib/ask-jobs');const {createRuntimeDeps}=await import('../../../../../core/runtime/deps');
      // From here to createJob there is no await: a duplicate submission cannot slip in and start a second run.
      const fingerprint=`${projectSlug}\n${request}`;const existing=findJob(identity.id,requestId);
      if(existing){if(existing.fingerprint!==fingerprint)return json({error:'requestId already used for a different request'},409);return json({...existing.view,duplicate:true},existing.view.state==='running'?202:200);}
      const plan=planRequest(request,ENTRYPOINTS);const route={status:plan.route.status,...('domain' in plan.route?{domain:plan.route.domain}:{})};
      if(plan.action==='hold'||plan.action==='clarify'){const job=createJob(identity.id,requestId,fingerprint,{requestId,state:'done',action:plan.action,route,status:plan.action,reply:formatReply(plan)});return typeof job==='string'?json({error:'Too many requests; try again later'},429):json(job.view);}
      const job=createJob(identity.id,requestId,fingerprint,{requestId,state:'running',action:plan.action,route,status:'running',reply:'Working. The run is still in progress.'},
        async()=>{const outcome=await runPlan(createRuntimeDeps(sql),plan,{projectSlug});const refs=refsOf(outcome);return {requestId,state:'done',action:plan.action,route,status:outcome.result.status,reply:formatReply(plan,outcome),refs,approvalRequired:refs.approvalIds.length>0};},
        ()=>({requestId,state:'done',action:plan.action,route,status:'error',reply:'The request failed before completing. It was not retried; check Live Events for any runs it started.'}));
      if(job==='busy')return json({error:`At most ${MAX_RUNNING_PER_USER} requests may run at once; wait for one to finish`},429);
      if(job==='full')return json({error:'Too many requests; try again later'},429);
      return json(job.view,202);
    }
    if(path==='/api/trace'){
      requirePermission(identity,'trace.write');const {createRuntimeDeps}=await import('../../../../../core/runtime/deps');const {ingestTrace}=await import('../../../../../tech/trace/intake');
      return json(await ingestTrace(createRuntimeDeps(sql),input),201);
    }
    if(path==='/api/approvals'){
      requirePermission(identity,'approval.decide');if(typeof input.id!=='string'||!['approve','reject'].includes(String(input.decision))||typeof input.reason!=='string'||!input.reason.trim())return json({error:'id, decision and reason required'},400);
      return json(await decideAuthenticated(sql,token,input.id,String(input.decision),input.reason));
    }
    return json({error:'Not found'},404);
  }catch(error){const forbidden=error instanceof Error&&error.message==='Forbidden';return json({error:forbidden?'Forbidden':'Request could not be completed; verify the input and current source state'},forbidden?403:400);}
}
