import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { Os3ModelGateway } from '../llm/os3-model-gateway.ts';
import { redactSecrets } from '../runtime/logger.ts';
import type { Os3JarvisRuntime } from './jarvis-runtime.ts';

/**
 * Exact Obsidian Vault folder dedicated exclusively to reverse-engineered prompts
 * extracted from imported audio files. Audio binaries themselves are never persisted.
 */
export const AUDIO_EXTRACTED_PROMPTS_DIR = '09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS' as const;

export const AUDIO_PROMPT_FACETS = ['style', 'genres', 'vocal', 'flow', 'instruments'] as const;
export type AudioPromptFacet = (typeof AUDIO_PROMPT_FACETS)[number];
export type AudioPromptSaveMode = 'unified' | 'per-facet';

export type AudioStructureSection = {
  readonly label: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly energy: number;
};

export type AudioAcousticTelemetry = {
  readonly fileName: string;
  readonly mimeType?: string | undefined;
  readonly fileSizeBytes?: number | undefined;
  readonly durationSec: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bpm: number;
  readonly bpmConfidence: number;
  readonly musicalKey: string;
  readonly scale: string;
  readonly keyConfidence: number;
  readonly rmsDb: number;
  readonly peakDb: number;
  readonly crestDb: number;
  readonly estimatedLufs: number;
  readonly spectralCentroidHz: number;
  readonly subBassRatio: number;
  readonly lowMidRatio: number;
  readonly vocalMidRatio: number;
  readonly airHighRatio: number;
  readonly stereoWidth: number;
  readonly transientDensity: number;
  readonly swingFactor: number;
  readonly vocalActivityScore: number;
  readonly sections?: readonly AudioStructureSection[] | undefined;
};

export type AudioReverseEngineeredSpec = {
  readonly id: string;
  readonly sourceFileName: string;
  readonly analyzedAt: string;
  readonly title: string;
  readonly analysisMode: 'dsp-telemetry' | 'dsp+llm-enriched';
  readonly summary: string;
  readonly stylePrompt: string;
  readonly expandedPrompt: string;
  readonly negativePrompt: string;
  readonly genres: readonly string[];
  readonly subgenresAndMoods: readonly string[];
  readonly vocalSpec: {
    readonly hasVocals: boolean;
    readonly delivery: string;
    readonly register: string;
    readonly singingStyle: string;
    readonly vocalEffects: readonly string[];
    readonly lyricCadenceHint: string;
  };
  readonly flowSpec: {
    readonly pocket: string;
    readonly cadence: string;
    readonly energyCurve: string;
    readonly rhythmTags: readonly string[];
  };
  readonly instrumentsSpec: {
    readonly drumsAndPercussion: readonly string[];
    readonly bassAndSub: readonly string[];
    readonly melodicAndHarmonic: readonly string[];
    readonly texturesAndFx: readonly string[];
    readonly mixAndMastering: string;
  };
  readonly sunoMetaTags: readonly string[];
  readonly telemetry: AudioAcousticTelemetry;
  readonly relatedVaultNotes: readonly {
    readonly vaultPath: string;
    readonly title: string;
    readonly sector: string;
  }[];
};

export type SaveExtractedAudioPromptsRequest = {
  readonly spec: AudioReverseEngineeredSpec;
  readonly saveMode?: AudioPromptSaveMode | undefined;
  readonly selectedFacets?: readonly AudioPromptFacet[] | undefined;
  readonly customTitle?: string | undefined;
  readonly actor?: string | undefined;
};

export type SavedAudioPromptFile = {
  readonly facet: AudioPromptFacet | 'unified';
  readonly vaultPath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly createdCopy: boolean;
};

