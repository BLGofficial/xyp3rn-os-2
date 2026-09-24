import { describe, expect, it } from 'vitest';
import { AGENT_CLASSES } from '../contracts/taxonomy.ts';
import { CAPABILITIES, CLASS_CAPABILITIES } from './capabilities.ts';
import { createToolRegistry, defineTool } from './registry.ts';
import { logMessageTool } from './tools/log-message.ts';

describe('deny by default (written before any tool existed)', () => {
  it('denies a Research agent requesting write_canonical with zero tools registered', () => {
    const tools = createToolRegistry([]);
    expect(tools.authorize('Research', 'write_canonical')).toEqual({
      allow: false,
      reason: 'tool not registered: write_canonical',
    });
  });

  it.each([...AGENT_CLASSES])('denies %s any unregistered tool name', (cls) => {
    expect(createToolRegistry([logMessageTool]).authorize(cls, 'delete_everything').allow).toBe(false);
  });

  it('denies canonical.write to EVERY class even when such a tool is registered', () => {
    const writeCanonical = defineTool({
      name: 'write_canonical',
      capability: 'canonical.write',
      description: 'Hypothetical direct canonical writer — must be unreachable by any agent.',
      handler: async () => {
        throw new Error('must never run');
      },
    });
    const tools = createToolRegistry([writeCanonical]);
    for (const cls of AGENT_CLASSES) {
      expect(tools.authorize(cls, 'write_canonical')).toEqual({
        allow: false,
        reason: `capability canonical.write is granted to no agent class (requested by ${cls})`,
      });
    }
  });
});

describe('class authorization follows the capability matrix exactly', () => {
  const probe = (capability: (typeof CAPABILITIES)[number]) =>
    defineTool({ name: `probe_${capability.replace('.', '_')}`, capability, description: 'matrix probe', handler: async () => null });
  const tools = createToolRegistry(CAPABILITIES.map(probe));

  it.each(CAPABILITIES.flatMap((cap) => AGENT_CLASSES.map((cls) => [cap, cls] as const)))(
    '%s requested by %s',
    (cap, cls) => {
      const decision = tools.authorize(cls, `probe_${cap.replace('.', '_')}`);
      expect(decision.allow).toBe(CLASS_CAPABILITIES[cap].includes(cls));
      if (!decision.allow) expect(decision.reason).toMatch(new RegExp(cap.replace('.', '\\.')));
    },
  );
});

describe('the one real tool', () => {
  it('log_message is registered with capability log.write and allowed for all 8 classes', () => {
    const tools = createToolRegistry([logMessageTool]);
    expect(tools.get('log_message')?.capability).toBe('log.write');
    for (const cls of AGENT_CLASSES) expect(tools.authorize(cls, 'log_message')).toEqual({ allow: true, capability: 'log.write' });
  });

  it('log_message appends to the run log and validates its args', async () => {
    const logs: { level: string; message: string }[] = [];
    const ctx = { runId: 'r', agentName: 'a', log: (level: 'info' | 'warn' | 'error', message: string) => logs.push({ level, message }) };
    await expect(logMessageTool.handler(ctx, { message: 'health ok' })).resolves.toEqual({ logged: true });
    expect(logs).toEqual([{ level: 'info', message: 'health ok' }]);
    await expect(logMessageTool.handler(ctx, { message: 42 })).rejects.toThrow(/message must be a non-empty string/);
  });
});

describe('registry construction', () => {
  it('rejects duplicate tool names', () => {
    expect(() => createToolRegistry([logMessageTool, logMessageTool])).toThrow(/duplicate tool name: log_message/);
  });

  it('rejects a tool whose name is not snake_case', () => {
    expect(() => defineTool({ name: 'Log-Message', capability: 'log.write', description: 'x', handler: async () => null })).toThrow(/snake_case/);
  });
});
