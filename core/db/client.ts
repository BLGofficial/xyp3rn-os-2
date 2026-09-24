import postgres from 'postgres';

export type Sql = postgres.Sql;
/** Anything that can run a query: a pool, a transaction or a savepoint. */
export type Queryable = postgres.ISql;

/** Local-only default (supabase/local/setup.sh). Code never falls back to a remote project. */
export const DEFAULT_LOCAL_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

/**
 * Resolves the database URL for the current process.
 * @param env - environment to read XYP_DATABASE_URL from
 * @returns XYP_DATABASE_URL when set, otherwise the local default
 */
export const databaseUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.XYP_DATABASE_URL ?? DEFAULT_LOCAL_URL;

/**
 * Opens a postgres.js connection pool.
 * @param url - connection string; defaults to databaseUrl()
 * @param options - postgres.js options merged over the defaults
 * @returns a tagged-template SQL client; caller owns `.end()`
 */
export const connect = (url: string = databaseUrl(), options: postgres.Options<{}> = {}): Sql =>
  postgres(url, { max: 4, onnotice: () => {}, ...options });

/**
 * Quotes a SQL identifier. For the few places identifiers can't be bound as parameters
 * (SET ROLE, CREATE DATABASE).
 * @param name - raw identifier
 * @returns the identifier wrapped in double quotes with embedded quotes doubled
 */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
