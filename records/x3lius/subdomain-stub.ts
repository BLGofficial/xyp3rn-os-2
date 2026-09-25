import { createManifestStub } from '../../core/agents/manifest-stub.ts';
import { loadMusicSystem } from './music-system.ts';

/**
 * Handler shared by the X3LIUS sub-domain stub agents (Phase 7): the Context Engine scoped to the
 * sub-domain's module, plus which phase builds it. Since Phase 14 it is the shared manifest stub
 * (core/agents/manifest-stub.ts) bound to the X3LIUS manifest; TECH binds the same one to its own.
 */
export const subdomainStub = createManifestStub(loadMusicSystem, 'an X3LIUS sub-domain');