export type SaveExtractedAudioPromptsResult = {
  readonly ok: true;
  readonly folder: typeof AUDIO_EXTRACTED_PROMPTS_DIR;
  readonly saveMode: AudioPromptSaveMode;
  readonly savedFiles: readonly SavedAudioPromptFile[];
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const round1 = (value: number): number => Math.round(value * 10) / 10;

const sanitizeTitleFromFilename = (fileName: string): string => {
  const stem = fileName.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  return (
    stem
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Imported Audio Reference'
  );
};

const sanitizeFileSlug = (text: string): string => {
  const cleaned = text
    .normalize('NFKC')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return cleaned || 'Audio-Prompt';
};

const isDarkScale = (scale: string): boolean => /minor|phrygian|dorian|locrian|harmonic/i.test(scale);

function classifyAudioFromTelemetry(t: AudioAcousticTelemetry): {
  genres: string[];
  moods: string[];
  drums: string[];
  bass: string[];
  melodic: string[];
  textures: string[];
  vocal: AudioReverseEngineeredSpec['vocalSpec'];
  flow: AudioReverseEngineeredSpec['flowSpec'];
  mixNotes: string;
  negativeTags: string[];
} {
  const nameLower = t.fileName.toLowerCase();
  const dark = isDarkScale(t.scale);
  const heavySub = t.subBassRatio >= 0.3;
  const crispHighs = t.airHighRatio >= 0.16;
  const denseTransients = t.transientDensity >= 4.4;
  const swung = t.swingFactor >= 0.28;
  const wideStereo = t.stereoWidth >= 0.5;
  const loudMaster = t.estimatedLufs >= -10.5 || t.crestDb <= 8.5;

  const genres: string[] = [];
  const moods: string[] = [];
  const drums: string[] = [];
  const bass: string[] = [];
  const melodic: string[] = [];
  const textures: string[] = [];

  if (nameLower.includes('drill') || (t.bpm >= 134 && t.bpm <= 150 && heavySub && dark)) {
    genres.push('UK Drill', 'Dark Street Trap');
    drums.push('counter-snare bounce on beat 3/4', 'skip-step 16th hi-hat rolls', 'punchy clipped kick');
    bass.push('sliding portamento 808 sub-bass', 'saturated mono sub core below 90 Hz');
    moods.push('nocturnal', 'gritty', 'menacing tension');
  } else if (t.bpm < 90) {
    genres.push(dark ? 'Dark Downtempo R&B' : 'Lo-Fi Chillwave', heavySub ? 'Halftime Bass' : 'Neo-Soul');
    drums.push('laid-back pocket snare', 'textured rimshots', 'soft room kick');
    bass.push(heavySub ? 'deep sustained 808 pedal notes' : 'warm fingered electric bass');
    moods.push(dark ? 'brooding late-night' : 'intimate warm nostalgia');
  } else if (t.bpm >= 90 && t.bpm <= 106) {
    genres.push(swung ? 'Modern Boom Bap' : 'Midtempo Alt-R&B', heavySub ? 'Southern Trap Bounce' : 'Hip-Hop Soul');
    drums.push(swung ? 'humanized swung acoustic snare & kick pocket' : 'tight quantized snap snare');
    bass.push(heavySub ? 'round analog 808 pulse' : 'plucked P-bass warmth');
    moods.push(dark ? 'moody introspective' : 'groove-driven confident');
  } else if (t.bpm > 106 && t.bpm <= 123) {
    genres.push(heavySub ? 'Halftime Electronic Bass' : 'Dark Pop / Afro-Fusion', 'Indie Electronica');
    drums.push('syncopated percussive rim pattern', 'ghost kicks', 'shaker stereo width');
    bass.push('warm sub-octave synth bass', 'analog filter-swept low end');
    moods.push(wideStereo ? 'cinematic cavernous' : 'hypnotic restrained');
  } else if (t.bpm > 123 && t.bpm <= 134) {
    genres.push(dark ? 'Dark Synthwave' : 'Melodic House', 'Club Electronica');
    drums.push('driving four-on-the-floor kick', 'gated crisp claps', 'offbeat open hi-hat shimmer');
    bass.push('rolling analog sequence bassline', 'sidechained sub foundation');
    moods.push(dark ? 'cybernetic neon tension' : 'euphoric driving momentum');
  } else if (t.bpm > 150) {
    genres.push(denseTransients ? 'Liquid / Dark Drum & Bass' : 'Rage / Hyper-Trap', 'Fast Electronic');
    drums.push('rapid breakbeat snare transients', 'crisp top-end cymbals', 'tight transient kick');
    bass.push('modulated Reese bassline', 'distorted overtone sub');
    moods.push('high-adrenaline kinetic urgency');
  } else {
    genres.push(dark ? 'Dark Modern Trap' : 'Contemporary Pop Hybrid');
    drums.push('punchy trap kick & crisp clap', 'rolling hat fills');
    bass.push('clean 808 sub glide');
    moods.push(dark ? 'shadowy atmospheric' : 'bright modern');
  }

  if (t.lowMidRatio >= 0.28) {
    melodic.push(dark ? 'dark nylon/acoustic guitar arpeggio loop' : 'warm analog Rhodes chords');
  }
  if (t.spectralCentroidHz >= 2100 || crispHighs) {
    melodic.push('crystalline high-register synth bells / pluck harmonics');
    textures.push('airy stereo shimmer tail', 'subtle vinyl/analog upper-harmonic exciter');
  } else {
    melodic.push('low-pass filtered obsidian pads', 'somber minor piano motifs');
    textures.push('tape saturation haze', 'subdued room ambience');
  }
  if (wideStereo) {
    textures.push('wide mid-side spatial FX throws', 'panned ear-candy risers');
  }

  const hasVocals = t.vocalActivityScore >= 0.24 && t.vocalMidRatio >= 0.22;
  let vocal: AudioReverseEngineeredSpec['vocalSpec'];
  if (!hasVocals) {
    vocal = {
      hasVocals: false,
      delivery: 'Instrumental / Beat Stem Focus (no dominant continuous lead vocal detected)',
      register: 'Instrumental headroom open in 1.2–3.8 kHz vocal pocket',
      singingStyle: 'Ready for baritone rap or moody falsetto vocal overlay',
      vocalEffects: ['Room plate space left clear for topline', 'Gentle 2.5 kHz sidechain carve'],
      lyricCadenceHint: `${Math.round(t.bpm)} BPM (${t.musicalKey} ${t.scale}) suits sparse 8-bar phrasing with space between hook hits.`,
    };
  } else {
    const rapHeavy = denseTransients && t.vocalActivityScore < 0.58;
    const chestRegister = t.lowMidRatio > t.airHighRatio * 1.15;
    vocal = {
      hasVocals: true,
      delivery: rapHeavy
        ? 'Rhythmic percussive rap delivery with tight consonant articulation and doubled ad-lib punches'
        : 'Expressive melodic vocal performance balancing sustained phrases and rhythmic cadence transitions',
      register: chestRegister ? 'Low-Mid Baritone / Warm Chest Register (approx. A2–G3)' : 'Tenor / Mid-High Expressive Register (approx. C3–E4)',
      singingStyle: rapHeavy
        ? 'Dry close-mic deadpan delivery in verses with half-sung minor melody lifts in the hook'
        : 'Breathy close-mic verse phrasing swelling into layered wide harmonies on chorus hooks',
      vocalEffects: [
        'Fast optical + FET parallel vocal compression',
        wideStereo ? 'Stereo ping-pong / dotted-eighth dark delay throws' : 'Tight mono slapback presence + short plate tail',
        crispHighs ? 'Air shelf boost around 10–12 kHz with controlled de-essing' : 'Warm low-pass lo-fi telephone layer on ad-libs',
      ],
      lyricCadenceHint: swung
        ? 'Lean slightly behind the snare beat using internal multi-syllabic rhymes and breath rests on beat 4.'
        : 'Lock syllable stresses onto 16th-note subdivisions with double-time bursts before bar turnarounds.',
    };
  }

  const flow: AudioReverseEngineeredSpec['flowSpec'] = {
    pocket: swung
      ? `Swung pocket (${Math.round(t.swingFactor * 100)}% groove feel) around ${Math.round(t.bpm)} BPM`
      : `Locked precision pocket (${Math.round(t.bpm)} BPM ${t.scale}) with crisp downbeat anchor`,
    cadence: denseTransients
      ? 'Rapid staccato syllable bursts interleaved with sudden half-bar dropout pauses'
      : 'Hypnotic sustained phrasing gliding across bar boundaries with atmospheric sustain',
    energyCurve:
      t.sections && t.sections.length > 0
        ? t.sections.map((s) => `${s.label} (${s.startSec.toFixed(0)}s-${s.endSec.toFixed(0)}s)`).join(' -> ')
        : 'Filtered atmospheric intro -> Full sub & drum drop -> Stripped bridge -> Final high-energy hook',
    rhythmTags: [
      `${Math.round(t.bpm)} BPM`,
      swung ? 'Syncopated Swing' : 'Tight Grid Lock',
      heavySub ? 'Sliding 808 Pocket' : 'Balanced Bass Pulse',
      denseTransients ? 'High Transient Snap' : 'Smooth Legato Decay',
    ],
  };

  const mixNotes = [
    `Estimated loudness ~${round1(t.estimatedLufs)} LUFS (RMS ${round1(t.rmsDb)} dBFS, peak ${round1(t.peakDb)} dBFS, crest ${round1(t.crestDb)} dB)`,
    `Spectral centroid ${Math.round(t.spectralCentroidHz)} Hz`,
    `Sub-808 ratio ${Math.round(t.subBassRatio * 100)}%, vocal-band energy ${Math.round(t.vocalMidRatio * 100)}%, air ${Math.round(t.airHighRatio * 100)}%`,
    `Stereo width ${Math.round(t.stereoWidth * 100)}% · ${loudMaster ? 'Dense competitive limiter master' : 'Open dynamic headroom mix'}`,
  ].join(' · ');

  const negativeTags = [
    'muddy 250Hz boxiness',
    'harsh piercing sibilance',
    dark ? 'overly cheerful major pop synths' : 'flat lifeless mono drums',
    heavySub ? 'phase-canceling wide sub-bass' : 'excessive brickwall pumping',
  ];

  return { genres, moods, drums, bass, melodic, textures, vocal, flow, mixNotes, negativeTags };
}

function resolveAvailableLlmModel(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.OPENROUTER_API_KEY?.trim()) return 'openrouter:anthropic/claude-3.5-haiku';
  if (env.ANTHROPIC_API_KEY?.trim() || env.LLM_ENGINE === 'claude-code') return 'anthropic:claude-3-5-haiku-latest';
  if (env.GROQ_API_KEY?.trim()) return 'groq:llama-3.1-8b-instant';
  return null;
}

