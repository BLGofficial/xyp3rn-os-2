/** Real checked-in TECH products. Registration is metadata; health requires a runtime probe. */
export const TECH_COMPONENTS = [
  { id: 'products', label: 'Products', sourceRef: 'package.json', description: 'XYP3RN Agentic OS product manifest' },
  { id: 'audio-tools', label: 'Audio Tools · TRACE', sourceRef: 'tech/trace/analysis.ts', description: 'Versioned TRACE analysis intake; external plugin not bundled' },
  { id: 'ai-systems', label: 'AI Systems', sourceRef: 'core/llm/providers.ts', description: 'Registered Anthropic, Groq and OpenRouter provider adapters' },
  { id: 'r-and-d', label: 'R&D', sourceRef: 'tech/backlog.ts', description: 'Frontier-source proposals, human implementation decisions' },
] as const;
