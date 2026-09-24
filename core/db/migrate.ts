import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from './client.ts';

/**
 * Local migration runner. On a real Supabase project the Supabase CLI applies
 * supabase/migrations/ instead; this runner exists so up AND down can be tested
 * locally (the CLI has no down migrations).
 */

export type Migration = {
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
};

const MIGRATION_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const ROLLBACK_RE = /^(\d{14})_([a-z0-9_]+)\.down\.sql$/;

/**
 * Pairs migration files with rollback files. Pure: file names in, plan out.
 * Collects every problem before failing so one run reports them all.
 * @param migrationFiles - basenames in supabase/migrations/
 * @param rollbackFiles - basenames in supabase/rollbacks/
 * @param root - supabase/ directory used to build absolute paths
 * @returns migrations sorted by version
 * @throws Error listing every malformed name, missing rollback and orphan rollback
 */
export const planMigrations = (
  migrationFiles: readonly string[],
  rollbackFiles: readonly string[],
  root: string,
): Migration[] => {
  const problems: string[] = [];
  const rollbacks = new Set(rollbackFiles.filter((f) => ROLLBACK_RE.test(f)));
  for (const f of rollbackFiles) if (!ROLLBACK_RE.test(f)) problems.push(`malformed rollback name: ${f}`);

  const plan: Migration[] = [];
  for (const f of migrationFiles) {
    const m = MIGRATION_RE.exec(f);
    if (!m) {
      problems.push(`malformed migration name: ${f}`);
      continue;
    }
    const down = f.replace(/\.sql$/, '.down.sql');
    if (!rollbacks.has(down)) problems.push(`missing rollback for ${f} (expected rollbacks/${down})`);
    rollbacks.delete(down);
    plan.push({
      version: m[1]!,
      name: m[2]!,
      upPath: join(root, 'migrations', f),
      downPath: join(root, 'rollbacks', down),
    });
  }
  for (const orphan of rollbacks) problems.push(`rollback without migration: ${orphan}`);
  if (problems.length > 0) throw new Error(`migration plan invalid:\n- ${problems.join('\n- ')}`);
  return plan.sort((a, b) => a.version.localeCompare(b.version));
};

/**
 * Reads supabase/migrations + supabase/rollbacks from disk and plans them.
 * @param root - path to the supabase/ directory
 * @returns migrations sorted by version
 */
export const loadMigrations = (root: string): Migration[] =>
  planMigrations(
    readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')),
    readdirSync(join(root, 'rollbacks')).filter((f) => f.endsWith('.sql')),
    root,
  );

const ensureTracker = async (sql: Sql): Promise<void> => {
  await sql.unsafe(`
    create schema if not exists xyp_meta;
    create table if not exists xyp_meta.applied_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    );
  `);
};

/**
 * Lists versions already applied to the connected database.
 * @param sql - connected client
 * @returns applied versions, ascending
 */
export const appliedVersions = async (sql: Sql): Promise<string[]> => {
  await ensureTracker(sql);
  const rows = await sql<{ version: string }[]>`
    select version from xyp_meta.applied_migrations order by version`;
  return rows.map((r) => r.version);
};

/**
 * Applies every pending migration, each in its own transaction (file + tracker row commit together).
 * @param sql - connected client with DDL rights
 * @param migrations - plan from loadMigrations()
 * @returns versions applied by this call
 */
export const migrateUp = async (sql: Sql, migrations: readonly Migration[]): Promise<string[]> => {
  const done = new Set(await appliedVersions(sql));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    const body = readFileSync(m.upPath, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into xyp_meta.applied_migrations (version, name) values (${m.version}, ${m.name})`;
    });
    applied.push(m.version);
  }
  return applied;
};

/**
 * Rolls back applied migrations newest-first.
 * @param sql - connected client with DDL rights
 * @param migrations - plan from loadMigrations()
 * @param steps - how many applied migrations to roll back (default: all)
 * @returns versions rolled back by this call
 */
export const migrateDown = async (
  sql: Sql,
  migrations: readonly Migration[],
  steps: number = Number.POSITIVE_INFINITY,
): Promise<string[]> => {
  const done = new Set(await appliedVersions(sql));
  const targets = [...migrations].reverse().filter((m) => done.has(m.version)).slice(0, steps);
  for (const m of targets) {
    const body = readFileSync(m.downPath, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`delete from xyp_meta.applied_migrations where version = ${m.version}`;
    });
  }
  return targets.map((m) => m.version);
};