/**
 * Reverse-engineers measured acoustic DSP telemetry of an imported audio file into
 * a structured X3LIUS style prompt, genres, vocal/singing DNA, flow spec, and instrumentation breakdown.
 * Never receives or persists raw audio binary bytes.
 */
export async function reverseEngineerAudioTelemetry(
  runtime: Os3JarvisRuntime,
  telemetry: AudioAcousticTelemetry,
  options: { readonly useLlm?: boolean | undefined; readonly titleHint?: string | undefined } = {},
): Promise<AudioReverseEngineeredSpec> {
  const safeTelemetry: AudioAcousticTelemetry = {
    ...telemetry,
    fileName: redactSecrets(telemetry.fileName).trim() || 'imported-audio.wav',
    durationSec: clamp(Number(telemetry.durationSec) || 0, 0.1, 3600),
    sampleRate: clamp(Number(telemetry.sampleRate) || 44100, 8000, 192000),
    channels: clamp(Math.round(Number(telemetry.channels) || 2), 1, 8),
    bpm: clamp(Math.round(Number(telemetry.bpm) || 120), 40, 220),
    bpmConfidence: clamp(Number(telemetry.bpmConfidence) || 0.7, 0, 1),
    musicalKey: telemetry.musicalKey.trim() || 'C',
    scale: telemetry.scale.trim() || 'minor',
    keyConfidence: clamp(Number(telemetry.keyConfidence) || 0.65, 0, 1),
    rmsDb: clamp(Number(telemetry.rmsDb) || -14, -80, 0),
    peakDb: clamp(Number(telemetry.peakDb) || -1, -80, 0.5),
    crestDb: clamp(Number(telemetry.crestDb) || 10, 0, 40),
    estimatedLufs: clamp(Number(telemetry.estimatedLufs) || -12, -70, 0),
    spectralCentroidHz: clamp(Number(telemetry.spectralCentroidHz) || 1800, 60, 18000),
    subBassRatio: clamp(Number(telemetry.subBassRatio) || 0.25, 0, 1),
    lowMidRatio: clamp(Number(telemetry.lowMidRatio) || 0.25, 0, 1),
    vocalMidRatio: clamp(Number(telemetry.vocalMidRatio) || 0.3, 0, 1),
    airHighRatio: clamp(Number(telemetry.airHighRatio) || 0.15, 0, 1),
    stereoWidth: clamp(Number(telemetry.stereoWidth) || 0.45, 0, 1),
    transientDensity: clamp(Number(telemetry.transientDensity) || 3.2, 0, 30),
    swingFactor: clamp(Number(telemetry.swingFactor) || 0.15, 0, 1),
    vocalActivityScore: clamp(Number(telemetry.vocalActivityScore) || 0.35, 0, 1),
    sections: telemetry.sections?.slice(0, 12),
  };

  const title = options.titleHint?.trim() || sanitizeTitleFromFilename(safeTelemetry.fileName);
  const classified = classifyAudioFromTelemetry(safeTelemetry);

  let genres = classified.genres;
  let moods = classified.moods;
  let vocalSpec = classified.vocal;
  let flowSpec = classified.flow;
  let stylePrompt = [
    ...genres.slice(0, 3),
    ...moods.slice(0, 2),
    `${safeTelemetry.bpm} BPM`,
    `${safeTelemetry.musicalKey} ${safeTelemetry.scale}`,
    ...classified.bass.slice(0, 1),
    ...classified.drums.slice(0, 2),
    ...classified.melodic.slice(0, 2),
    vocalSpec.hasVocals ? vocalSpec.singingStyle : 'instrumental arrangement',
  ].join(', ');

  let expandedPrompt = [
    `[Genre & Vibe: ${genres.join(' / ')} — ${moods.join(', ')}]`,
    `[Tempo & Harmony: ${safeTelemetry.bpm} BPM, Key ${safeTelemetry.musicalKey} ${safeTelemetry.scale}, ${flowSpec.pocket}]`,
    `[Instrumentation: ${[...classified.bass, ...classified.drums, ...classified.melodic].join(', ')}]`,
    `[Vocal DNA: ${vocalSpec.hasVocals ? `${vocalSpec.register}, ${vocalSpec.delivery}, FX: ${vocalSpec.vocalEffects.join('; ')}` : vocalSpec.delivery}]`,
    `[Mix Spec: ${classified.mixNotes}]`,
  ].join('\n');

  let analysisMode: 'dsp-telemetry' | 'dsp+llm-enriched' = 'dsp-telemetry';

  const queryTerms = `${genres[0] ?? ''} ${safeTelemetry.musicalKey} suno prompt`.trim();
  const vaultHits = runtime.vault.search(queryTerms, { limit: 5 });
  const relatedVaultNotes = vaultHits.map((hit) => ({
    vaultPath: hit.vaultPath,
    title: hit.title,
    sector: hit.sector,
  }));

  const llmModel = options.useLlm ? resolveAvailableLlmModel(process.env) : null;
  if (llmModel) {
    try {
      const gw = new Os3ModelGateway({ db: runtime.db, env: process.env });
      const res = await gw.complete({
        agentName: 'x3lius-genre-style-researcher',
        model: llmModel,
        request: {
          timeoutMs: 12_000,
          maxTokens: 700,
          system:
            'You are X3LIUS Audio Reverse Engineer inside XYP3RN OS 3.0. Convert quantitative DSP audio telemetry into accurate Suno/music production style prompts, vocal characteristics, and flow phrasing. Stay strictly faithful to the measured telemetry numbers.',
          user: JSON.stringify({ title, telemetry: safeTelemetry, baseline: { genres, moods, stylePrompt } }),
          schema: {
            name: 'audio_reverse_engineer_enrichment',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['stylePrompt', 'expandedPrompt', 'genres', 'moods', 'vocalDelivery', 'flowPocket'],
              properties: {
                stylePrompt: { type: 'string' },
                expandedPrompt: { type: 'string' },
                genres: { type: 'array', items: { type: 'string' } },
                moods: { type: 'array', items: { type: 'string' } },
                vocalDelivery: { type: 'string' },
                flowPocket: { type: 'string' },
              },
            },
          },
        },
      });
      const json = res.json as Partial<{
        stylePrompt: string;
        expandedPrompt: string;
        genres: string[];
        moods: string[];
        vocalDelivery: string;
        flowPocket: string;
      }>;
      if (typeof json.stylePrompt === 'string' && json.stylePrompt.trim()) {
        stylePrompt = redactSecrets(json.stylePrompt).trim();
        analysisMode = 'dsp+llm-enriched';
      }
      if (typeof json.expandedPrompt === 'string' && json.expandedPrompt.trim()) {
        expandedPrompt = redactSecrets(json.expandedPrompt).trim();
      }
      if (Array.isArray(json.genres) && json.genres.length > 0) {
        genres = json.genres.slice(0, 6).map((g) => String(g).trim()).filter(Boolean);
      }
      if (Array.isArray(json.moods) && json.moods.length > 0) {
        moods = json.moods.slice(0, 6).map((m) => String(m).trim()).filter(Boolean);
      }
      if (typeof json.vocalDelivery === 'string' && json.vocalDelivery.trim()) {
        vocalSpec = { ...vocalSpec, delivery: redactSecrets(json.vocalDelivery).trim() };
      }
      if (typeof json.flowPocket === 'string' && json.flowPocket.trim()) {
        flowSpec = { ...flowSpec, pocket: redactSecrets(json.flowPocket).trim() };
      }
    } catch {
      // Deterministic DSP extraction remains primary fallback if LLM provider is unavailable or slow.
    }
  }

  const sunoMetaTags = [
    `[Intro: Atmospheric ${safeTelemetry.musicalKey} ${safeTelemetry.scale} Texture, Filtered ${classified.melodic[0] ?? 'Motif'}]`,
    `[Verse 1: ${vocalSpec.hasVocals ? vocalSpec.singingStyle : 'Sparse Rhythmic Pocket'}, ${flowSpec.pocket}]`,
    `[Pre-Chorus: Rising Filter Tension & Percussion Fills]`,
    `[Chorus / Drop: Full ${classified.bass[0] ?? '808 Sub'} Impact, ${safeTelemetry.bpm} BPM Energy]`,
    `[Outro: Tail Decay & Ambient Fade]`,
  ];

  const spec: AudioReverseEngineeredSpec = {
    id: `audprm-${createHash('sha1').update(`${safeTelemetry.fileName}:${Date.now()}:${randomUUID()}`).digest('hex').slice(0, 12)}`,
    sourceFileName: safeTelemetry.fileName,
    analyzedAt: new Date().toISOString(),
    title,
    analysisMode,
    summary: `${title} · ${genres.slice(0, 2).join(' / ')} at ${safeTelemetry.bpm} BPM in ${safeTelemetry.musicalKey} ${safeTelemetry.scale} (${round1(safeTelemetry.durationSec)}s · ~${round1(safeTelemetry.estimatedLufs)} LUFS).`,
    stylePrompt,
    expandedPrompt,
    negativePrompt: classified.negativeTags.join(', '),
    genres,
    subgenresAndMoods: moods,
    vocalSpec,
    flowSpec,
    instrumentsSpec: {
      drumsAndPercussion: classified.drums,
      bassAndSub: classified.bass,
      melodicAndHarmonic: classified.melodic,
      texturesAndFx: classified.textures,
      mixAndMastering: classified.mixNotes,
    },
    sunoMetaTags,
    telemetry: safeTelemetry,
    relatedVaultNotes,
  };

  try {
    runtime.db.appendEvent({
      eventType: 'audio.reverse_engineer',
      domain: 'RECORDS',
      actor: 'operator',
      payload: {
        id: spec.id,
        fileName: spec.sourceFileName,
        bpm: safeTelemetry.bpm,
        musicalKey: `${safeTelemetry.musicalKey} ${safeTelemetry.scale}`,
        analysisMode,
        binaryStored: false,
      },
    });
  } catch {
    // Non-blocking audit event
  }

  return spec;
}

