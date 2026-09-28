// AOS-04 (R5): at server boot, seal research runs that a previous server process left running past their
// deadline (instrumentation-node.ts). Only the Node.js runtime imports it: the edge compile can't take node: modules.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const node = await import('./instrumentation-node');
    await node.sweepAbandonedRuns();
    // AOS-04 Plan C1: the file index catches up with the checkout; not awaited, so boot never waits on a scan.
    void node.scanIndexOnBoot();
  }
}
