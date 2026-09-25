'use server';

import { attempt, local, opt, text } from './action-kit';
import { catalogOps, runtime } from '../lib/server';

// The Command Center's writes (AOS-02 §6), each an agent run or a Records workflow through
// apps/web/server/catalog-ops.ts. A refusal (the agent's or the DB's reason) comes back as ?error=.

const deps = async () => (await runtime()).deps;
const fileOf = (f: FormData, k: string): File | null => {
  const v = f.get(k);
  return typeof v === 'object' && v !== null && 'arrayBuffer' in v && (v as File).size > 0 ? (v as File) : null;
};

/**
 * Split rows from a textarea, one per line: `<payee> <percentage>`; payee `unassigned` (or `-`) is
 * the explicit unassigned share.
 */
const parseSplits = (raw: string) =>
  raw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = /^(.*\S)\s+(\d+(?:\.\d{1,3})?)%?$/.exec(line);
    if (!m) throw new Error(`splits: "${line}" is not "<payee> <percentage>"`);
    const payee = m[1]!.trim();
    return { payee: ['unassigned', '-'].includes(payee.toLowerCase()) ? null : payee, percentage: Number(m[2]) };
  });

export async function registerTrackAction(form: FormData) {
  const releaseId = opt(form, 'releaseId');
  const songId = opt(form, 'songId');
  const from = releaseId ? `/releases/${releaseId}` : songId ? `/songs/${songId}` : '/releases';
  return attempt(from, async () => {
    const [kind, id] = text(form, 'recording').split(':');
    if ((kind !== 'take' && kind !== 'vault') || !id) throw new Error('choose a recording');
    const release = releaseId
      ? { id: releaseId }
      : { title: text(form, 'releaseTitle'), artist: text(form, 'releaseArtist') || 'X3LIUS', kind: text(form, 'releaseKind') || 'single' };
    const title = opt(form, 'title');
    return (await catalogOps()).registerTrack(await deps(), {
      ...(kind === 'take' ? { takeId: id } : { sourceId: id }), release, position: Number(text(form, 'position') || '1'),
      ...(title ? { title } : {}), ...(songId ? { songId } : {}),
    });
  }, (r) => `/releases/${r.releaseId}`);
}

export async function splitsAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => (await catalogOps()).writeSplits(await deps(), text(form, 'trackId'), parseSplits(String(form.get('splits') ?? ''))));
}

export async function codeAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => {
    const trackId = opt(form, 'trackId');
    return (await catalogOps()).assignCode(await deps(), trackId ? { trackId, isrc: text(form, 'code').toUpperCase().replaceAll('-', '') } : { releaseId, upc: text(form, 'code') });
  });
}

export async function creditAction(form: FormData) {
  const back = local(text(form, 'back'), '/');
  return attempt(back, async () => {
    const note = opt(form, 'note');
    const songId = opt(form, 'songId');
    const trackId = opt(form, 'trackId');
    return (await catalogOps()).credit(await deps(), {
      person: text(form, 'person'), role: text(form, 'role'), ...(songId ? { songId } : {}), ...(trackId ? { trackId } : {}), ...(note ? { note } : {}),
    });
  });
}

export async function uncreditAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/'), async () => (await catalogOps()).uncredit(await deps(), text(form, 'creditId'), text(form, 'reason')));
}

export async function linkAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => {
    const trackId = opt(form, 'trackId');
    return (await catalogOps()).link(await deps(), { ...(trackId ? { trackId } : { releaseId }), platform: text(form, 'platform'), url: text(form, 'url') });
  });
}

export async function unlinkAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => (await catalogOps()).unlink(await deps(), text(form, 'linkId'), text(form, 'reason')));
}

export async function artworkAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => {
    const f = fileOf(form, 'image');
    if (!f) throw new Error('choose an image');
    return (await catalogOps()).setArtwork(await deps(), releaseId, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  });
}

export async function deliveryAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => {
    const note = opt(form, 'note');
    return (await catalogOps()).recordDelivery(await deps(), { releaseId, distributor: text(form, 'distributor'), status: text(form, 'status'), ...(note ? { note } : {}) });
  });
}

export async function scheduleAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => (await catalogOps()).scheduleRelease(await deps(), { releaseId, releaseDate: text(form, 'releaseDate') }));
}

export async function releaseAction(form: FormData) {
  const releaseId = text(form, 'releaseId');
  return attempt(`/releases/${releaseId}`, async () => (await catalogOps()).markReleased(await deps(), releaseId));
}

export async function personAction(form: FormData) {
  return attempt('/people', async () => (await catalogOps()).addPerson(await deps(), text(form, 'name')));
}

export async function aliasAction(form: FormData) {
  return attempt('/people', async () => (await catalogOps()).addAlias(await deps(), text(form, 'personId'), text(form, 'alias')));
}

export async function taskAction(form: FormData) {
  const back = local(text(form, 'back'), '/tasks');
  return attempt(back, async () => {
    const songId = opt(form, 'songId');
    const releaseId = opt(form, 'releaseId');
    const dueDate = opt(form, 'dueDate');
    return (await catalogOps()).createTask(await deps(), { title: text(form, 'title'), ...(songId ? { songId } : {}), ...(releaseId ? { releaseId } : {}), ...(dueDate ? { dueDate } : {}) });
  });
}

export async function moveTaskAction(form: FormData) {
  const back = local(text(form, 'back'), '/tasks');
  return attempt(back, async () => (await catalogOps()).moveTask(await deps(), text(form, 'taskId'), text(form, 'status'), opt(form, 'note')));
}
