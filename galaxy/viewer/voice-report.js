// Reports the viewer's voice state to the galaxy server (POST /voice/status), so other faces (the HUD globe)
// can show it. The server owns `seq`; this file only says what the browser knows: listening, speaking, idle.
const STATUSES = ['idle', 'listening', 'thinking', 'speaking', 'error'];
const LEVEL_STEP = 0.05;   // under this, a level change is noise and costs a request

/** @param {unknown} n @returns {number} n limited to 0..1; anything that is not a finite number is 0 */
export const clampLevel = n => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Loudness of a Web Audio time-domain frame (bytes centred on 128) as 0..1.
 * The default gain is a guess for speech, which sits well under full scale; tune it against real playback.
 * @param {ArrayLike<number>} samples @param {number} [gain]
 */
export function rmsLevel(samples, gain = 3) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = (samples[i] - 128) / 128; sum += v * v; }
  return clampLevel(Math.sqrt(sum / samples.length) * gain);
}

/**
 * Build a reporter. Status changes go out at once; level moves inside one status are rate-limited and ignored when
 * tiny. One request is in flight at a time and only the newest waiting one follows, so the server never hears an
 * older state after a newer one. A failed post never throws, and is retried by the next identical report.
 * @param {{post:(ev:{status:string,level:number})=>unknown, now?:()=>number, levelGapMs?:number, enabled?:boolean}} opts
 */
export function createVoiceReporter({ post, now = () => Date.now(), levelGapMs = 100, enabled = true }) {
  let latest = null, lastAt = -Infinity, inflight = false, pending = null;

  function send(ev) {
    inflight = true;
    let p;
    try { p = Promise.resolve(post(ev)); } catch { p = Promise.reject(new Error('post threw')); }
    p.catch(() => { if (latest === ev && !pending) latest = null; })   // the server never heard it: next report goes again
      .then(() => {
        inflight = false;
        if (pending) { const next = pending; pending = null; send(next); }
      });
  }

  return {
    /** @param {string} status @param {number} [level] */
    report(status, level = 0) {
      if (!enabled || !STATUSES.includes(status)) return;
      const lv = clampLevel(level);
      if (latest && latest.status === status) {
        if (Math.abs(lv - latest.level) < LEVEL_STEP || now() - lastAt < levelGapMs) return;
      }
      const ev = { status, level: lv };
      latest = ev; lastAt = now();
      if (inflight) pending = ev; else send(ev);
    },
  };
}

/** @param {typeof fetch} fetchImpl @returns {(ev:{status:string,level:number})=>Promise<void>} */
export const postVoiceStatus = fetchImpl => async ev => {
  const res = await fetchImpl('/voice/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev), keepalive: true,
  });
  if (!res.ok) throw new Error(`voice status refused: ${res.status}`);
};

const NO_METER = { stop() {} };

/**
 * Sample the loudness of an <audio> element while it plays. Routing an element through Web Audio silences it if the
 * context is not running, so the element is only touched once the context is confirmed running; otherwise no meter.
 * Never throws: the voice must keep working without a level.
 * @param {{audio:HTMLAudioElement, AudioContextCtor?:new()=>any, onLevel:(l:number)=>void, intervalMs?:number, gain?:number}} opts
 * @returns {Promise<{stop:()=>void}>}
 */
export async function createLevelMeter({ audio, AudioContextCtor, onLevel, intervalMs = 100, gain = 3 }) {
  if (!AudioContextCtor) return NO_METER;
  let ctx;
  try {
    ctx = new AudioContextCtor();
    if (ctx.state !== 'running') await ctx.resume();
    if (ctx.state !== 'running') { ctx.close?.(); return NO_METER; }
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);   // the element is now only audible through this path
    const frame = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => { analyser.getByteTimeDomainData(frame); onLevel(rmsLevel(frame, gain)); }, intervalMs);
    return { stop() { clearInterval(timer); try { ctx.close?.(); } catch {} } };
  } catch {
    try { ctx?.close?.(); } catch {}
    return NO_METER;
  }
}
