import { join } from 'node:path';
import { connect } from './client.ts';
import { appliedVersions, loadMigrations, migrateDown, migrateUp } from './migrate.ts';

// Usage: node core/db/cli.ts <up|down [steps]|status>  (targets XYP_DATABASE_URL, default local)

const SUPABASE_DIR = join(import.meta.dirname, '..', '..', 'supabase');

const main = async (cmd: string | undefined, arg: string | undefined): Promise<void> => {
  const migrations = loadMigrations(SUPABASE_DIR);
  const sql = connect(undefined, { max: 1 });
  try {
    if (cmd === 'up') {
      const applied = await migrateUp(sql, migrations);
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    } else if (cmd === 'down') {
      const steps = arg === undefined ? 1 : arg === 'all' ? Number.POSITIVE_INFINITY : Number(arg);
      if (!Number.isInteger(steps) && steps !== Number.POSITIVE_INFINITY) throw new Error(`bad steps: ${arg}`);
      const rolled = await migrateDown(sql, migrations, steps);
      console.log(rolled.length ? `rolled back: ${rolled.join(', ')}` : 'nothing to roll back');
    } else if (cmd === 'status') {
      const done = new Set(await appliedVersions(sql));
      for (const m of migrations) console.log(`${done.has(m.version) ? 'applied' : 'pending'}  ${m.version}_${m.name}`);
    } else {
      throw new Error('usage: cli.ts <up|down [steps|all]|status>');
    }
  } finally {
    await sql.end();
  }
};

await main(process.argv[2], process.argv[3]);
