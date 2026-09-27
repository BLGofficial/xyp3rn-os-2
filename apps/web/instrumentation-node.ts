import { researchOps, runtime } from './lib/server';

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
