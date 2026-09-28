import { NextResponse, type NextRequest } from 'next/server';
import { guard, json } from '../../../../lib/http';
import { speechReady } from '../../../../lib/kokoro';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** GET /api/speech/status → { ready } for the local Kokoro service. */
export async function GET(request:NextRequest){
  const identity=await guard(request,'system.read');if(identity instanceof NextResponse)return identity;
  return json({ready:await speechReady()});
}
