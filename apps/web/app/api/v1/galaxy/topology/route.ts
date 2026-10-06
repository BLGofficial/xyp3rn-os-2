import { galaxyTopology, read } from '../../_lib';

export const dynamic = 'force-dynamic';

export const GET = (): Promise<Response> => read('the galaxy topology', galaxyTopology);
