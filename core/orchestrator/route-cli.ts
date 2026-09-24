import { ENTRYPOINTS, planRequest } from './orchestrate.ts';

// Usage: node core/orchestrator/route-cli.ts "<request>"
// Prints the routing decision (scores + matched terms) and what the Orchestrator would do.

const request = process.argv[2];
if (!request) {
  console.error('usage: route-cli.ts "<request>"');
  process.exit(2);
}
const plan = planRequest(request, ENTRYPOINTS);
console.log(`request: ${request}`);
console.log(`route:   ${plan.route.status}${plan.route.status === 'routed' ? ` → ${plan.route.domain} (margin ${plan.route.margin})` : ''}`);
console.log(`scores:  ${JSON.stringify(plan.route.scores)}`);
console.log(`matched: ${JSON.stringify(plan.route.evidence)}`);
console.log(`action:  ${plan.action}${'reason' in plan ? ` — ${plan.reason}` : ` → ${plan.workflow}`}`);
