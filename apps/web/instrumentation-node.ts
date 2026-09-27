import { graphOps, researchOps, runtime } from './lib/server';

/**
 * Seals research runs a stopped server left running past their deadline. Runs started by this process
 * execute in it (research-ops startBrief); a stop kills them, and this is what closes them.
 */
export const sweepAbandonedRuns = async (): Promise<void> => {
  try {
    const sealed = await (await researchOps()).sweepOnBoot((await runtime()).sql);
    if (sealed.length > 0) console.error(`research: sealed ${sealed.length} abandoned run(s): ${sealed.join(', ')}`);
  } catch (e) {
    // The sweep also runs before every new brief (research-ops startBrief); a boot without the DB must still serve /login.
    console.error(`research: boot sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Brings the file index up to date at boot (AOS-04 Plan C1): a quick scan of this checkout and the Vault's bytes.
 * Not awaited by the caller: the server answers while it runs, and a failed scan is sealed `error` in index_scans.
 */
export const scanIndexOnBoot = async (): Promise<void> => {
  try {
    const r = await (await graphOps()).scanIndex((await runtime()).sql, 'boot');
    if (r.status === 'error') console.error(`index: boot scan ${r.scanId} failed: ${r.error}`);
  } catch (e) {
    // A boot without the DB must still serve /login (as the research sweep above).
    console.error(`index: boot scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
