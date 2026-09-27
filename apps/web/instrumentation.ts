// AOS-04 (R5): at server boot, seal research runs that a previous server process left running past their
// deadline (instrumentation-node.ts). Only the Node.js runtime imports it: the edge compile can't take node: modules.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await (await import('./instrumentation-node')).sweepAbandonedRuns();
  }
}
