import { relayVoice } from '../../../../server/voice-relay';

// Jarvis's voice status for the browser (the agent ring). The middleware has already required the owner session.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (req: Request): Promise<Response> => relayVoice(req.signal);
