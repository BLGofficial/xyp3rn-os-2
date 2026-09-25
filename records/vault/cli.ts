import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { connect } from '../../core/db/client.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decideArtifact } from '../../governance/approvals.ts';
import { createLocalVaultStore, defaultVaultDir, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { exportVault } from '../../knowledge/vault-io/export.ts';
import { importVault } from '../../knowledge/vault-io/import.ts';
import { addAndImport } from './import.ts';
import { LYRIC_EDITOR_AGENT } from './lyric-editor.ts';
import { SONGS_AGENT } from './songs-agent.ts';

// The owner's Creative Vault commands (AOS-01). Every write is an agent run; approve/reject is the
// owner's decision (xyp_decide_artifact, as service_role). Prints JSON.
//   pnpm vault add <file> [--as <class>] [--title <t>] [--language <l>] [--tags a,b] [--song <songId>]
//                                    a lyric sheet (--as lyric_sheet) is also imported as a lyrics lineage
//   pnpm vault edit <artifactId> <file> [--language <l>]      the owner's text as the next lyrics version
//   pnpm vault approve|reject <artifactId> --reason "<why>" [--approver <name>]   (default XYP_OWNER, else "owner")
//   pnpm vault song create --title <t> --artist <a> [--language --genre --status --notes]
//   pnpm vault song revise <songId> [--title --artist --language --genre --status --notes]
//   pnpm vault song link <songId> --artifact|--file|--take|--track|--question <id> [--role <r>]
//   pnpm vault song unlink <linkId> --reason "<why>"
//   pnpm vault export <dir>          xyp-vault-export/v1: manifest.json, records.ndjson, blobs/ (an empty or new dir)
//   pnpm vault import <dir>          a restore into this database (identical rows skipped; any conflict refuses it all)
// Exit codes: 2 usage, 1 a refused or failed operation (the run row records why).
// The byte store is XYP_VAULT_DIR, default .vault/ at the repo root.

const usage = (message: string): Error => Object.assign(new Error(message), { usage: true });
const isUsage = (e: unknown): boolean =>
  (e as { usage?: boolean }).usage === true || String((e as { code?: string }).code ?? '').startsWith('ERR_PARSE_ARGS');

const s = { type: 'string' } as const;
const SONG_OPTIONS = { title: s, artist: s, language: s, genre: s, status: s, notes: s } as const;
const LINK_TARGETS = { artifact: 'artifactId', file: 'sourceId', take: 'takeId', track: 'trackId', question: 'researchQuestionId' } as const;

const parse = <O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O, positionals: readonly string[]) => {
  const r = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (r.positionals.length !== positionals.length) throw usage(`expected ${positionals.map((p) => `<${p}>`).join(' ') || 'no arguments'}`);
  return { values: r.values, positionals: r.positionals };
};

const run = async (deps: DispatchDeps, agent: string, input: unknown): Promise<unknown> => {
  const r = await dispatch(deps, agent, input);
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return r.output;
};

const song = async (deps: DispatchDeps, [sub, ...rest]: string[]): Promise<unknown> => {
  switch (sub) {
    case 'create':
      return run(deps, SONGS_AGENT, { create: parse(rest, SONG_OPTIONS, []).values });
    case 'revise': {
      const { values, positionals } = parse(rest, SONG_OPTIONS, ['songId']);
      return run(deps, SONGS_AGENT, { revise: { songId: positionals[0], ...values } });
    }
    case 'link': {
      const { values, positionals } = parse(rest, { artifact: s, file: s, take: s, track: s, question: s, role: s }, ['songId']);
      const given = (Object.keys(LINK_TARGETS) as (keyof typeof LINK_TARGETS)[]).filter((k) => values[k] !== undefined);
      if (given.length !== 1) throw usage(`song link needs exactly one of ${Object.keys(LINK_TARGETS).map((k) => `--${k}`).join(', ')}`);
      const k = given[0]!;
      return run(deps, SONGS_AGENT, { link: { songId: positionals[0], [LINK_TARGETS[k]]: values[k], ...(values.role ? { role: values.role } : {}) } });
    }
    case 'unlink': {
      const { values, positionals } = parse(rest, { reason: s }, ['linkId']);
      if (!values.reason) throw usage('song unlink needs --reason');
      return run(deps, SONGS_AGENT, { unlink: { linkId: positionals[0], reason: values.reason } });
    }
    default:
      throw usage(`unknown command: song ${sub ?? '(none)'}`);
  }
};

const main = async (deps: DispatchDeps, store: VaultStore, [cmd, ...rest]: string[]): Promise<unknown> => {
  switch (cmd) {
    case 'export':
      return exportVault(deps.sql, store, parse(rest, {}, ['dir']).positionals[0]!);
    case 'import':
      return importVault(deps.sql, store, parse(rest, {}, ['dir']).positionals[0]!);
    case 'add': {
      const { values, positionals } = parse(rest, { as: s, title: s, language: s, tags: s, song: s }, ['file']);
      return addAndImport(deps, {
        path: positionals[0]!,
        ...(values.as ? { as: values.as } : {}),
        ...(values.title ? { title: values.title } : {}),
        ...(values.language ? { language: values.language } : {}),
        ...(values.tags ? { tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
        ...(values.song ? { songId: values.song } : {}),
      });
    }
    case 'edit': {
      const { values, positionals } = parse(rest, { language: s }, ['artifactId', 'file']);
      const text = await readFile(positionals[1]!, 'utf8');
      return run(deps, LYRIC_EDITOR_AGENT, { edit: { parentId: positionals[0], text, ...(values.language ? { language: values.language } : {}) } });
    }
    case 'approve':
    case 'reject': {
      const { values, positionals } = parse(rest, { reason: s, approver: s }, ['artifactId']);
      if (!values.reason) throw usage(`${cmd} needs --reason: a decision is recorded with why`);
      return decideArtifact(deps.sql, positionals[0]!, { decision: cmd, approver: values.approver ?? process.env.XYP_OWNER ?? 'owner', reason: values.reason });
    }
    case 'song':
      return song(deps, rest);
    default:
      throw usage(`unknown command ${cmd ?? '(none)'}: see the usage comment in records/vault/cli.ts`);
  }
};

const sql = connect(undefined, { max: 2 });
try {
  const store = createLocalVaultStore(defaultVaultDir());
  const deps: DispatchDeps = {
    sql, registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') }), tools: createRuntimeTools({ sql, vault: store }), handlers: HANDLERS,
  };
  console.log(JSON.stringify(await main(deps, store, process.argv.slice(2)), null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = isUsage(e) ? 2 : 1;
} finally {
  await sql.end();
}
