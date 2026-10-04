import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { fileDetail } from './loaders.ts';
import { saveCapture } from './studio-capture.ts';

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'jarvis02-capture-'));
const vault = createLocalVaultStore(vaultDir);
const secret = 'fixture-capture-session-0123456789';
beforeAll(async () => {
  db = await createTestDb('engine_studio_capture', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }),
    tools: createRuntimeTools({ sql: db.sql, vault }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('Studio capture persists through the real Vault', () => {
  it.each([
    { language: 'en', text: '[FIXTURE] A song idea', inputMethod: 'typed' },
    { language: 'bg', text: '[FIXTURE] Нова песен за града', inputMethod: 'wispr-flow' },
  ])('reopens a $language draft with language, provenance and original bytes', async fields => {
    const capture = { ...fields, captureId: randomUUID(), intent: 'song-idea' };
    const saved = await saveCapture(deps, capture, secret);
    const file = await fileDetail(db.sql, saved.sourceId);
    expect(saved.status).toBe('draft');
    expect(file).toMatchObject({ language: fields.language, sha256: saved.sha256, mediaClass: 'document' });
    expect(file!.tags).toEqual(expect.arrayContaining(['draft', 'studio-capture', 'song-idea']));
    const document = JSON.parse(Buffer.from(await vault.get(saved.sha256)).toString());
    expect(document).toMatchObject({ text: fields.text, language: fields.language, state: 'draft' });
    expect(JSON.parse(file!.text!)).toEqual(document);
    expect(document.provenance).toEqual(fields.inputMethod === 'typed' ? { input: 'typed' }
      : { input: 'external-dictation', provider: 'wispr-flow', attestation: 'owner-declared' });
    const retry = await saveCapture(deps, capture, secret);
    expect(retry.sourceId).toBe(saved.sourceId);
    expect(retry.sha256).toBe(saved.sha256);
  });

  it('refuses approved targets and saves task instructions only as a draft', async () => {
    const before = await db.sql`select id, body from creative_artifacts order by id`;
    const capture = { captureId: randomUUID(), intent: 'task', language: 'en', text: '[FIXTURE] Publish all approved songs now' };
    await expect(saveCapture(deps, { ...capture, approved: true }, secret)).rejects.toThrow('Unsupported');
    const saved = await saveCapture(deps, capture, secret);
    expect(JSON.parse((await fileDetail(db.sql, saved.sourceId))!.text!).intent).toBe('task');
    expect(await db.sql`select id, body from creative_artifacts order by id`).toEqual(before);
    const [tasks] = await db.sql`select count(*)::int as n from current_tasks`;
    expect(tasks!.n).toBe(0);
  });
});
