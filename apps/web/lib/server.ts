import { osImport } from './os.ts';

// Typed doors to the web server's OS-side modules (apps/web/server/*), loaded natively at run time.
type Loaders = typeof import('../server/loaders.ts');
type Ops = typeof import('../server/ops.ts');
type Runtime = typeof import('../server/runtime.ts');
type Store = typeof import('../../../knowledge/source-registry/vault-store.ts');

export const loaders = () => osImport<Loaders>('apps/web/server/loaders.ts');
export const ops = () => osImport<Ops>('apps/web/server/ops.ts');
export const runtime = async () => (await osImport<Runtime>('apps/web/server/runtime.ts')).runtime();
export const vaultStore = async () => {
  const s = await osImport<Store>('knowledge/source-registry/vault-store.ts');
  return s.createLocalVaultStore(s.defaultVaultDir());
};
