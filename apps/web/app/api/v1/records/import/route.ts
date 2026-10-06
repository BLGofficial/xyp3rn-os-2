import { extname } from 'node:path';
import { ops, runtime as getRuntime } from '../../../../../lib/server';
import { NO_STORE, recordsDirs, saveCopy } from '../../_lib';

// POST /api/v1/records/import: the Track Library's imports (multipart `files`, one `destination`).
//   records  → audio into the Creative Vault, titled, tagged demo or release; plays through /vault/files/{id}/raw
//   lyrics   → lyric sheets into the Vault (each becomes a lyric lineage), plus a readable copy in <records>/lyrics
//   metadata → documents into the Vault, plus a readable copy in <records>/metadata
// Behind the session check (middleware.ts); same-origin only, like /api/tasks.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ACCEPT = {
  records: ['.wav', '.mp3', '.flac', '.m4a', '.aiff', '.ogg'],
  lyrics: ['.txt', '.md'],
  metadata: ['.json', '.csv', '.txt', '.md', '.yaml', '.yml', '.xml', '.pdf', '.docx'],
} as const;
type Destination = keyof typeof ACCEPT;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function POST(req: Request): Promise<Response> {
  let sameOrigin = false;
  try { sameOrigin = new URL(req.headers.get('origin') ?? '').host === req.headers.get('host'); } catch { /* no or opaque origin: refuse */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: 'Send the files as multipart form data.' }, 400); }

  const destination = String(form.get('destination') ?? '') as Destination;
  if (!(destination in ACCEPT)) return json({ error: 'destination must be records, lyrics or metadata.' }, 400);
  const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && f.size > 0);
  if (files.length === 0) return json({ error: 'Choose at least one file.' }, 400);
  const tooBig = files.find((f) => f.size > MAX_FILE_BYTES);
  if (tooBig) return json({ error: `${tooBig.name} is ${mb(tooBig.size)}; the limit is ${mb(MAX_FILE_BYTES)} per file.` }, 413);
  const wrong = files.find((f) => !(ACCEPT[destination] as readonly string[]).includes(extname(f.name).toLowerCase()));
  if (wrong) return json({ error: `${wrong.name}: ${destination} accepts ${ACCEPT[destination].join(', ')}.` }, 415);

  const title = String(form.get('title') ?? '').trim();
  const trackType = form.get('trackType') === 'release' ? 'release' : 'demo';
  const language = String(form.get('language') ?? '').trim();
  if (destination === 'records' && !title) return json({ error: 'Enter a track title.' }, 400);
  if (destination === 'lyrics' && !language) return json({ error: 'Choose the lyrics language.' }, 400);

  try {
    const deps = (await getRuntime()).deps; const o = await ops(); const dirs = recordsDirs();
    const saved = [];
    for (const [i, f] of files.entries()) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const [r] = await o.uploadFiles(deps, [{ name: f.name, bytes }], destination === 'records'
        ? { as: 'audio', title: files.length === 1 ? title : `${title} ${i + 1}`, tags: [trackType] }
        : destination === 'lyrics' ? { as: 'lyric_sheet', language, tags: ['lyrics'] } : { as: 'document', tags: ['metadata'] });
      const copy = destination === 'records' ? null : await saveCopy(destination === 'lyrics' ? dirs.lyrics : dirs.metadata, f.name, bytes);
      saved.push({ id: r!.file.sourceId, name: f.name, size: f.size, savedTo: copy, lineageId: r!.lyrics?.lineageId ?? null });
    }
    const where = destination === 'records' ? 'the Creative Vault' : destination === 'lyrics' ? dirs.lyrics : dirs.metadata;
    return json({ message: `Saved to ${where}`, files: saved });
  } catch (e) {
    console.error('records import failed:', e);
    return json({ error: `Import failed: ${(e as Error).message}` }, 422);
  }
}
