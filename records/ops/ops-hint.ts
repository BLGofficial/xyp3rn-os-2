import { scoreTerms } from '../../core/orchestrator/keyword-match.ts';

/**
 * Records ops terms (Phase 13, F5). RECORDS requests go to the X3LIUS sub-domain selector; a request
 * that matches no sub-domain but names catalog, rights or calendar work is answered with the ops
 * commands. Ops operations take ids, dates and percentages, never parsed from free text.
 */
const OPS_TERMS: ReadonlyArray<readonly [string, number]> = [
  ['catalog', 3], ['isrc', 3], ['upc', 3], ['rights split', 3], ['split', 2], ['release date', 3],
  ['schedule', 2], ['release', 1], ['track', 1],
];

export const RECORDS_OPS_COMMANDS = [
  "register a take or a Vault audio file: pnpm workflow records/workflows/register-track.workflow.yaml '{\"takeId\":\"<uuid>\",\"sourceId\":null,\"release\":{\"title\":\"…\",\"artist\":\"…\",\"kind\":\"single\"},\"position\":1,\"title\":null,\"mixReportArtifactId\":null}'",
  "splits: pnpm dispatch records-catalog '{\"splits\":{\"trackId\":\"<uuid>\",\"splits\":[{\"payee\":\"…\",\"percentage\":100}]}}'",
  "codes: pnpm dispatch records-catalog '{\"assign\":{\"trackId\":\"<uuid>\",\"isrc\":\"…\"}}'",
  "rights check + schedule: pnpm workflow records/workflows/schedule-release.workflow.yaml '{\"releaseId\":\"<uuid>\",\"releaseDate\":\"YYYY-MM-DD\"}'",
] as const;

/**
 * @param request - a RECORDS request no X3LIUS sub-domain matched
 * @returns the clarify reason naming the Records ops commands, or null when no ops term appears
 */
export const opsClarification = (request: string): string | null =>
  scoreTerms(request, OPS_TERMS).score >= 3
    ? `Records ops (catalog, rights splits, release calendar) take ids, dates and percentages, not free text. Use: ${RECORDS_OPS_COMMANDS.join(' | ')}`
    : null;
