import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuffer } from '../../src/core/buffer';
import { DEFAULT_TRANSFER, autoTune } from '../../src/core/transfer';
import { ClaudeReviewError, applyProposal, reviewWithClaude, sanitizeProposal } from '../../src/ai/claude';

function tuneFixture() {
  const src = createBuffer(80, 60);
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      const t = x / 79;
      src.data[i] = 0.06 + 0.8 * t;
      src.data[i + 1] = 0.03;
      src.data[i + 2] = 0.05 + 0.1 * t;
      src.data[i + 3] = 1;
    }
  }
  return autoTune(src, DEFAULT_TRANSFER);
}

describe('Claude proposal handling', () => {
  const tune = tuneFixture();

  it('falls back to the tuned settings for a malformed answer', () => {
    const p = sanitizeProposal('not an object', { tune, maxLpi: 40 });
    expect(p.choice).toBe('keep');
    expect(p.knockout).toEqual({
      tolerance: tune.settings.knockout.tolerance,
      solidPoint: tune.settings.knockout.solidPoint,
      density: tune.settings.knockout.density,
    });
    expect(p.summary.length).toBeGreaterThan(0);
  });

  it('clamps every value into its legal range', () => {
    const p = sanitizeProposal(
      {
        summary: 'ok',
        risks: ['a', 3, null, 'b'],
        choice: 'custom',
        candidateIndex: 99,
        knockout: { tolerance: 5, solidPoint: 0.1, density: 9 },
        edgeFade: { shape: 'star', widthMm: 500 },
        adjust: { contrast: 4, saturation: -7, sharpen: -1 },
        lpi: 120,
      },
      { tune, maxLpi: 35 },
    );
    expect(p.knockout.tolerance).toBe(0.4);
    expect(p.knockout.solidPoint).toBeCloseTo(0.41, 6);
    expect(p.knockout.density).toBe(2);
    expect(p.edgeFade).toEqual({ shape: 'none', widthMm: 80 });
    expect(p.adjust).toEqual({ contrast: 0.8, saturation: -1, sharpen: 0 });
    expect(p.lpi).toBe(35);
    expect(p.risks).toEqual(['a', 'b']);
    expect(p.candidateIndex).toBe(Math.max(0, tune.candidates.length - 1));
  });

  it('rejects non-finite numbers', () => {
    const p = sanitizeProposal(
      { choice: 'custom', knockout: { tolerance: Number.NaN, solidPoint: Infinity, density: 1 } },
      { tune, maxLpi: 40 },
    );
    expect(Number.isFinite(p.knockout.tolerance)).toBe(true);
    expect(Number.isFinite(p.knockout.solidPoint)).toBe(true);
  });

  it('applies keep, candidate and custom choices faithfully', () => {
    const base = sanitizeProposal({ choice: 'keep' }, { tune, maxLpi: 40 });
    expect(applyProposal(base, tune).knockout).toEqual(tune.settings.knockout);

    const cand = sanitizeProposal({ choice: 'candidate', candidateIndex: tune.candidates.length - 1 }, { tune, maxLpi: 40 });
    expect(applyProposal(cand, tune).knockout).toEqual(tune.candidates[tune.candidates.length - 1].settings.knockout);

    const custom = sanitizeProposal(
      { choice: 'custom', knockout: { tolerance: 0.1, solidPoint: 0.7, density: 1.1 } },
      { tune, maxLpi: 40 },
    );
    expect(applyProposal(custom, tune).knockout).toEqual({ enabled: true, tolerance: 0.1, solidPoint: 0.7, density: 1.1 });
  });
});

describe('Claude response parsing', () => {
  it('reads the JSON from the text block, skipping thinking', async () => {
    const { parseReviewText } = await import('../../src/ai/claude');
    const out = parseReviewText([
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'text', text: '{"choice":"keep","summary":"jó"}', citations: null },
    ] as never);
    expect(out).toEqual({ choice: 'keep', summary: 'jó' });
  });

  it('fails clearly on non-JSON text', async () => {
    const { parseReviewText, ClaudeReviewError } = await import('../../src/ai/claude');
    expect(() => parseReviewText([{ type: 'text', text: 'hmm', citations: null }] as never)).toThrow(ClaudeReviewError);
  });
});

describe('reviewWithClaude against a mocked API', () => {
  const tune = tuneFixture();
  const input = {
    apiKey: 'test-key',
    originalPng: 'iVBORw0KGgo=',
    onShirtPng: 'iVBORw0KGgo=',
    tune,
    checks: [],
    current: tune.settings,
    maxLpi: 40,
    context: {
      garmentName: 'Fekete',
      garmentHex: '#0E0E0F',
      shirtSize: 'L',
      placementName: 'Elöl, teljes',
      widthMm: 280,
      heightMm: 280,
      fabric: 'cotton',
    },
  };

  function sse(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): Response {
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  function stream(text: string, stopReason = 'end_turn'): Response {
    const blocks = text
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
        ]
      : [];
    return sse([
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      ...blocks,
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams the request with the expected shape and returns a sanitized proposal', async () => {
    const answer = {
      summary: 'Jó így.',
      risks: ['A glow széle ritkás.'],
      choice: 'custom',
      candidateIndex: 0,
      knockout: { tolerance: 0.12, solidPoint: 0.5, density: 1.1 },
      edgeFade: { shape: 'none', widthMm: 10 },
      adjust: { contrast: 0, saturation: 0, sharpen: 0 },
      lpi: 30,
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => stream(JSON.stringify(answer)));
    vi.stubGlobal('fetch', fetchMock);

    const p = await reviewWithClaude(input);
    expect(p.choice).toBe('custom');
    expect(p.knockout).toEqual({ tolerance: 0.12, solidPoint: 0.5, density: 1.1 });
    expect(p.summary).toBe('Jó így.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/messages');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe('test-key');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-opus-5',
      stream: true,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema' } },
    });
    expect(body.betas).toBeUndefined();
    const messages = body.messages as Array<{ content: Array<{ type: string }> }>;
    expect(messages[0].content.filter((c) => c.type === 'image')).toHaveLength(2);
  });

  it('turns a bad key into a Hungarian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(reviewWithClaude(input)).rejects.toThrow('Az API-kulcs érvénytelen');
  });

  it('reports a refusal instead of applying anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream('', 'refusal')));
    await expect(reviewWithClaude(input)).rejects.toThrow('nem vállalta');
  });

  it('reports unparseable output as a review error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream('ez nem JSON')));
    await expect(reviewWithClaude(input)).rejects.toBeInstanceOf(ClaudeReviewError);
  });
});
