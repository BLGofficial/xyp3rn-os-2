import { join } from 'node:path';
import type postgres from 'postgres';
import { connect, databaseUrl, quoteIdent, type Sql } from '../../core/db/client.ts';
import { loadMigrations, migrateUp, type Migration } from '../../core/db/migrate.ts';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const SUPABASE_DIR = join(REPO_ROOT, 'supabase');

export const plan = (): Migration[] => loadMigrations(SUPABASE_DIR);

export type TestDb = { readonly sql: Sql; readonly name: string; readonly drop: () => Promise<void> };

/**
 * Creates a throwaway database so test files never share state (vitest runs files in parallel).
 * Created from template1, which carries the emulated Supabase default privileges
 * (supabase/local/setup.sh) — so migrations are tested against the real risk surface.
 * Local-only: CREATE DATABASE isn't available on hosted Supabase.
 * @param label - short unique suffix per test file
 * @param options - `migrated: true` applies every migration before returning
 */
export const createTestDb = async (
  label: string,
  options: { migrated?: boolean } = {},
): Promise<TestDb> => {
  const name = `xyp_test_${label}`;
  const admin = connect(databaseUrl(), { max: 1 });
  await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
  await admin.unsafe(`create database ${quoteIdent(name)} template template1`);
  await admin.end();

  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  const sql = connect(url.toString());
  if (options.migrated) await migrateUp(sql, plan());

  const drop = async () => {
    await sql.end();
    const a = connect(databaseUrl(), { max: 1 });
    await a.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
    await a.end();
  };
  return { sql, name, drop };
};

const ROLLBACK = Symbol('rollback');

/**
 * Runs fn inside a transaction that is always rolled back.
 * @returns whatever fn returned
 */
export const withRollback = async <T>(
  sql: Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> => {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      out = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
};

/**
 * Runs fn as a different DB role inside a rolled-back transaction.
 * Grant/RLS tests use this: the role switch never leaks out of the transaction.
 */
export const asRole = <T>(
  sql: Sql,
  role: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> =>
  withRollback(sql, async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  });

/**
 * Asserts a statement fails with a specific SQLSTATE. Anything else (success, other code) fails the test.
 * @param run - thunk performing the statement
 * @param code - expected SQLSTATE, e.g. 23503 foreign_key_violation, 42501 insufficient_privilege
 * @returns the caught error for further assertions on message/detail
 */
export const expectPgError = async (
  run: () => Promise<unknown>,
  code: string,
): Promise<postgres.PostgresError> => {
  try {
    await run();
  } catch (e) {
    const err = e as postgres.PostgresError;
    if (err.code !== code) {
      throw new Error(`expected SQLSTATE ${code}, got ${err.code ?? 'non-pg error'}: ${err.message}`);
    }
    return err;
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
};
