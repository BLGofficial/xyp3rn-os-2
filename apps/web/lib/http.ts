import { NextResponse, type NextRequest } from 'next/server';
import { authenticate, requirePermission, type Identity } from '../../../governance/auth';
import { sql } from './db';

/** Mercury API conventions shared by the catch-all and dedicated route handlers. */
export const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
export const tokenOf=(request:NextRequest)=>request.cookies.get('mercury_session')?.value??'';
export const sameOrigin=(request:NextRequest)=>{const origin=request.headers.get('origin');try{return !!origin&&new URL(origin).host===request.headers.get('host');}catch{return false;}};
export const bodyOf=async(request:NextRequest,limit=1024*1024)=>{
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('JSON body required');
  const reader=request.body?.getReader();if(!reader)throw new Error('JSON body required');let size=0;const chunks:Uint8Array[]=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('Body too large');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
};

/** Session + permission for dedicated route handlers: the identity, or the error response to return. */
export const guard=async(request:NextRequest,permission:string):Promise<Identity|NextResponse>=>{
  let identity:Identity|null;
  try{identity=await authenticate(sql,tokenOf(request));}catch{return json({error:'Service unavailable'},503);}
  if(!identity)return json({error:'Authentication required'},401);
  try{requirePermission(identity,permission);}catch{return json({error:'Forbidden'},403);}
  return identity;
};
