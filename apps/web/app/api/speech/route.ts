import { NextResponse, type NextRequest } from 'next/server';
import { bodyOf, guard, json, sameOrigin } from '../../../lib/http';
import { MAX_SPEECH_CHARS, SPEED_RANGE, synthesize, validateSpeech } from '../../../lib/kokoro';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** POST /api/speech → complete audio/wav from local Kokoro. Voices reply text the signed-in user already sees. */
export async function POST(request:NextRequest){
  if(!sameOrigin(request))return json({error:'Same-origin request required'},403);
  const identity=await guard(request,'system.read');if(identity instanceof NextResponse)return identity;
  let input;try{input=validateSpeech(await bodyOf(request,16*1024));}catch{input=null;}
  if(!input)return json({error:`text (1-${MAX_SPEECH_CHARS} characters), a listed voice, speed ${SPEED_RANGE[0]}-${SPEED_RANGE[1]} and format wav required`},400);
  const result=await synthesize(input,request.signal);
  if(!result.ok)return json({error:result.error},result.status);
  return new NextResponse(result.wav,{headers:{'Content-Type':'audio/wav','Content-Length':String(result.wav.length),'Cache-Control':'no-store'}});
}
