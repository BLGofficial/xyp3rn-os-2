import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isAgentClass, isDomain, type AgentClass, type Domain } from '../contracts/taxonomy.ts';

/**
 * Shape taken from agents/_template.agent.md (Phase 0). Pure: path + contents in, result out —
 * no filesystem access, so every rule is testable on strings.
 */

export const REQUIRED_FIELDS = ['name', 'class', 'domain', 'tools', 'model'] as const;
export const REQUIRED_SECTIONS = ['Role', 'Contract', 'Refuses'] as const;

export type AgentDefinition = {
  readonly name: string;
  readonly class: AgentClass;
  readonly domain: Domain;
  readonly tools: readonly string[];
  /** Model id for LLM-backed agents, or 'none' for deterministic ones. */
  readonly model: string;
  readonly role: string;
  readonly contract: string;
  readonly refuses: string;
  readonly path: string;
};

export type ParseResult =
  | { readonly ok: true; readonly agent: AgentDefinition }
  | { readonly ok: false; readonly path: string; readonly errors: readonly string[] };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Text under each `## Heading` until the next `## ` heading. */
const sections = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  const parts = body.split(/^## (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!.trim(), (parts[i + 1] ?? '').trim());
  return out;
};

/**
 * Parses and validates one agent file. Collects every problem rather than stopping at the first.
 * @param path - file path (its stem must equal `name`)
 * @param contents - raw file text
 * @returns the definition, or every validation error with the file path
 */
export const parseAgentFile = (path: string, contents: string): ParseResult => {
  const fail = (errors: string[]): ParseResult => ({ ok: false, path, errors });
  const m = FRONTMATTER.exec(contents);
  if (!m) return fail(['missing YAML frontmatter block']);

  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch (e) {
    return fail([`frontmatter is not valid YAML: ${(e as Error).message.split('\n')[0]}`]);
  }
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) return fail(['frontmatter must be a key/value mapping']);
  const f = fm as Record<string, unknown>;

  const errors: string[] = [];
  for (const k of REQUIRED_FIELDS) if (!(k in f)) errors.push(`missing required field: ${k}`);
  for (const k of Object.keys(f)) if (!(REQUIRED_FIELDS as readonly string[]).includes(k)) errors.push(`unknown field: ${k}`);

  const stem = basename(path).replace(/\.agent\.md$/, '');
  if ('name' in f) {
    if (typeof f.name !== 'string' || !KEBAB.test(f.name)) errors.push(`name must be kebab-case: ${String(f.name)}`);
    else if (f.name !== stem) errors.push(`name "${f.name}" must equal filename stem "${stem}"`);
  }
  if ('class' in f && !isAgentClass(f.class)) errors.push(`unknown class: ${String(f.class)}`);
  if ('domain' in f && !isDomain(f.domain)) errors.push(`unknown domain: ${String(f.domain)}`);
  if ('tools' in f) {
    if (!Array.isArray(f.tools)) errors.push('tools must be a list');
    else for (const t of f.tools) if (typeof t !== 'string' || !SNAKE.test(t)) errors.push(`tool name must be snake_case: ${String(t)}`);
  }
  if ('model' in f && (typeof f.model !== 'string' || f.model.trim() === '')) errors.push('model must be a non-empty string');

  const body = sections(contents.slice(m[0].length));
  for (const s of REQUIRED_SECTIONS) {
    if (!body.has(s)) errors.push(`missing body section: ## ${s}`);
    else if (body.get(s) === '') errors.push(`empty body section: ## ${s}`);
  }

  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    agent: {
      name: f.name as string,
      class: f.class as AgentClass,
      domain: f.domain as Domain,
      tools: f.tools as string[],
      model: f.model as string,
      role: body.get('Role')!,
      contract: body.get('Contract')!,
      refuses: body.get('Refuses')!,
      path,
    },
  };
};
