'use server';

import { attempt, text } from '../action-kit';
import { osOps, runtime } from '../../lib/server';

// /os writes (F54). The Obsidian sync applies only the plan the owner previewed: its hash comes from the form,
// and the sync re-plans and refuses on any change. The receipt comes back as counts; the first failure, if any,
// as the page's error. Every step is an agent run, listed on /system and in the HUD's activity.

export async function applyObsidianSync(form: FormData) {
  // The failure path carries no #fragment: back() appends ?error= to it, which must stay in the query.
  return attempt('/os', async () => (await osOps()).syncObsidian((await runtime()).deps, process.env, text(form, 'planHash')), (r) => {
    const q = new URLSearchParams({ synced: '1', imported: String(r.imported.length), exported: String(r.exported.length), failed: String(r.failed.length) });
    if (r.failed[0]) q.set('error', `${r.failed[0].rel}: ${r.failed[0].error}`);
    return `/os?${q.toString()}#obsidian`;
  });
}
