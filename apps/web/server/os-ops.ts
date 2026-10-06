import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { applySync, VAULT_ENV, type SyncReceipt } from '../../../knowledge/obsidian/sync.ts';

/**
 * /os writes (F54): the owner's Apply on a previewed Obsidian sync. The plan hash is the approval: the
 * sync re-plans and refuses when anything changed since the preview.
 * @param deps - dispatch deps
 * @param env - environment (XYP_OBSIDIAN_VAULT)
 * @param planHash - the hash shown in the preview the owner approved
 * @returns the receipt
 * @throws when no vault is configured, the hash is malformed or stale, or a sync is running
 */
export const syncObsidian = async (deps: DispatchDeps, env: Readonly<Record<string, string | undefined>>, planHash: string): Promise<SyncReceipt> => {
  const configured = env[VAULT_ENV];
  if (!configured || configured.trim() === '') throw new Error(`${VAULT_ENV} is not set: name the Obsidian vault folder in the environment`);
  if (!/^[0-9a-f]{64}$/.test(planHash)) throw new Error('the sync needs the plan hash from its preview');
  return applySync(deps, configured, planHash);
};
