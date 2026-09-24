import type { AgentContext } from '../../../core/orchestrator/dispatch.ts';

/** An upstream artifact as `read_artifact` returns it. */
export type ArtifactRow = { readonly id: string; readonly schemaId: string; readonly version: number; readonly body: Record<string, unknown> };

/** How an artifact a spec built on is recorded in its body (`sources`). */
export type ArtifactSource<R extends string> = { readonly role: R; readonly artifactId: string; readonly schemaId: string; readonly version: number };

/**
 * Reads an upstream artifact by id (`read_artifact`, capability artifact.read) and refuses one of
 * the wrong kind, so a spec never builds on, say, a genre target passed where a structure belongs.
 * @param ctx - the agent context
 * @param id - artifact id
 * @param expected - the schema ids this input may have
 * @returns the artifact row
 */
export const readArtifact = async (ctx: AgentContext, id: string, expected: readonly string[]): Promise<ArtifactRow> => {
  const a = (await ctx.useTool('read_artifact', { id })) as ArtifactRow;
  if (!expected.includes(a.schemaId)) throw new Error(`artifact ${id} is ${a.schemaId}, expected ${expected.join(' or ')}`);
  return a;
};

/**
 * @param role - what the artifact is to the spec reading it
 * @param a - the artifact row
 * @returns its `sources` entry
 */
export const sourceOf = <R extends string>(role: R, a: ArtifactRow): ArtifactSource<R> => ({ role, artifactId: a.id, schemaId: a.schemaId, version: a.version });

/**
 * An upstream body as prompt context: the traceability pair is dropped. It is the upstream
 * agent's own trace; this agent's rules come only from its CANONICAL RULES section.
 * @param body - artifact body
 * @returns the body without rulesApplied / ungroundedChoices
 */
export const withoutTrace = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'rulesApplied' && k !== 'ungroundedChoices'));
