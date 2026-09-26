import { parseArgs } from 'node:util';
import { connect } from '../../../core/db/client.ts';
import { packageText, readPackageExport } from '../suno/package-export.ts';

// The owner's Studio commands (AOS-03). Read-only, as xyp_web; every write is an agent run through
// `pnpm dispatch` / `pnpm workflow` (x3lius-studio-editor, build-suno-package, suno-submitter).
//   pnpm studio export <packageId>          xyp-suno-package/v1 as JSON: the Suno fields, each version with its
//                                            approval status, the workflow run, and what blocks the handoff
//   pnpm studio export <packageId> --text   the same as copy-paste blocks, one per field of Suno's form
// Exit codes: 2 usage, 1 no such package (or not a package).

const usage = (message: string): Error => Object.assign(new Error(message), { usage: true });
const isUsage = (e: unknown): boolean =>
  (e as { usage?: boolean }).usage === true || String((e as { code?: string }).code ?? '').startsWith('ERR_PARSE_ARGS');

const sql = connect(undefined, { max: 1 });
try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'export') throw usage(`unknown command ${cmd ?? '(none)'}: see the usage comment in records/x3lius/studio/cli.ts`);
  const { values, positionals } = parseArgs({ args: rest, options: { text: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (positionals.length !== 1) throw usage('expected <packageId>');
  const e = await sql.begin(async (tx) => {
    await tx`set local role xyp_web`;
    return readPackageExport(tx, positionals[0]!);
  });
  process.stdout.write(values.text ? packageText(e) : `${JSON.stringify(e, null, 2)}\n`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = isUsage(e) ? 2 : 1;
} finally {
  await sql.end();
}
