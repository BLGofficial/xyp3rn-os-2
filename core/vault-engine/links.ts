import { basename } from 'node:path';
import type { ExtractedWikilink } from '../../knowledge/obsidian/types.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';

export type VaultLinkResolution = {
  readonly vaultPath: string;
  readonly outgoing: readonly ExtractedWikilink[];
  readonly outgoingTargets: readonly string[];
  readonly backlinks: readonly string[];
};

const stripMdExt = (p: string): string => (p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p);

/**
 * Checks whether a wikilink target (`02_KNOWLEDGE/CANONICAL/Note` or `Note` or `Note.md`)
 * resolves to an indexed entry in `SqliteRuntimeDb`.
 */
export const targetExistsInIndex = (db: SqliteRuntimeDb, targetRaw: string): boolean => {
  const clean = targetRaw.trim();
  if (!clean) return false;

  const withMd = clean.endsWith('.md') ? clean : `${clean}.md`;
  if (db.getIndexEntry(clean) || db.getIndexEntry(withMd)) {
    return true;
  }

  const targetLower = stripMdExt(clean).toLowerCase();
  const targetBase = basename(targetLower);
  const all = db.listIndexEntries(undefined, 50_000);
  return all.some((entry) => {
    const vpLower = stripMdExt(entry.vaultPath).toLowerCase();
    const stemLower = basename(entry.vaultPath, entry.fileExt).toLowerCase();
    const titleLower = entry.title.toLowerCase();
    return vpLower === targetLower || stemLower === targetBase || titleLower === targetLower;
  });
};

/**
 * Computes both outgoing wikilinks and incoming backlinks for `vaultPath`.
 */
export const resolveNoteLinks = (db: SqliteRuntimeDb, vaultPath: string): VaultLinkResolution => {
  const entry = db.getIndexEntry(vaultPath);
  const outgoing = entry?.wikilinks ?? [];
  const outgoingTargets = outgoing.map((w) => w.target);

  const normalizedSelf = stripMdExt(vaultPath).toLowerCase();
  const fileStem = basename(normalizedSelf).toLowerCase();
  const titleStem = entry?.title.toLowerCase() ?? fileStem;

  const all = db.listIndexEntries(undefined, 50_000);
  const backlinks: string[] = [];

  for (const candidate of all) {
    if (candidate.vaultPath === vaultPath) continue;
    const matches = candidate.wikilinks.some((w) => {
      const t = stripMdExt(w.target).toLowerCase();
      return t === normalizedSelf || t === fileStem || t === titleStem;
    });
    if (matches) {
      backlinks.push(candidate.vaultPath);
    }
  }

  return {
    vaultPath,
    outgoing,
    outgoingTargets,
    backlinks,
  };
};

/**
 * Formats a canonical Obsidian wikilink (`[[target|alias]]` or `[[target#section|alias]]`)
 * and appends it cleanly to a note's Markdown content if not already linked.
 */
export const appendWikilinkToContent = (
  sourceContent: string,
  targetVaultPath: string,
  options: {
    readonly alias?: string | undefined;
    readonly section?: string | undefined;
    readonly relationLabel?: string | undefined;
  } = {},
): { readonly updatedContent: string; readonly wikilinkSyntax: string; readonly alreadyLinked: boolean } => {
  const cleanTarget = stripMdExt(targetVaultPath.trim());
  const sectionPart = options.section?.trim() ? `#${options.section.trim()}` : '';
  const aliasPart = options.alias?.trim() ? `|${options.alias.trim()}` : '';
  const wikilinkSyntax = `[[${cleanTarget}${sectionPart}${aliasPart}]]`;

  if (sourceContent.includes(`[[${cleanTarget}`)) {
    return { updatedContent: sourceContent, wikilinkSyntax, alreadyLinked: true };
  }

  const labelPrefix = options.relationLabel?.trim() ? `- **${options.relationLabel.trim()}:** ` : '- ';
  const trailingNewline = sourceContent.endsWith('\n') ? '' : '\n';
  const updatedContent = `${sourceContent}${trailingNewline}${labelPrefix}${wikilinkSyntax}\n`;

  return {
    updatedContent,
    wikilinkSyntax,
    alreadyLinked: false,
  };
};