const renderMarkdownFrontmatter = (fm: Record<string, unknown>, body: string): string => {
  const yamlBlock = toYaml(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${body.trim()}\n`;
};

const buildRelatedLinksBlock = (
  related: AudioReverseEngineeredSpec['relatedVaultNotes'],
  peerLinks: readonly string[] = [],
): string => {
  const lines = [
    ...peerLinks.map((p) => `- [[${p.replace(/\.md$/i, '')}]]`),
    ...related.map((r) => `- [[${r.vaultPath.replace(/\.md$/i, '')}|${r.title}]] (\`${r.sector}\`)`),
  ];
  return lines.length > 0 ? lines.join('\n') : '- _None linked yet_';
};

function renderUnifiedPromptNote(
  spec: AudioReverseEngineeredSpec,
  facets: ReadonlySet<AudioPromptFacet>,
  title: string,
  noteId: string,
  now: string,
): string {
  const sections: string[] = [
    `# ${title}`,
    '',
    `> [!info] Reverse-Engineered Audio Prompt Spec (Source Audio Held in Memory Only — Not Stored)`,
    `> - **Source File:** \`${spec.sourceFileName}\``,
    `> - **Tempo / Key:** \`${spec.telemetry.bpm} BPM\` · \`${spec.telemetry.musicalKey} ${spec.telemetry.scale}\``,
    `> - **Loudness / Crest:** \`~${round1(spec.telemetry.estimatedLufs)} LUFS\` · \`${round1(spec.telemetry.crestDb)} dB crest\``,
    `> - **Duration:** \`${round1(spec.telemetry.durationSec)}s\` · **Extracted:** ${spec.analyzedAt}`,
    '',
  ];

  if (facets.has('style')) {
    sections.push(
      '## Master Style Prompt',
      '',
      '```text',
      spec.stylePrompt,
      '```',
      '',
      '### Expanded Production & Suno Prompt',
      '',
      '```text',
      spec.expandedPrompt,
      '```',
      '',
      `- **Negative / Exclusion Prompt:** \`${spec.negativePrompt}\``,
      '',
    );
  }

  if (facets.has('genres')) {
    sections.push(
      '## Genres, Subgenres & Moods',
      '',
      `- **Primary Genres:** ${spec.genres.map((g) => `\`${g}\``).join(', ')}`,
      `- **Mood & Atmosphere:** ${spec.subgenresAndMoods.map((m) => `\`${m}\``).join(', ')}`,
      '',
    );
  }

  if (facets.has('vocal')) {
    sections.push(
      '## Singing & Vocal DNA',
      '',
      `- **Vocal Presence:** ${spec.vocalSpec.hasVocals ? 'Lead Vocal / Topline Detected' : 'Instrumental / Open Topline Pocket'} (activity score ${Math.round(spec.telemetry.vocalActivityScore * 100)}%)`,
      `- **Delivery:** ${spec.vocalSpec.delivery}`,
      `- **Pitch Register:** ${spec.vocalSpec.register}`,
      `- **Singing / Phrasing Style:** ${spec.vocalSpec.singingStyle}`,
      `- **Vocal FX Chain:** ${spec.vocalSpec.vocalEffects.map((e) => `\`${e}\``).join(', ')}`,
      `- **Lyric & Cadence Hint:** ${spec.vocalSpec.lyricCadenceHint}`,
      '',
    );
  }

  if (facets.has('flow')) {
    sections.push(
      '## Flow, Cadence & Structure',
      '',
      `- **Rhythmic Pocket:** ${spec.flowSpec.pocket}`,
      `- **Cadence Architecture:** ${spec.flowSpec.cadence}`,
      `- **Energy Curve:** ${spec.flowSpec.energyCurve}`,
      `- **Rhythm Tags:** ${spec.flowSpec.rhythmTags.map((r) => `\`${r}\``).join(', ')}`,
      '',
      '### Suno Structure Meta-Tags',
      '',
      '```text',
      ...spec.sunoMetaTags,
      '```',
      '',
    );
  }

  if (facets.has('instruments')) {
    sections.push(
      '## Instruments, Sound Design & Mix Telemetry',
      '',
      `- **Drums & Percussion:** ${spec.instrumentsSpec.drumsAndPercussion.join(', ')}`,
      `- **Bass & Sub-Low:** ${spec.instrumentsSpec.bassAndSub.join(', ')}`,
      `- **Melodic & Harmonic:** ${spec.instrumentsSpec.melodicAndHarmonic.join(', ')}`,
      `- **Textures & FX:** ${spec.instrumentsSpec.texturesAndFx.join(', ')}`,
      `- **Mix & Mastering:** ${spec.instrumentsSpec.mixAndMastering}`,
      '',
      '| Metric | Measured Value |',
      '| :--- | :--- |',
      `| BPM | ${spec.telemetry.bpm} (${Math.round(spec.telemetry.bpmConfidence * 100)}% conf) |`,
      `| Musical Key | ${spec.telemetry.musicalKey} ${spec.telemetry.scale} (${Math.round(spec.telemetry.keyConfidence * 100)}% conf) |`,
      `| Sub-Bass Ratio (20–90 Hz) | ${Math.round(spec.telemetry.subBassRatio * 100)}% |`,
      `| Low-Mid Warmth (90–350 Hz) | ${Math.round(spec.telemetry.lowMidRatio * 100)}% |`,
      `| Vocal Formant Band (350 Hz–4 kHz) | ${Math.round(spec.telemetry.vocalMidRatio * 100)}% |`,
      `| Air / Highs (4–16 kHz) | ${Math.round(spec.telemetry.airHighRatio * 100)}% |`,
      `| Spectral Centroid | ${Math.round(spec.telemetry.spectralCentroidHz)} Hz |`,
      `| Stereo Width | ${Math.round(spec.telemetry.stereoWidth * 100)}% |`,
      '',
    );
  }

  sections.push('## Related Vault Knowledge', '', buildRelatedLinksBlock(spec.relatedVaultNotes), '');

  const fm: Record<string, unknown> = {
    schema: 'xyp3rn.knowledge/v3',
    id: noteId,
    type: 'knowledge',
    title,
    domain: 'RECORDS',
    sector: '09_X3LIUS_MUSIC',
    category: 'audio-extracted-prompt',
    status: 'draft',
    version: 1,
    promoted_via: 'audio-reverse-engineer',
    model_scope: 'suno-v6',
    source_audio: spec.sourceFileName,
    bpm: spec.telemetry.bpm,
    musical_key: `${spec.telemetry.musicalKey} ${spec.telemetry.scale}`,
    included_facets: [...facets],
    tags: ['xyp3rn', 'os3', 'x3lius', 'audio-extracted-prompt', ...spec.genres.map((g) => sanitizeFileSlug(g).toLowerCase())],
    updated_at: now,
    created_at: now,
  };

  return renderMarkdownFrontmatter(fm, sections.join('\n'));
}

