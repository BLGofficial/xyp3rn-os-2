import { NextResponse, type NextRequest } from 'next/server';
import { guard, json } from '../../../../lib/http';
import { availableVoices } from '../../../../lib/kokoro';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** GET /api/speech/voices → { voices } allowlisted and installed in the local Kokoro service. */
export async function GET(request:NextRequest){
  const identity=await guard(request,'system.read');if(identity instanceof NextResponse)return identity;
  const voices=await availableVoices();
  return voices?json({voices}):json({error:'Speech service unavailable'},503);
}
