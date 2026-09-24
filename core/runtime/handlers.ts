import { healthCheck } from '../agents/health-check.ts';
import type { HandlerMap } from '../orchestrator/dispatch.ts';

/**
 * Deterministic (`model: none`) agent handlers, keyed by agent name. Checked in and
 * typechecked on purpose: nothing is loaded dynamically from agents/. A `model: none` agent
 * missing here fails dispatch with "no handler registered".
 */
export const HANDLERS: HandlerMap = {
  'health-check': healthCheck,
};
