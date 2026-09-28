'use server';

import { attempt } from './action-kit';
import { graphOps, runtime } from '../lib/server';

// The index's one owner write (AOS-04 Plan C1): Rescan on /system, as xyp_indexer through graph-ops. A failed scan
// is sealed `error` in index_scans and comes back as ?error=.

export async function rescanAction(form: FormData) {
  return attempt('/system', async () => {
    const r = await (await graphOps()).scanIndex((await runtime()).sql, 'owner', form.get('full') === 'on');
    if (r.status === 'error') throw new Error(`scan ${r.scanId} failed: ${r.error}`);
    return r;
  }, (r) => `/system?scan=${r.scanId}`);
}
