import { parseDocument, stringify as toYaml } from 'yaml';
import { parseObsidianNote } from '../../knowledge/obsidian/parser.ts';
import type { ExtractedWikilink, ObsidianFrontmatter } from '../../knowledge/obsidian/types.ts';
import { VaultValidationError } from './errors.ts';
import { sha256Hex } from './revision.ts';

export type ParsedFrontmatterDocument = {
  readonly frontmatter: ObsidianFrontmatter;
  readonly rawFrontmatter: Record<string, unknown>;
  readonly body: string;
  readonly wikilinks: readonly ExtractedWikilink[];
  readonly sha256: string;
  readonly bodySha256: string;
  readonly hasFrontmatterBlock: boolean;
  readonly frontmatterError: string | null;
};

const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Parses YAML frontmatter and Markdown body from a raw note string.
 * When `strict: true` is passed, invalid YAML syntax throws `VaultValidationError('INVALID_YAML')`.
 */
export const parseFrontmatterDocument = (
  rawContent: string,
  options: { readonly strict?: boolean | undefined; readonly vaultPath?: string | undefined } = {},
): ParsedFrontmatterDocument => {
  if (rawContent.includes('\0')) {
    const msg = 'Corrupted document: contains binary NUL (\\0) bytes';
    if (options.strict) {
      throw new VaultValidationError('INVALID_YAML', msg, { vaultPath: options.vaultPath });
    }
    return {
      frontmatter: { title: undefined, tags: [] },
      rawFrontmatter: {},
      body: rawContent,
      wikilinks: [],
      sha256: sha256Hex(rawContent),
      bodySha256: sha256Hex(rawContent.trim()),
      hasFrontmatterBlock: false,
      frontmatterError: msg,
    };
  }
  const normalized = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent;
  const match = FM_BLOCK_RE.exec(normalized);
  const hasFrontmatterBlock = match !== null;

  if (!match && (normalized.startsWith('---\n') || normalized.startsWith('---\r\n'))) {
    const msg = 'Unclosed YAML frontmatter fence "---"';
    if (options.strict) {
      throw new VaultValidationError('INVALID_YAML', msg, { vaultPath: options.vaultPath });
    }
    const parsedFallback = parseObsidianNote(rawContent);
    return {
      frontmatter: parsedFallback.frontmatter,
      rawFrontmatter: parsedFallback.frontmatter as Record<string, unknown>,
      body: parsedFallback.body,
      wikilinks: parsedFallback.wikilinks,
      sha256: parsedFallback.sha256,
      bodySha256: sha256Hex(parsedFallback.body.trim()),
      hasFrontmatterBlock: true,
      frontmatterError: msg,
    };
  }

  if (match) {
    try {
      const doc = parseDocument(match[1] ?? '', { logLevel: 'silent' });
      if (doc.errors.length > 0) {
        const msg = doc.errors[0]!.message.split('\n')[0] ?? doc.errors[0]!.message;
        if (options.strict) {
          throw new VaultValidationError('INVALID_YAML', `Invalid YAML frontmatter: ${msg}`, {
            vaultPath: options.vaultPath,
          });
        }
      }
      const yamlValue = doc.errors.length === 0 ? doc.toJS() : undefined;
      if (yamlValue !== null && yamlValue !== undefined && (typeof yamlValue !== 'object' || Array.isArray(yamlValue))) {
        const msg = 'Frontmatter YAML must evaluate to a key-value mapping object';
        if (options.strict) {
          throw new VaultValidationError('INVALID_YAML', msg, { vaultPath: options.vaultPath });
        }
        const parsedFallback = parseObsidianNote(rawContent);
        return {
          frontmatter: parsedFallback.frontmatter,
          rawFrontmatter: parsedFallback.frontmatter as Record<string, unknown>,
          body: parsedFallback.body,
          wikilinks: parsedFallback.wikilinks,
          sha256: parsedFallback.sha256,
          bodySha256: sha256Hex(parsedFallback.body.trim()),
          hasFrontmatterBlock: true,
          frontmatterError: msg,
        };
      }
    } catch (err) {
      if (err instanceof VaultValidationError) throw err;
      const msg = (err as Error).message.split('\n')[0] ?? (err as Error).message;
      if (options.strict) {
        throw new VaultValidationError('INVALID_YAML', `Invalid YAML frontmatter: ${msg}`, {
          vaultPath: options.vaultPath,
        });
      }
      const parsedFallback = parseObsidianNote(rawContent);
      return {
        frontmatter: parsedFallback.frontmatter,
        rawFrontmatter: parsedFallback.frontmatter as Record<string, unknown>,
        body: parsedFallback.body,
        wikilinks: parsedFallback.wikilinks,
        sha256: parsedFallback.sha256,
        bodySha256: sha256Hex(parsedFallback.body.trim()),
        hasFrontmatterBlock: true,
        frontmatterError: msg,
      };
    }
  }

  const parsed = parseObsidianNote(rawContent);
  if (options.strict && parsed.frontmatterError) {
    throw new VaultValidationError('INVALID_YAML', `Invalid YAML frontmatter: ${parsed.frontmatterError}`, {
      vaultPath: options.vaultPath,
    });
  }

  return {
    frontmatter: parsed.frontmatter,
    rawFrontmatter: parsed.frontmatter as Record<string, unknown>,
    body: parsed.body,
    wikilinks: parsed.wikilinks,
    sha256: parsed.sha256,
    bodySha256: sha256Hex(parsed.body.trim()),
    hasFrontmatterBlock,
    frontmatterError: parsed.frontmatterError,
  };
};

/**
 * Serializes a frontmatter object and Markdown body into canonical Obsidian note format.
 */
export const serializeFrontmatterDocument = (
  frontmatter: Record<string, unknown>,
  body: string,
): string => {
  const cleanBody = body.trim();
  const yamlText = toYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
};
