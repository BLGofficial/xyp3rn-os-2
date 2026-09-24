import type { AgentClass } from '../contracts/taxonomy.ts';
import { CLASS_CAPABILITIES, isCapability, type Capability } from './capabilities.ts';

/** What a tool handler can see of the run invoking it. */
export type ToolContext = {
  readonly runId: string;
  readonly agentName: string;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export type Tool = {
  readonly name: string;
  /** Exactly one capability per tool — authorization is decided on it, never on the name. */
  readonly capability: Capability;
  readonly description: string;
  readonly handler: (ctx: ToolContext, args: unknown) => Promise<unknown>;
};

export type Authorization =
  | { readonly allow: true; readonly capability: Capability }
  | { readonly allow: false; readonly reason: string };

export type ToolRegistry = {
  readonly get: (name: string) => Tool | undefined;
  readonly list: () => readonly Tool[];
  /**
   * The only authorization check. The Orchestrator calls it for every declared tool before
   * execution and again on every invocation; there is no other path to a handler.
   */
  readonly authorize: (agentClass: AgentClass, toolName: string) => Authorization;
};

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Validates a tool definition at declaration time.
 * @param tool - name (snake_case), capability, description, handler
 * @returns the same tool, frozen
 * @throws Error on a malformed name or an undeclared capability
 */
export const defineTool = (tool: Tool): Tool => {
  if (!SNAKE.test(tool.name)) throw new Error(`tool name must be snake_case: ${tool.name}`);
  if (!isCapability(tool.capability)) throw new Error(`tool ${tool.name} declares unknown capability: ${String(tool.capability)}`);
  return Object.freeze({ ...tool });
};

/**
 * Builds the tool map. Deny by default: an unregistered name, a capability no class holds, or a
 * capability the requesting class lacks are all denials with a reason.
 * @param tools - tool definitions (names must be unique)
 * @returns get/list/authorize over the fixed set
 * @throws Error on duplicate names
 */
export const createToolRegistry = (tools: readonly Tool[]): ToolRegistry => {
  const byName = new Map<string, Tool>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    byName.set(t.name, defineTool(t));
  }

  const authorize = (agentClass: AgentClass, toolName: string): Authorization => {
    const tool = byName.get(toolName);
    if (!tool) return { allow: false, reason: `tool not registered: ${toolName}` };
    const allowed = CLASS_CAPABILITIES[tool.capability];
    if (allowed.length === 0) {
      return { allow: false, reason: `capability ${tool.capability} is granted to no agent class (requested by ${agentClass})` };
    }
    if (!allowed.includes(agentClass)) {
      return { allow: false, reason: `class ${agentClass} lacks capability ${tool.capability} required by ${toolName}` };
    }
    return { allow: true, capability: tool.capability };
  };

  return { get: (n) => byName.get(n), list: () => [...byName.values()], authorize };
};
