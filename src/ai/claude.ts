import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL } from './model';
import type { EdgeFadeShape, TransferCheck, TransferSettings, TuneResult } from '../core/transfer';

/**
 * Claude review of a DTF transfer.
 *
 * The deterministic auto-tuner does the measurable part: it finds settings
 * that keep the print from going milky and the shirt from getting speckled.
 * Claude adds what numbers cannot: it looks at the art and the proof on the
 * shirt and judges which details matter (a face, a line of text, a glow), and
 * whether edges want fading. Its proposal is validated and clamped here, and
 * the studio re-measures it before applying — Claude can advise, it cannot
 * make the print worse.
 *
 * Runs entirely from the browser with the user's own API key; nothing is sent
 * unless the user has opted in.
 */

export { CLAUDE_MODEL };

/** Server-side refusal fallback: Anthropic picks the substitute by category. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface ClaudeContext {
  garmentName: string;
  garmentHex: string;
  shirtSize: string;
  placementName: string;
  widthMm: number;
  heightMm: number;
  fabric: string;
}

export interface ClaudeReviewInput {
  apiKey: string;
  /** Language of the summary and risks shown to the user; Hungarian when omitted. */
  language?: 'hu' | 'en';
  /** Base64 PNG (no data: prefix) of the original art, reduced. */
  originalPng: string;
  /** Base64 PNG of the tuned transfer as it looks on the shirt. */
  onShirtPng: string;
  /** Base64 PNG of the problems overlay, when available. */
  problemsPng?: string;
  tune: TuneResult;
  checks: TransferCheck[];
  current: TransferSettings;
  maxLpi: number;
  context: ClaudeContext;
  signal?: AbortSignal;
}

export interface ClaudeProposal {
  summary: string;
  risks: string[];
  choice: 'keep' | 'candidate' | 'custom';
  candidateIndex: number;
  knockout: { tolerance: number; solidPoint: number; density: number };
  edgeFade: { shape: EdgeFadeShape; widthMm: number };
  adjust: { contrast: number; saturation: number; sharpen: number };
  lpi: number;
}

