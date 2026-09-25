import { readFileSync } from 'node:fs';
import { connect } from '../../core/db/client.ts';
import { parseSplitsFile, replaceSplits } from './splits.ts';

// Operator access to Records ops (Phase 13; the UI is Phase 16):
//   pnpm records splits <trackId> <file.yaml>   — replace a track's rights splits (must total exactly 100)
// Scheduling decisions go through the approval queue: pnpm gate queue / pnpm gate decide.

const [cmd, trackId, file] = process.argv.slice(2);
const sql = connect();
try {
  if (cmd !== 'splits' || !trackId || !file) throw new Error('usage: pnpm records splits <trackId> <file.yaml>');
  const rows = parseSplitsFile(readFileSync(file, 'utf8'));
  const written = await replaceSplits(sql, trackId, rows);
  console.log(JSON.stringify({ trackId, written, splits: rows }, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
