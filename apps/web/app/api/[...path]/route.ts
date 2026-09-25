import { NextRequest, NextResponse } from 'next/server';
import { sql } from '../../../lib/db';
import { buildProjection } from '../../../lib/projection';
import { authenticate, decideAuthenticated, requirePermission } from '../../../../../governance/auth';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const attempts=new Map<string,{count:number;until:number}>();
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
const tokenOf=(request:NextRequest)=>request.cookies.get('mercury_session')?.value??'';
const bodyOf=async(request:NextRequest)=>{
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('JSON body required');
  const reader=request.body?.getReader();if(!reader)throw new Error('JSON body required');let size=0;const chunks:Uint8Array[]=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();throw new Error('Body exceeds 1 MB');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
};

export async function GET(request:NextRequest){
  try{
    const identity=await authenticate(sql,tokenOf(request));if(!identity)return json({error:'Authentication required'},401);
    const path=request.nextUrl.pathname;
    if(path==='/api/session')return json({identity});
    if(path==='/api/projection')return json(await buildProjection(sql,identity));
    return json({error:'Not found'},404);
  }catch{return json({error:'Service unavailable'},503);}
}

export async function POST(request:NextRequest){
  const origin=request.headers.get('origin');
  if(!origin || new URL(origin).host!==request.headers.get('host'))return json({error:'Same-origin request required'},403);
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
