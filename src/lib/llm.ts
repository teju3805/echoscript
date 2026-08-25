import { PipelineError } from './errors';
import type { Summary } from './types';

/**
 * Provider adapters. The first one with credentials wins unless LLM_PROVIDER
 * pins a specific choice. If none are configured the pipeline still completes —
 * it falls back to a deterministic extractive summary and labels it clearly, so
 * the app never lies about who wrote the summary.
 */
export type ProviderId = 'gemini' | 'groq' | 'openai' | 'anthropic' | 'extractive';

const ORDER: ProviderId[] = ['gemini', 'groq', 'openai', 'anthropic'];

function keyFor(p: ProviderId): string | undefined {
  switch (p) {
    case 'gemini':
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    case 'groq':
      return process.env.GROQ_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    default:
      return undefined;
  }
}

export function activeProvider(): ProviderId {
  const pinned = (process.env.LLM_PROVIDER || '').toLowerCase() as ProviderId;
  if (pinned && pinned !== 'extractive' && keyFor(pinned)) return pinned;
  for (const p of ORDER) if (keyFor(p)) return p;
  return 'extractive';
}

export function modelFor(p: ProviderId): string {
  switch (p) {
    case 'gemini':
      return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    case 'groq':
      return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-4o-mini';
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    default:
      return 'extractive-fallback';
  }
}

const SYSTEM = `You summarise transcripts of spoken audio (meetings, lectures, calls, voice notes).
The transcript comes from an automatic speech recogniser, so expect missing punctuation, wrong homophones and occasional garbled words. Read through those errors instead of quoting them.
The audio may be in an Indian language or code-switched Hinglish. Always write the summary in English.
Respond with a single JSON object and nothing else. No markdown fences, no commentary.

Schema:
{
  "title": "short specific title, max 8 words, no trailing punctuation",
  "tldr": "2-3 sentence plain-English summary of what this recording is about",
  "keyPoints": ["3-7 substantive points, each one sentence"],
  "actionItems": ["concrete follow-ups or decisions; empty array if none were stated"],
  "topics": ["2-6 short topic tags, 1-2 words each, lowercase"],
  "tone": "one or two words describing the register, e.g. 'instructional', 'tense negotiation'"
}

Rules: never invent facts that are not in the transcript; if the transcript is too short or unintelligible say so plainly in tldr and return empty arrays.`;

function buildPrompt(transcript: string, meta: { filename: string; durationSec: number | null; language: string }) {
  const minutes = meta.durationSec ? `${Math.round(meta.durationSec / 60)} min` : 'unknown length';
  const clipped = transcript.length > 48_000 ? `${transcript.slice(0, 48_000)}\n…[transcript truncated]` : transcript;
  return `File: ${meta.filename}\nDuration: ${minutes}\nSpoken language: ${meta.language}\n\nTRANSCRIPT:\n"""\n${clipped}\n"""`;
}

async function post(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new PipelineError('LLM_FAILED', 'The summarisation model timed out.', { retryable: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, max);
}

async function callProvider(p: ProviderId, prompt: string): Promise<string> {
  const key = keyFor(p)!;
  const model = modelFor(p);

  if (p === 'gemini') {
    const res = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
  }

  if (p === 'anthropic') {
    const res = await post('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1400,
        temperature: 0.2,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return data.content?.map((c) => (c.type === 'text' ? c.text || '' : '')).join('') || '';
  }

  // Groq and OpenAI share the same chat-completions shape.
  const base = p === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const res = await post(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || '';
}

/* ------------------------------------------------------------------ */
/* Deterministic fallback: frequency-scored extractive summary          */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  ('the a an and or but if then than that this these those is are was were be been being of to in on for with as at by from it its it\'s i you he she they we me him her them my your our their so just like really okay ok yeah yes no not do does did done have has had will would can could should about there here what when where who how why also very much more most some any all one two right now well got get going know think mean say said says thing things lot'
  ).split(' '),
);

function extractiveSummary(transcript: string, filename: string): Summary {
  const sentences = transcript
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.split(' ').length >= 6);

  const freq = new Map<string, number>();
  for (const word of transcript.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []) {
    if (word.length < 4 || STOP.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const score = words.reduce((acc, w) => acc + (freq.get(w) || 0), 0) / Math.sqrt(words.length || 1);
    return { s, i, score };
  });

  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.i - b.i);
  const topics = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);

  return {
    title: filename.replace(/\.[^.]+$/, '').slice(0, 60) || 'Untitled recording',
    tldr:
      top.slice(0, 2).map((t) => t.s).join(' ') ||
      'The transcript was too short to summarise automatically.',
    keyPoints: top.map((t) => t.s.slice(0, 240)),
    actionItems: [],
    topics,
    tone: 'not assessed',
    generatedBy: 'extractive fallback (no LLM key configured)',
  };
}

/* ------------------------------------------------------------------ */

export async function summarise(
  transcript: string,
  meta: { filename: string; durationSec: number | null; language: string },
): Promise<Summary> {
  const clean = transcript.trim();
  if (clean.split(/\s+/).filter(Boolean).length < 12) {
    return {
      title: meta.filename.replace(/\.[^.]+$/, '').slice(0, 60) || 'Very short recording',
      tldr: 'The recogniser returned almost no speech for this recording, so there is nothing substantial to summarise.',
      keyPoints: [],
      actionItems: [],
      topics: [],
      tone: 'n/a',
      generatedBy: 'skipped — transcript too short',
    };
  }

  const provider = activeProvider();
  if (provider === 'extractive') return extractiveSummary(clean, meta.filename);

  const prompt = buildPrompt(clean, meta);
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callProvider(provider, prompt);
      const obj = extractJson(raw);
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      const tldr = typeof obj.tldr === 'string' ? obj.tldr.trim() : '';
      if (!tldr) throw new Error('model returned an empty summary');

      return {
        title: (title || meta.filename.replace(/\.[^.]+$/, '')).slice(0, 90),
        tldr,
        keyPoints: toStringArray(obj.keyPoints, 8),
        actionItems: toStringArray(obj.actionItems, 8),
        topics: toStringArray(obj.topics, 6).map((t) => t.toLowerCase()),
        tone: typeof obj.tone === 'string' ? obj.tone.slice(0, 40) : undefined,
        generatedBy: `${provider}/${modelFor(provider)}`,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // The transcript is the primary artefact — never fail the whole note because
  // the summariser had a bad day. Degrade to extractive and say so.
  const fallback = extractiveSummary(clean, meta.filename);
  fallback.generatedBy = `extractive fallback (${provider} failed: ${lastError.slice(0, 120)})`;
  return fallback;
}
