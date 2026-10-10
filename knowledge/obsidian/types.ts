/** The vault area a note belongs to (matches the `obsidian/` folder layout). */
export type ObsidianDomain = 'research' | 'creative' | 'canonical';

export type ObsidianNoteType = 'lyric_draft' | 'lyrics' | 'suno_package' | 'catalog_entry' | 'research_note';

/** Standard frontmatter. Unknown keys are kept: the owner's notes carry their own. */
export type ObsidianFrontmatter = {
  readonly type?: ObsidianNoteType | string;
  readonly domain?: ObsidianDomain | string;
  readonly tags: readonly string[];
  readonly author?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
};

/** One `[[target#heading|alias]]` (or `![[…]]` embed) found in a note body. */
export type ExtractedWikilink = {
  readonly target: string;
  readonly heading: string | null;
  readonly alias: string | null;
  readonly embed: boolean;
  readonly raw: string;
};

export type ParsedObsidianNote = {
  readonly frontmatter: ObsidianFrontmatter;
  readonly body: string;
  readonly wikilinks: readonly ExtractedWikilink[];
  /** SHA-256 (hex) of the entire raw file string, frontmatter included. */
  readonly sha256: string;
  /** YAML error when the frontmatter does not parse; the body is still read. */
  readonly frontmatterError: string | null;
};
