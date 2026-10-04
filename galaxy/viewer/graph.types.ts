export interface SourceNote {
  id: number;
  label: string;
  group: string;
  path: string;
  domain?: string;
  excerpt?: string;
}
export interface SourceGraph {
  nodes: SourceNote[];
  links: { source: number | SourceNote; target: number | SourceNote }[];
}
export interface GraphNode {
  id: string;
  kind: 'core' | 'cluster' | 'note';
  label: string;
  group: string;
  paths: string[];
  note?: SourceNote;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'contains' | 'related';
  directed: boolean;
  provenance: string;
}
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; isolated: string[] }
export interface Position { id: string; x: number; y: number }