/**
 * The response contract, sent as `output_config.format` (JSON schema). Only
 * keywords structured outputs accept are used; numeric ranges live in the
 * descriptions and are enforced by `sanitizeProposal` on the way back in.
 */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'risks', 'choice', 'candidateIndex', 'knockout', 'edgeFade', 'adjust', 'lpi'],
  properties: {
    summary: {
      type: 'string',
      description: 'In the answer language named in the request, 1-3 sentences: what you decided and why, for a non-expert.',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'In the answer language named in the request, concrete remaining risks the user should know about (may be empty).',
    },
    choice: {
      type: 'string',
      enum: ['keep', 'candidate', 'custom'],
      description:
        'keep = the tuned settings are right; candidate = use candidateIndex; custom = use the knockout values given.',
    },
    candidateIndex: {
      type: 'integer',
      description: '0-based index into candidates; used only when choice is candidate.',
    },
    knockout: {
      type: 'object',
      additionalProperties: false,
      required: ['tolerance', 'solidPoint', 'density'],
      properties: {
        tolerance: { type: 'number', description: '0..0.4' },
        solidPoint: { type: 'number', description: 'above tolerance, up to 1' },
        density: { type: 'number', description: '0.5..2' },
      },
    },
    edgeFade: {
      type: 'object',
      additionalProperties: false,
      required: ['shape', 'widthMm'],
      properties: {
        shape: { type: 'string', enum: ['none', 'rect', 'ellipse'] },
        widthMm: { type: 'number', description: '2..80' },
      },
    },
    adjust: {
      type: 'object',
      additionalProperties: false,
      required: ['contrast', 'saturation', 'sharpen'],
      properties: {
        contrast: { type: 'number', description: '-0.5..0.8, 0 = unchanged' },
        saturation: { type: 'number', description: '-1..1, 0 = unchanged' },
        sharpen: { type: 'number', description: '0..2, 0 = unchanged' },
      },
    },
    lpi: {
      type: 'integer',
      description: 'AM halftone lines per inch, 20..maxLpi',
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a senior DTF (direct-to-film) prepress technician reviewing a heat-transfer file for a garment.

Process facts you rely on:
- The RIP prints white underbase under every opaque pixel of the transparent PNG. Semi-transparent pixels are already removed by the tool.
- On a dark shirt, dark tones must come from the shirt showing between halftone dots ("black knockout"). Ink that is nearly the shirt colour, printed over white, looks chalky and grey — the user calls this "tejes" (milky). This is the main failure to avoid.
- The white underbase is choked behind colour edges; too little choke shows a white halo around every edge and dot.
- Dots below the minimum size flake off in the wash; very sparse isolated dots read as dirt on the shirt.
- Faces, eyes, and text must stay readable; glows and grain are expected to become dots.

You receive: the original art, the tuned transfer as it looks on the shirt, optionally a problems overlay (red = element losing its white, orange = hairline, cyan = milky ink), the tuner's diagnosis and metrics, a few candidate settings with their measured metrics, and the current preflight checks.

Decide:
1. Whether the tuned settings are right ("keep"), a listed candidate is better for this particular image ("candidate"), or small custom knockout values are warranted ("custom"). Prefer the measured candidates; only go custom with a clear visual reason. Never propose settings whose milky share would clearly exceed the tuned one.
2. Edge fade: use "rect" or "ellipse" only if the art is a rectangular photo whose edge would print as a hard patch; otherwise "none".
3. Photo adjustments only when the art clearly needs them; 0 means unchanged.
4. lpi: at most the given maxLpi.

Write "summary" and every item of "risks" in the answer language named at the start of the request (Hungarian if none is named), plainly, for someone who does not know printing terms. Be specific about what you see in the image.`;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Validate a model response against the contract and clamp every value into
 * its legal range. Anything malformed falls back to the tuned settings.
 */
export function sanitizeProposal(raw: unknown, input: { tune: TuneResult; maxLpi: number }): ClaudeProposal {
  const tuned = input.tune.settings;
  const r = isRecord(raw) ? raw : {};
  const choiceRaw = r.choice;
  const choice: ClaudeProposal['choice'] = choiceRaw === 'candidate' || choiceRaw === 'custom' ? choiceRaw : 'keep';
  const idx = Math.round(num(r, 'candidateIndex', 0));
  const candidateIndex = clamp(idx, 0, Math.max(0, input.tune.candidates.length - 1));

  const ko = isRecord(r.knockout) ? r.knockout : {};
  const tolerance = clamp(num(ko, 'tolerance', tuned.knockout.tolerance), 0, 0.4);
  const solidPoint = clamp(num(ko, 'solidPoint', tuned.knockout.solidPoint), tolerance + 0.01, 1);
  const density = clamp(num(ko, 'density', tuned.knockout.density), 0.5, 2);

  const ef = isRecord(r.edgeFade) ? r.edgeFade : {};
  const shapeRaw = ef.shape;
  const shape: EdgeFadeShape = shapeRaw === 'rect' || shapeRaw === 'ellipse' ? shapeRaw : 'none';
  const widthMm = clamp(num(ef, 'widthMm', tuned.edgeFade.widthMm), 2, 80);

  const ad = isRecord(r.adjust) ? r.adjust : {};
  const adjust = {
    contrast: clamp(num(ad, 'contrast', 0), -0.5, 0.8),
    saturation: clamp(num(ad, 'saturation', 0), -1, 1),
    sharpen: clamp(num(ad, 'sharpen', 0), 0, 2),
  };

  const lpi = Math.round(clamp(num(r, 'lpi', tuned.screen.lpi), 20, Math.max(20, input.maxLpi)));
  const summary =
    typeof r.summary === 'string' && r.summary.trim() !== '' ? r.summary.trim() : 'Claude nem adott indoklást.';
  const risks = Array.isArray(r.risks) ? r.risks.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];

  return {
    summary,
    risks,
    choice,
    candidateIndex,
    knockout: { tolerance, solidPoint, density },
    edgeFade: { shape, widthMm },
    adjust,
    lpi,
  };
}

/** Settings a sanitized proposal amounts to, starting from the tuned ones. */
export function applyProposal(p: ClaudeProposal, tune: TuneResult): TransferSettings {
  const base =
    p.choice === 'candidate' && tune.candidates[p.candidateIndex]
      ? tune.candidates[p.candidateIndex].settings
      : tune.settings;
  const knockout = p.choice === 'custom' ? { enabled: true, ...p.knockout } : base.knockout;
  return {
    ...base,
    knockout,
    edgeFade: p.edgeFade,
    adjust: p.adjust,
    screen: {
      ...base.screen,
      lpi: base.screen.kind === 'am' ? p.lpi : base.screen.lpi,
    },
  };
}

function metricsText(input: ClaudeReviewInput): string {
  const t = input.tune;
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const cand = t.candidates.map((c, i) => ({
    index: i,
    label: c.label,
    knockout: c.settings.knockout,
    milky: pct(c.metrics.milky),
    toneError: c.metrics.toneError.toFixed(4),
    dotShare: pct(c.metrics.dotShare),
    sparse: pct(c.metrics.sparse),
    ink: pct(c.metrics.ink),
  }));
  return JSON.stringify(
    {
      garment: input.context,
      diagnosis: t.diagnosis,
      tunedSettings: {
        knockout: t.settings.knockout,
        lpi: t.settings.screen.lpi,
        shape: t.settings.screen.shape,
        chokeMm: t.settings.chokeMm,
        edgeFade: input.current.edgeFade,
        adjust: input.current.adjust,
      },
      tunedMetrics: t.metrics,
      beforeMetrics: t.before,
      candidates: cand,
      maxLpi: input.maxLpi,
      preflight: input.checks.map((c) => ({ level: c.level, title: c.title })),
      tunerNotes: t.notes,
    },
    null,
    1,
  );
}

/** Typed error for the UI (Hungarian at the source; the UI translates it). */
export class ClaudeReviewError extends Error {}

export async function reviewWithClaude(input: ClaudeReviewInput): Promise<ClaudeProposal> {
  const client = new Anthropic({
    apiKey: input.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: 'text', text: `Answer language: ${input.language === 'en' ? 'English' : 'Hungarian'}.` },
    { type: 'text', text: '1. kép — az eredeti minta:' },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: input.originalPng,
      },
    },
    {
      type: 'text',
      text: '2. kép — a hangolt transzfer a pólón, normál távolságból nézve:',
    },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: input.onShirtPng,
      },
    },
  ];
  if (input.problemsPng) {
    content.push(
      {
        type: 'text',
        text: '3. kép — problématérkép (piros: fehér nélkül maradó elem, narancs: hajszálvonal, cián: tejes festék):',
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: input.problemsPng,
        },
      },
    );
  }
  content.push({
    type: 'text',
    text: `Mérések és jelöltek (JSON):\n${metricsText(input)}`,
  });

  let message: Anthropic.Beta.BetaMessage;
  try {
    // Streamed: adaptive thinking on three images can run long, and a stream
    // never sits idle long enough for a proxy or browser to drop it.
    message = await client.beta.messages
      .stream(
        {
          model: CLAUDE_MODEL,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
          output_config: {
            format: { type: 'json_schema', schema: REVIEW_SCHEMA },
          },
        },
        { signal: input.signal },
      )
      .finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new ClaudeReviewError('Az API-kulcs érvénytelen vagy lejárt.');
    } else if (error instanceof Anthropic.PermissionDeniedError) {
      throw new ClaudeReviewError('Ennek a kulcsnak nincs hozzáférése a modellhez.');
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new ClaudeReviewError('Túl sok kérés — várj egy kicsit, és próbáld újra.');
    } else if (error instanceof Anthropic.BadRequestError) {
      throw new ClaudeReviewError(`A kérést elutasította az API: ${error.message}`);
    } else if (error instanceof Anthropic.APIConnectionError) {
      throw new ClaudeReviewError('Nem sikerült elérni a Claude-ot — nincs internet, vagy blokkolja valami.');
    } else if (error instanceof Anthropic.APIError) {
      throw new ClaudeReviewError(`Claude API hiba (${String(error.status)}): ${error.message}`);
    }
    throw error;
  }

  if (message.stop_reason === 'refusal') {
    throw new ClaudeReviewError('Claude ezt a kérést nem vállalta. A helyi automatikus beállítás érvényben marad.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ClaudeReviewError('A válasz nem fért ki — próbáld újra.');
  }
  return sanitizeProposal(parseReviewText(message.content), {
    tune: input.tune,
    maxLpi: input.maxLpi,
  });
}

/**
 * The structured answer arrives as the text block (thinking blocks, if any,
 * come first). Parsed here; validated by `sanitizeProposal`.
 */
export function parseReviewText(content: readonly Anthropic.Beta.BetaContentBlock[]): unknown {
  for (const block of content) {
    if (block.type !== 'text') continue;
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      throw new ClaudeReviewError('Claude válasza nem értelmezhető JSON.');
    }
  }
  throw new ClaudeReviewError('Claude nem adott szöveges választ.');
}