const FACET_META: Readonly<Record<AudioPromptFacet, { readonly fileSuffix: string; readonly label: string }>> = {
  style: { fileSuffix: 'Style-Prompt', label: 'Style Prompt' },
  genres: { fileSuffix: 'Genres-Moods', label: 'Genres & Moods' },
  vocal: { fileSuffix: 'Singing-Vocal-DNA', label: 'Singing & Vocal DNA' },
  flow: { fileSuffix: 'Flow-Cadence', label: 'Flow & Cadence' },
  instruments: { fileSuffix: 'Instruments-Mix', label: 'Instruments & Mix Specs' },
};

/**
 * Saves operator-selected extracted prompts as validated Obsidian `.md` files exclusively
 * inside `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/` using VaultEngine No-Overwrite protection.
 */
export async function saveExtractedAudioPromptsToVault(
  runtime: Os3JarvisRuntime,
  req: SaveExtractedAudioPromptsRequest,
): Promise<SaveExtractedAudioPromptsResult> {
  const facetsRaw = req.selectedFacets && req.selectedFacets.length > 0 ? req.selectedFacets : AUDIO_PROMPT_FACETS;
  const facetSet = new Set<AudioPromptFacet>(
    facetsRaw.filter((f): f is AudioPromptFacet => (AUDIO_PROMPT_FACETS as readonly string[]).includes(f)),
  );
  if (facetSet.size === 0) {
    throw new Error('At least one extraction facet (style, genres, vocal, flow, instruments) must be selected to save.');
  }

  const saveMode: AudioPromptSaveMode = req.saveMode === 'per-facet' ? 'per-facet' : 'unified';
  const baseTitle = redactSecrets((req.customTitle ?? req.spec.title).trim()) || 'Imported Audio Prompt';
  const baseSlug = sanitizeFileSlug(baseTitle);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const actor = (req.actor ?? 'operator').trim() || 'operator';

  const targetDirAbs = join(runtime.vault.vaultRoot, ...AUDIO_EXTRACTED_PROMPTS_DIR.split('/'));
  await mkdir(targetDirAbs, { recursive: true });

  const savedFiles: SavedAudioPromptFile[] = [];

  if (saveMode === 'unified') {
    const fileName = `${dateStamp}-${baseSlug}-Extracted-Prompt.md`;
    const vaultPath = `${AUDIO_EXTRACTED_PROMPTS_DIR}/${fileName}`;
    const noteId = `audprm-${baseSlug.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    const content = renderUnifiedPromptNote(req.spec, facetSet, `${baseTitle} — Extracted Prompt Spec`, noteId, now);
    const written = await runtime.vault.writeNote({
      vaultPath,
      content,
      actor,
      reason: `Operator saved reverse-engineered audio prompt for ${req.spec.sourceFileName}`,
      writeMode: 'no-overwrite',
      validateSchema: true,
    });
    savedFiles.push({
      facet: 'unified',
      vaultPath: written.vaultPath,
      sha256: written.sha256,
      byteSize: written.byteSize,
      createdCopy: written.createdCopy,
    });
  } else {
    const plannedPaths = [...facetSet].map(
      (facet) => `${AUDIO_EXTRACTED_PROMPTS_DIR}/${dateStamp}-${baseSlug}-${FACET_META[facet].fileSuffix}.md`,
    );

    for (const facet of facetSet) {
      const meta = FACET_META[facet];
      const vaultPath = `${AUDIO_EXTRACTED_PROMPTS_DIR}/${dateStamp}-${baseSlug}-${meta.fileSuffix}.md`;
      const peerPaths = plannedPaths.filter((p) => p !== vaultPath);
      const noteId = `audprm-${baseSlug.toLowerCase()}-${facet}-${randomUUID().slice(0, 8)}`;
      const facetTitle = `${baseTitle} — ${meta.label}`;
      const singleFacetContent = renderUnifiedPromptNote(req.spec, new Set([facet]), facetTitle, noteId, now);
      const contentWithPeers =
        peerPaths.length > 0
          ? singleFacetContent.replace(
              '## Related Vault Knowledge\n\n',
              `## Sibling Extracted Prompts\n\n${buildRelatedLinksBlock([], peerPaths)}\n\n## Related Vault Knowledge\n\n`,
            )
          : singleFacetContent;

      const written = await runtime.vault.writeNote({
        vaultPath,
        content: contentWithPeers,
        actor,
        reason: `Operator saved ${meta.label} prompt for ${req.spec.sourceFileName}`,
        writeMode: 'no-overwrite',
        validateSchema: true,
      });
      savedFiles.push({
        facet,
        vaultPath: written.vaultPath,
        sha256: written.sha256,
        byteSize: written.byteSize,
        createdCopy: written.createdCopy,
      });
    }
  }

  try {
    runtime.db.appendEvent({
      eventType: 'audio.prompt_saved',
      domain: 'RECORDS',
      actor,
      targetPath: savedFiles[0]?.vaultPath,
      payload: {
        folder: AUDIO_EXTRACTED_PROMPTS_DIR,
        saveMode,
        facets: [...facetSet],
        files: savedFiles.map((f) => f.vaultPath),
      },
    });
  } catch {
    // Non-blocking audit event
  }

  return {
    ok: true,
    folder: AUDIO_EXTRACTED_PROMPTS_DIR,
    saveMode,
    savedFiles,
  };
}

/**
 * Lists all reverse-engineered prompt Markdown notes stored strictly inside
 * `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/`.
 */
export function listExtractedAudioPrompts(runtime: Os3JarvisRuntime) {
  const entries = runtime.vault.list({
    sector: '09_X3LIUS_MUSIC',
    prefix: `${AUDIO_EXTRACTED_PROMPTS_DIR}/`,
    limit: 200,
  });

  return entries.map((e) => ({
    vaultPath: e.vaultPath,
    title: e.title,
    sha256: e.sha256,
    tags: e.tags,
    status: e.status,
    bpm: typeof e.frontmatter.bpm === 'number' ? e.frontmatter.bpm : null,
    musicalKey: typeof e.frontmatter.musical_key === 'string' ? e.frontmatter.musical_key : null,
    sourceAudio: typeof e.frontmatter.source_audio === 'string' ? e.frontmatter.source_audio : null,
    updatedAt: typeof e.frontmatter.updated_at === 'string' ? e.frontmatter.updated_at : e.indexedAt,
  }));
}
