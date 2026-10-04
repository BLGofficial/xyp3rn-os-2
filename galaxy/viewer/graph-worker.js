import { layoutGraph } from './graph-layout.js';
self.onmessage = ({ data: { id, graph } }) => {
  try { self.postMessage({ id, positions: layoutGraph(graph) }); }
  catch (error) { self.postMessage({ id, error: String(error.message || error) }); }
};
