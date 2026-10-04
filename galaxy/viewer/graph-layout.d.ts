import type { GraphData, Position } from './graph.types.ts';
export function layoutGraph(data: GraphData, seed?: number): Position[];
export function seededRandom(seed?: number): () => number;
