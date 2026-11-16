import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { Os3ModelGateway } from '../llm/os3-model-gateway.ts';
import { redactSecrets } from '../runtime/logger.ts';
import { assertNoSymlinkEscape, resolveVaultPath } from '../vault-engine/path-resolver.ts';
import { validateEntityContent } from '../vault-engine/schema-validator.ts';
import type { Os3JarvisRuntime } from './jarvis-runtime.ts';

export type CodeSymbolInfo = {
  readonly kind: 'function' | 'class' | 'type' | 'const' | 'route';
  readonly name: string;
  readonly line: number;
  readonly signature: string;
};

export type OsSearchHit = {
  readonly scope: 'os';
  readonly path: string;
  readonly title: string;
  readonly score: number;
  readonly symbols: readonly CodeSymbolInfo[];
  readonly matchedLines: readonly { readonly line: number; readonly text: string }[];
  readonly snippet: string;
};

export type VaultDeepSearchHit = {
  readonly scope: 'vault';
  readonly vaultPath: string;
  readonly title: string;
  readonly sector: string;
  readonly score: number;
  readonly sha256: string;
  readonly matchedLines: readonly { readonly line: number; readonly text: string }[];
  readonly snippet: string;
};

export type JarvisCitation = {
  readonly scope: 'vault' | 'os';
  readonly path: string;
  readonly title: string;
  readonly symbols?: readonly string[] | undefined;
  readonly snippet: string;
  readonly sha256?: string | undefined;
};

export type JarvisInspectionResult = {
  readonly ok: true;
  readonly scope: 'vault' | 'os';
  readonly path: string;
  readonly title: string;
  readonly sector?: string | undefined;
  readonly lineCount: number;
  readonly symbols: readonly CodeSymbolInfo[];
  readonly content: string;
  readonly truncated: boolean;
  readonly sha256: string;
};

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'of', 'from', 'by', 'with', 'about',
  'as', 'into', 'like', 'through', 'after', 'before', 'between', 'under',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall',
  'me', 'my', 'i', 'you', 'your', 'we', 'our', 'it', 'its', 'this', 'that',
  'these', 'those', 'all', 'any', 'everything', 'whole', 'explain', 'show',
  'find', 'search', 'read', 'tell', 'give', 'list', 'inspect', 'look', 'up',
  'file', 'files', 'code', 'function', 'functions', 'method', 'methods', 'os',
  'vault', 'obsidian', 'note', 'notes', 'answer', 'based', 'please', 'jarvis',
]);

const OS_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.local-db',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  '.vault-revisions',
]);

const OS_ALLOWED_EXT = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.sql',
  '.ps1',
  '.sh',
  '.css',
  '.toml',
]);

const SENSITIVE_FILENAME_RE = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|crt|sqlite|db)$/i;

const isWithinRoot = (rootReal: string, candidateReal: string): boolean => {
  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const normCand = process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal;
  if (normCand === normRoot) return true;
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  return normCand.startsWith(rootWithSep);
};

/**
 * Extracts normalized search keywords from natural-language questions and code/symbol identifiers.
 */
export function extractSearchTerms(query: string): string[] {
  const cleaned = query.replace(/^xyp3rn>\s*/i, '').trim();
  const rawTokens = cleaned.match(/[A-Za-z0-9_./-]+/g) ?? [];
  const terms = new Set<string>();

  for (const raw of rawTokens) {
    const trimmed = raw.replace(/^[./-]+|[.,;:!?/]+$/g, '');
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!STOP_WORDS.has(lower) && lower.length >= 2) {
      terms.add(lower);
    }
    // Also split camelCase / PascalCase / path segments for precise function & filename recall
    const subParts = trimmed
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[/_.\-\s]+/)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2 && !STOP_WORDS.has(s));
    for (const part of subParts) {
      terms.add(part);
    }
  }

  return [...terms].slice(0, 14);
}

/**
 * Extracts functions, classes, types, exported constants, and HTTP API routes from TypeScript/JS source.
 */
