import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';

export const SONGS_AGENT = 'records-songs';

const OPS = { create: 'write_song', revise: 'write_song', link: 'link_song', unlink: 'unlink_song' } as const;

/**
 * records-songs (AOS-01, Execution, deterministic): performs exactly the song operation it is
 * given, one of
 * - `{ create: { title, artist, language?, genre?, status?, notes? } }` → `{ songId, revision }`;
 * - `{ revise: { songId, …fields } }` → the next revision; fields not given are carried over;
 * - `{ link: { songId, role?, artifactId | sourceId | takeId | trackId | researchQuestionId } }`;
 * - `{ unlink: { linkId, reason } }`.
 * @param ctx - run context; write_song / link_song / unlink_song carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const recordsSongs: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (Object.keys(OPS) as (keyof typeof OPS)[]).filter((k) => i[k] !== undefined);
  if (ops.length !== 1 || Object.keys(i).length !== 1) throw new Error('records-songs input needs exactly one of create, revise, link, unlink');
  const op = ops[0]!;
  const args = i[op];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`records-songs: ${op} must be an object`);
  const a = args as Record<string, unknown>;
  // create and revise share one tool: the presence of songId is what tells them apart there.
  if (op === 'create' && a.songId !== undefined) throw new Error('records-songs: create takes no songId (use revise)');
  if (op === 'revise' && a.songId === undefined) throw new Error('records-songs: revise needs a songId');
  return { output: await ctx.useTool(OPS[op], a), tokensUsed: 0 };
};
