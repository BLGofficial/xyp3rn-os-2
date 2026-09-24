import { createToolRegistry } from '../tool-registry/registry.ts';
import { logMessageTool } from '../tool-registry/tools/log-message.ts';

/** The live tool set. Adding a tool here is the only way it becomes requestable. */
export const TOOLS = createToolRegistry([logMessageTool]);