export function extractCodeSymbols(content: string): CodeSymbolInfo[] {
  const symbols: CodeSymbolInfo[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const lineNum = i + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    let m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({ kind: 'function', name: m[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    m = /^(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({ kind: 'class', name: m[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    m = /^(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({ kind: 'type', name: m[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }

    m = /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(trimmed);
    if (m?.[1]) {
      const isArrow = trimmed.includes('=>');
      symbols.push({
        kind: isArrow ? 'function' : 'const',
        name: m[1],
        line: lineNum,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    m = /pathname\s*===\s*['"]([\/A-Za-z0-9_.-]+)['"]/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({ kind: 'route', name: m[1], line: lineNum, signature: trimmed.slice(0, 120) });
      continue;
    }
  }

  return symbols.slice(0, 60);
}

/**
 * Resolves and validates an OS-relative file path strictly inside `repoRoot`, blocking traversal,
 * symlink escapes, node_modules, and `.env*` / private key files.
 */
async function resolveOsSafeFile(repoRoot: string, relPath: string): Promise<{ rel: string; abs: string }> {
  const rootAbs = resolve(repoRoot);
  const trimmed = relPath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\0')) {
    throw new Error(`Invalid OS path rejected: "${relPath}"`);
  }
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || OS_IGNORED_DIRS.has(seg) || seg.startsWith('.env')) {
      throw new Error(`Security policy rejected OS path segment in "${relPath}"`);
    }
  }
  const normRel = posix.normalize(trimmed);
  if (SENSITIVE_FILENAME_RE.test(normRel) || normRel.startsWith('.')) {
    throw new Error(`Restricted secret/system file rejected: "${normRel}"`);
  }

  const extDot = normRel.lastIndexOf('.');
  const ext = extDot > 0 ? normRel.slice(extDot).toLowerCase() : '';
  if (!OS_ALLOWED_EXT.has(ext)) {
    throw new Error(`Disallowed OS file extension "${ext || '(none)'}" in "${normRel}"`);
  }

  const abs = resolve(rootAbs, ...segments);
  if (!isWithinRoot(rootAbs, abs)) {
    throw new Error(`Path escapes OS root: "${normRel}"`);
  }
  await assertNoSymlinkEscape(rootAbs, abs, normRel);
  return { rel: normRel, abs };
}

type OsFileIndexEntry = {
  readonly relPath: string;
  readonly absPath: string;
  readonly ext: string;
};

const osFileCache = new Map<string, { readonly atMs: number; readonly files: readonly OsFileIndexEntry[] }>();

async function collectOsReadableFiles(repoRoot: string): Promise<readonly OsFileIndexEntry[]> {
  const cached = osFileCache.get(repoRoot);
  if (cached && Date.now() - cached.atMs < 15_000) {
    return cached.files;
  }

  const rootAbs = resolve(repoRoot);
  const files: OsFileIndexEntry[] = [];

  const walk = async (dirAbs: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || OS_IGNORED_DIRS.has(entry.name)) continue;
      if (SENSITIVE_FILENAME_RE.test(entry.name)) continue;
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : '';
        if (!OS_ALLOWED_EXT.has(ext)) continue;
        const rel = relative(rootAbs, abs).split(sep).join('/');
        files.push({ relPath: rel, absPath: abs, ext });
      }
    }
  };

  await walk(rootAbs, 0);
  osFileCache.set(repoRoot, { atMs: Date.now(), files });
  return files;
}

function collectMatchedLines(content: string, terms: readonly string[], maxMatches = 4): { line: number; text: string }[] {
  if (terms.length === 0) return [];
  const lines = content.split(/\r?\n/);
  const matches: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lower = raw.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      const safeLine = redactSecrets(raw.trim()).slice(0, 180);
      if (safeLine) {
        matches.push({ line: i + 1, text: safeLine });
        if (matches.length >= maxMatches) break;
      }
    }
  }
  return matches;
}

/**
 * Searches across ALL readable source files, modules, exported functions/classes/routes,
 * and agent/workflow definitions inside `runtime.repoRoot`.
 */
export async function searchWholeOs(
  runtime: Os3JarvisRuntime,
  query: string,
  options: { readonly limit?: number | undefined } = {},
): Promise<OsSearchHit[]> {
  const limit = Math.min(25, Math.max(1, options.limit ?? 8));
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const files = await collectOsReadableFiles(runtime.repoRoot);
  const scored: OsSearchHit[] = [];

  // Process in bounded concurrent batches so scanning hundreds of source files stays < 60ms
  const batchSize = 24;
  for (let i = 0; i < files.length; i += batchSize) {
    const slice = files.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      slice.map(async (f): Promise<OsSearchHit | null> => {
        const lowerPath = f.relPath.toLowerCase();
        let pathScore = 0;
        for (const t of terms) {
          if (lowerPath.includes(t)) pathScore += 6;
        }

        const st = await stat(f.absPath).catch(() => null);
        if (!st || st.size > 320_000) return null;

        const raw = await readFile(f.absPath, 'utf8').catch(() => '');
        if (!raw) return null;

        // Skip any file containing detected secret material
        const secretCheck = validateEntityContent(f.relPath, raw, { requireSchema: false });
        if (secretCheck.issues.some((iss) => iss.code === 'SECRET_DETECTED')) {
          return null;
        }

        const lowerContent = raw.toLowerCase();
        const symbols = f.ext === '.ts' || f.ext === '.tsx' || f.ext === '.js' || f.ext === '.mjs' ? extractCodeSymbols(raw) : [];

        let contentScore = 0;
        for (const t of terms) {
          if (lowerContent.includes(t)) contentScore += 2;
        }
        let symbolScore = 0;
        const matchedSymbols: CodeSymbolInfo[] = [];
        for (const sym of symbols) {
          const symLower = sym.name.toLowerCase();
          if (terms.some((t) => symLower.includes(t))) {
            symbolScore += 5;
            matchedSymbols.push(sym);
          }
        }

        const totalScore = pathScore + symbolScore + contentScore;
        if (totalScore <= 0) return null;

        const matchedLines = collectMatchedLines(raw, terms, 4);
        const topSymbols = matchedSymbols.length > 0 ? matchedSymbols : symbols.slice(0, 6);
        const snippet =
          matchedLines.map((m) => `L${m.line}: ${m.text}`).join(' | ') ||
          redactSecrets(raw.replace(/\s+/g, ' ').trim()).slice(0, 220);

        return {
          scope: 'os',
          path: f.relPath,
          title: f.relPath.split('/').at(-1) ?? f.relPath,
          score: totalScore,
          symbols: topSymbols.slice(0, 8),
          matchedLines,
          snippet,
        };
      }),
    );

    for (const hit of batchResults) {
      if (hit) scored.push(hit);
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

/**
 * Searches across EVERY note in the Obsidian Vault: both the SQLite metadata/path index
 * across all 20,355+ entries AND full-text Markdown body content inside candidate/structured sectors.
 */
export async function searchWholeVault(
  runtime: Os3JarvisRuntime,
  query: string,
  options: { readonly limit?: number | undefined; readonly sector?: string | undefined } = {},
): Promise<VaultDeepSearchHit[]> {
  const limit = Math.min(25, Math.max(1, options.limit ?? 8));
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const allEntries = runtime.db.listIndexEntries(options.sector, 25_000);
  const scoredMeta: Array<{ entry: (typeof allEntries)[number]; metaScore: number }> = [];

  for (const entry of allEntries) {
    const hay = `${entry.title} ${entry.vaultPath} ${entry.tags.join(' ')} ${entry.domain ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) {
        score += entry.vaultPath.toLowerCase().includes(t) || entry.title.toLowerCase().includes(t) ? 5 : 3;
      }
    }
    // Always inspect structured OS3 Vault sectors (`00_SYSTEM`..`11_ARCHIVE`) even if title didn't match,
    // plus prioritize any ROOT_KB notes that matched path/title terms.
    const isStructuredSector = entry.sector !== 'ROOT_KB';
    if (score > 0 || isStructuredSector) {
      scoredMeta.push({ entry, metaScore: score });
    }
  }

  scoredMeta.sort((a, b) => {
    if (b.metaScore !== a.metaScore) return b.metaScore - a.metaScore;
    if (a.entry.sector !== 'ROOT_KB' && b.entry.sector === 'ROOT_KB') return -1;
    if (a.entry.sector === 'ROOT_KB' && b.entry.sector !== 'ROOT_KB') return 1;
    return a.entry.vaultPath.localeCompare(b.entry.vaultPath);
  });

  // Bound disk body scan to top ~900 prioritized notes + time budget so searches finish in < 250ms
  const scanPool = scoredMeta.slice(0, 900);
  const hits: VaultDeepSearchHit[] = [];
  const startMs = Date.now();
  const batchSize = 32;

  for (let i = 0; i < scanPool.length; i += batchSize) {
    if (Date.now() - startMs > 1200 && hits.length >= limit) break;
    const batch = scanPool.slice(i, i + batchSize);

    const batchOut = await Promise.all(
      batch.map(async ({ entry, metaScore }): Promise<VaultDeepSearchHit | null> => {
        if (!['.md', '.txt', '.yaml', '.yml', '.json'].includes(entry.fileExt.toLowerCase())) {
          return metaScore > 0
            ? {
                scope: 'vault',
                vaultPath: entry.vaultPath,
                title: entry.title,
                sector: entry.sector,
                score: metaScore,
                sha256: entry.sha256,
                matchedLines: [],
                snippet: `${entry.sector} · tags: ${entry.tags.slice(0, 4).join(', ')}`,
              }
            : null;
        }

        const absPath = join(runtime.vault.vaultRoot, ...entry.vaultPath.split('/'));
        const raw = await readFile(absPath, 'utf8').catch(() => '');
        if (!raw) return null;

        const sec = validateEntityContent(entry.vaultPath, raw, { requireSchema: false });
        if (sec.issues.some((iss) => iss.code === 'SECRET_DETECTED')) {
          return null;
        }

        const lower = raw.toLowerCase();
        let bodyScore = 0;
        for (const t of terms) {
          if (lower.includes(t)) bodyScore += 2;
        }

        const total = metaScore + bodyScore;
        if (total <= 0) return null;

        const matchedLines = collectMatchedLines(raw, terms, 3);
        const snippet =
          matchedLines.map((m) => `L${m.line}: ${m.text}`).join(' | ') ||
          redactSecrets(raw.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim()).slice(0, 220);

        return {
          scope: 'vault',
          vaultPath: entry.vaultPath,
          title: entry.title,
          sector: entry.sector,
          score: total,
          sha256: entry.sha256,
          matchedLines,
          snippet,
        };
      }),
    );

    for (const item of batchOut) {
      if (item) hits.push(item);
    }
  }

  hits.sort((a, b) => b.score - a.score || a.vaultPath.localeCompare(b.vaultPath));
  return hits.slice(0, limit);
}

/**
 * Directly reads and inspects any safe file inside the Obsidian Vault or the XYP3RN OS codebase.
 */
export async function inspectVaultOrOsFile(
  runtime: Os3JarvisRuntime,
  scope: 'vault' | 'os',
  relPath: string,
  options: { readonly maxChars?: number | undefined } = {},
): Promise<JarvisInspectionResult> {
  const maxChars = Math.min(32_000, Math.max(500, options.maxChars ?? 16_000));

  if (scope === 'vault') {
    const resolved = await resolveVaultPath(runtime.vault.vaultRoot, relPath, { requireSectorPrefix: false });
    const doc = await runtime.vault.readNote(resolved.normalizedPath, 'jarvis-inspector');
    const sec = validateEntityContent(doc.vaultPath, doc.rawContent, { requireSchema: false });
    if (sec.issues.some((i) => i.code === 'SECRET_DETECTED')) {
      throw new Error(`403 FORBIDDEN: secret material detected in "${doc.vaultPath}"`);
    }
    const safeRaw = redactSecrets(doc.rawContent);
    const truncated = safeRaw.length > maxChars;
    return {
      ok: true,
      scope: 'vault',
      path: doc.vaultPath,
      title: typeof doc.frontmatter.title === 'string' && doc.frontmatter.title.trim() ? doc.frontmatter.title : doc.vaultPath,
      sector: doc.sector,
      lineCount: safeRaw.split(/\r?\n/).length,
      symbols: [],
      content: truncated ? `${safeRaw.slice(0, maxChars)}\n\n... [truncated]` : safeRaw,
      truncated,
      sha256: doc.sha256,
    };
  }

  const safeOs = await resolveOsSafeFile(runtime.repoRoot, relPath);
  const raw = await readFile(safeOs.abs, 'utf8');
  const sec = validateEntityContent(safeOs.rel, raw, { requireSchema: false });
  if (sec.issues.some((i) => i.code === 'SECRET_DETECTED')) {
    throw new Error(`403 FORBIDDEN: secret material detected in "${safeOs.rel}"`);
  }
  const safeContent = redactSecrets(raw);
  const sha256 = createHash('sha256').update(safeContent).digest('hex');
  const symbols = extractCodeSymbols(safeContent);
  const truncated = safeContent.length > maxChars;

  return {
    ok: true,
    scope: 'os',
    path: safeOs.rel,
    title: safeOs.rel.split('/').at(-1) ?? safeOs.rel,
    lineCount: safeContent.split(/\r?\n/).length,
    symbols,
    content: truncated ? `${safeContent.slice(0, maxChars)}\n\n... [truncated]` : safeContent,
    truncated,
    sha256,
  };
}

function resolveAvailableLlmModel(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.OPENROUTER_API_KEY?.trim()) return 'openrouter:anthropic/claude-3.5-haiku';
  if (env.ANTHROPIC_API_KEY?.trim() || env.LLM_ENGINE === 'claude-code') return 'anthropic:claude-3-5-haiku-latest';
  if (env.GROQ_API_KEY?.trim()) return 'groq:llama-3.1-8b-instant';
  return null;
}

/**
 * Answers a natural question or inspect directive across BOTH the entire Obsidian Vault
 * and the Whole XYP3RN OS codebase (files, functions, agents, workflows), citing verified sources.
 */
export async function answerAcrossVaultAndOs(
  runtime: Os3JarvisRuntime,
  query: string,
): Promise<{
  readonly reply: string;
  readonly citations: readonly JarvisCitation[];
  readonly vaultHits: readonly VaultDeepSearchHit[];
  readonly osHits: readonly OsSearchHit[];
}> {
  const [vaultHits, osHits] = await Promise.all([
    searchWholeVault(runtime, query, { limit: 4 }),
    searchWholeOs(runtime, query, { limit: 4 }),
  ]);

  const terms = extractSearchTerms(query);
  const matchedAgents = runtime.agents
    .list()
    .filter((a) => terms.some((t) => `${a.name} ${a.domain} ${a.role}`.toLowerCase().includes(t)))
    .slice(0, 4);

  const citations: JarvisCitation[] = [
    ...osHits.map((o) => ({
      scope: 'os' as const,
      path: o.path,
      title: o.title,
      symbols: o.symbols.map((s) => `${s.kind} ${s.name}@L${s.line}`),
      snippet: o.snippet,
    })),
    ...vaultHits.map((v) => ({
      scope: 'vault' as const,
      path: v.vaultPath,
      title: v.title,
      snippet: v.snippet,
      sha256: v.sha256,
    })),
  ];

  // Optional LLM synthesis over the retrieved OS & Vault facts when provider credentials exist
  const llmModel = resolveAvailableLlmModel(process.env);
  if (llmModel && citations.length > 0) {
    try {
      const gw = new Os3ModelGateway({ db: runtime.db, env: process.env });
      const res = await gw.complete({
        agentName: 'jarvis-inspector',
        model: llmModel,
        request: {
          timeoutMs: 12_000,
          maxTokens: 700,
          system:
            'You are JARVIS inside XYP3RN OS 3.0 with read-only access to the Obsidian Vault and the XYP3RN OS codebase. Answer concisely using ONLY the observed files, functions, and snippets provided. Cite exact paths and symbol names.',
          user: JSON.stringify({
            question: query,
            matchedAgents: matchedAgents.map((a) => ({ name: a.name, domain: a.domain, role: a.role })),
            osFilesAndFunctions: osHits.slice(0, 3),
            vaultNotes: vaultHits.slice(0, 3),
          }),
          schema: {
            name: 'jarvis_os_vault_answer',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['answer'],
              properties: { answer: { type: 'string' } },
            },
          },
        },
      });
      const json = res.json as Partial<{ answer: string }>;
      if (typeof json.answer === 'string' && json.answer.trim()) {
        return {
          reply: redactSecrets(json.answer).trim(),
          citations,
          vaultHits,
          osHits,
        };
      }
    } catch {
      // Deterministic grounded synthesis follows cleanly if LLM unavailable
    }
  }

  if (osHits.length === 0 && vaultHits.length === 0 && matchedAgents.length === 0) {
    const stats = runtime.db.getIndexStats();
    return {
      reply: `Searched across the Whole OS codebase and all ${stats.totalFiles} Obsidian Vault notes for "${query}", with 0 direct matches. Try specific function names, filenames, or topics (e.g. "VoiceAssistantOrb", "VaultEngine", "UK Drill").`,
      citations: [],
      vaultHits: [],
      osHits: [],
    };
  }

  const parts: string[] = [];
  if (osHits.length > 0) {
    const topOs = osHits[0]!;
    const symList =
      topOs.symbols.length > 0
        ? `functions/symbols: ${topOs.symbols
            .slice(0, 5)
            .map((s) => `${s.name}()@L${s.line}`)
            .join(', ')}`
        : topOs.snippet.slice(0, 140);
    parts.push(
      `Whole OS matched ${osHits.length} file(s) — top: ${topOs.path} (${symList}).`,
    );
  }
  if (vaultHits.length > 0) {
    const topVault = vaultHits[0]!;
    parts.push(
      `Obsidian Vault matched ${vaultHits.length} note(s) — top: "${topVault.title}" (${topVault.vaultPath}): ${topVault.snippet.slice(0, 160)}`,
    );
  }
  if (matchedAgents.length > 0) {
    parts.push(
      `OS Agents: ${matchedAgents.map((a) => `${a.name} [${a.domain}]`).join(', ')}.`,
    );
  }

  return {
    reply: redactSecrets(parts.join(' ')),
    citations,
    vaultHits,
    osHits,
  };
}
