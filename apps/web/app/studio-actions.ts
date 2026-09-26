'use server';

import { attempt, local, opt, text } from './action-kit';
import { ops, runtime, studioOps } from '../lib/server';

// Studio's writes (AOS-03 §6), each an agent run or build-suno-package through
// apps/web/server/studio-ops.ts. A refusal (the agent's or the DB's reason) comes back as ?error=.

const deps = async () => (await runtime()).deps;
const fileOf = (f: FormData, k: string): File | null => {
  const v = f.get(k);
  return typeof v === 'object' && v !== null && 'arrayBuffer' in v && (v as File).size > 0 ? (v as File) : null;
};

export async function recipeAction(form: FormData) {
  const parentId = opt(form, 'parentId');
  return attempt(local(text(form, 'back'), '/studio'), async () => {
    const so = await studioOps();
    return so.writeRecipe(await deps(), {
      name: text(form, 'name'), style: text(form, 'style'), excludeStyles: so.list(text(form, 'excludeStyles')), mood: so.list(text(form, 'mood')),
      production: so.list(text(form, 'production'), 'lines'), notes: so.list(text(form, 'notes'), 'lines'), ...(parentId ? { parentId } : {}),
    });
  }, (r) => `/studio/recipes/${r.lineageId}`);
}

export async function tagSetAction(form: FormData) {
  const parentId = opt(form, 'parentId');
  return attempt(local(text(form, 'back'), '/studio'), async () => {
    const so = await studioOps();
    const sections = so.tagSections((k) => (form.get(k) === null ? null : String(form.get(k))));
    return so.writeTagSet(await deps(), { name: text(form, 'name'), sections, notes: so.list(text(form, 'notes'), 'lines'), ...(parentId ? { parentId } : {}) });
  }, (r) => `/studio/tags/${r.lineageId}`);
}

export async function defaultTagSetAction() {
  return attempt('/studio', async () => (await studioOps()).defaultTagSet(await deps()), (r) => `/studio/tags/${r.lineageId}`);
}

export async function decideStudioVersion(form: FormData) {
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'reject';
  return attempt(local(text(form, 'back'), '/studio'), async () => {
    const rt = await runtime();
    return (await ops()).decide(rt.sql, text(form, 'artifactId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function buildPackageAction(form: FormData) {
  const songId = text(form, 'songId');
  return attempt(`/songs/${songId}`, async () => (await studioOps()).buildPackage(await deps(), {
    songId, lyricsArtifactId: text(form, 'lyricsArtifactId'), styleRecipeArtifactId: text(form, 'styleRecipeArtifactId'),
    tagSetArtifactId: text(form, 'tagSetArtifactId'), title: text(form, 'title'), sunoModel: text(form, 'sunoModel'),
  }), (r) => `/studio/packages/${r.packageId}`);
}

export async function handOffAction(form: FormData) {
  const packageId = text(form, 'packageId');
  return attempt(`/studio/packages/${packageId}`, async () => (await studioOps()).handOff(await deps(), packageId));
}

export async function importTakeAction(form: FormData) {
  const packageId = text(form, 'packageId');
  const title = opt(form, 'title');
  return attempt(`/studio/packages/${packageId}`, async () => {
    const audio = fileOf(form, 'audio');
    if (!audio) throw new Error('choose the audio file Suno generated');
    return (await studioOps()).importTake(await deps(), {
      submissionId: text(form, 'submissionId'), upload: { name: audio.name, bytes: new Uint8Array(await audio.arrayBuffer()) },
      ...(title ? { title } : {}),
    });
  });
}

export async function rateTakeAction(form: FormData) {
  const packageId = text(form, 'packageId');
  const keep = opt(form, 'keep');
  const change = opt(form, 'change');
  return attempt(`/studio/packages/${packageId}`, async () => (await studioOps()).rateTake(await deps(), {
    takeId: text(form, 'takeId'), rating: Number(text(form, 'rating')), ...(keep ? { keep } : {}), ...(change ? { change } : {}),
  }));
}
