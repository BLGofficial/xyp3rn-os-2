import { osImport } from './os.ts';

// Typed doors to the web server's OS-side modules (apps/web/server/*), loaded natively at run time.
type Loaders = typeof import('../server/loaders.ts');
type Ops = typeof import('../server/ops.ts');
type CatalogLoaders = typeof import('../server/catalog-loaders.ts');
type CatalogOps = typeof import('../server/catalog-ops.ts');
type StudioLoaders = typeof import('../server/studio-loaders.ts');
type StudioOps = typeof import('../server/studio-ops.ts');
type ResearchLoaders = typeof import('../server/research-loaders.ts');
type ResearchOps = typeof import('../server/research-ops.ts');
type ShellLoaders = typeof import('../server/shell-loaders.ts');
type GraphOps = typeof import('../server/graph-ops.ts');
type GraphLoaders = typeof import('../server/graph-loaders.ts');
type GraphFiles = typeof import('../server/graph-files.ts');
type WorkflowsLoaders = typeof import('../server/workflows-loaders.ts');
type Runtime = typeof import('../server/runtime.ts');
type Store = typeof import('../../../knowledge/source-registry/vault-store.ts');

export const loaders = () => osImport<Loaders>('apps/web/server/loaders.ts');
export const ops = () => osImport<Ops>('apps/web/server/ops.ts');
export const catalogLoaders = () => osImport<CatalogLoaders>('apps/web/server/catalog-loaders.ts');
export const catalogOps = () => osImport<CatalogOps>('apps/web/server/catalog-ops.ts');
export const studioLoaders = () => osImport<StudioLoaders>('apps/web/server/studio-loaders.ts');
export const studioOps = () => osImport<StudioOps>('apps/web/server/studio-ops.ts');
export const researchLoaders = () => osImport<ResearchLoaders>('apps/web/server/research-loaders.ts');
export const researchOps = () => osImport<ResearchOps>('apps/web/server/research-ops.ts');
export const shellLoaders = () => osImport<ShellLoaders>('apps/web/server/shell-loaders.ts');
export const graphOps = () => osImport<GraphOps>('apps/web/server/graph-ops.ts');
export const graphLoaders = () => osImport<GraphLoaders>('apps/web/server/graph-loaders.ts');
export const graphFiles = () => osImport<GraphFiles>('apps/web/server/graph-files.ts');
export const workflowsLoaders = () => osImport<WorkflowsLoaders>('apps/web/server/workflows-loaders.ts');
export const runtime = async () => (await osImport<Runtime>('apps/web/server/runtime.ts')).runtime();
export const vaultStore = async () => {
  const s = await osImport<Store>('knowledge/source-registry/vault-store.ts');
  return s.createLocalVaultStore(s.defaultVaultDir());
};
