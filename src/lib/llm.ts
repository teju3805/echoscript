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
      return process.env.GEMINI_MODEL || 'gemini-3.7-flash';
    case 'groq':
      return process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
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

/**
 * Every upstream call must finish well inside the 60 s serverless ceiling,
 * otherwise the platform kills the function mid-step and the work is lost.
 * 20 s leaves room for a second provider in the same invocation.
 */
async function post(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
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

/** Cached for the life of the container once we've had to look it up. */
let geminiResolvedModel: string | null = null;

async function discoverGeminiModel(key: string): Promise<string | null> {
  try {
    const res = await post(
      'https://generativelanguage.googleapis.com/v1beta/models',
      { method: 'GET', headers: { 'x-goog-api-key': key } },
      20_000,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const usable = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => (m.name || '').replace(/^models\//, ''))
      .filter((n) => n.startsWith('gemini'));

    // Text-only Flash models, newest first. Skip the specialised endpoints
    // (image, tts, live, embedding) and anything still marked preview.
    const isSpecialised = (n: string) => /image|tts|audio|live|embedding|vision|robotics/.test(n);
    const ranked = (pool: string[]) =>
      [...pool].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    const flash = ranked(usable.filter((n) => n.includes('flash') && !isSpecialised(n) && !n.includes('preview')));
    if (flash.length) return flash[0];

    const anyText = ranked(usable.filter((n) => !isSpecialised(n)));
    return anyText[0] ?? null;
  } catch {
    return null;
  }
}

/** Discovered model ids, cached per provider for the life of the container. */
const resolvedModels: Partial<Record<ProviderId, string>> = {};

/**
 * Ask an OpenAI-compatible provider what it currently serves and pick a usable
 * chat model. Groq in particular retires its whole chat line-up on a schedule
 * (llama-3.3-70b-versatile was decommissioned in August 2026), which silently
 * breaks a deployment that hard-codes a model id.
 */
async function discoverChatModel(base: string, key: string): Promise<string | null> {
  try {
    const res = await post(
      `${base}/models`,
      { method: 'GET', headers: { Authorization: `Bearer ${key}` } },
      15_000,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data || []).map((m) => m.id || '').filter(Boolean);

    // Drop everything that is not a general-purpose chat model.
    const excluded = /whisper|tts|orpheus|guard|embed|moderation|rerank|vision|audio|image|dall|sora/i;
    const chat = ids.filter((id) => !excluded.test(id));
    if (!chat.length) return null;

    // Prefer the larger general models, then anything else that is left.
    const preferred = chat.find((id) => /gpt-oss-120b/i.test(id))
      || chat.find((id) => /120b|70b/i.test(id))
      || chat.find((id) => /gpt-oss/i.test(id))
      || chat.find((id) => /instruct|chat|versatile/i.test(id));
    return preferred || chat[0];
  } catch {
    return null;
  }
}

async function callProvider(p: ProviderId, prompt: string): Promise<string> {
  const key = keyFor(p)!;
  const model = modelFor(p);

  if (p === 'gemini') {
    const callGemini = (m: string) =>
      post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // Gemini 3.x removed the sampling parameters; sending temperature
          // here is rejected. responseMimeType is what we actually need.
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });

    let chosen = geminiResolvedModel || model;
    let res = await callGemini(chosen);

    // Google retires model ids on a schedule, which turns a working deployment
    // into a 404 months later. Rather than hard-fail, ask the API what it
    // currently serves and pick the newest Flash model it offers.
    if (res.status === 404) {
      const discovered = await discoverGeminiModel(key);
      if (discovered && discovered !== chosen) {
        chosen = discovered;
        geminiResolvedModel = discovered;
        res = await callGemini(chosen);
      }
    }

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
  const callChat = (m: string) =>
    post(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: m,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    });

  let chosen = resolvedModels[p] || model;
  let res = await callChat(chosen);

  // A decommissioned model id comes back as 404 (Groq) or 400 (OpenAI). Ask the
  // provider what it actually serves rather than failing the summary.
  if (res.status === 404 || res.status === 400) {
    const discovered = await discoverChatModel(base, key);
    if (discovered && discovered !== chosen) {
      chosen = discovered;
      resolvedModels[p] = discovered;
      res = await callChat(chosen);
    }
  }

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

export class SummariserBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummariserBusy';
  }
}

function isRateLimited(message: string): boolean {
  return /\b429\b|quota|rate limit|resource_exhausted/i.test(message);
}

/** Every provider that has credentials, pinned choice first. */
function configuredProviders(): ProviderId[] {
  const pinned = (process.env.LLM_PROVIDER || '').toLowerCase() as ProviderId;
  const list = ORDER.filter((p) => keyFor(p));
  if (pinned && keyFor(pinned)) return [pinned, ...list.filter((p) => p !== pinned)];
  return list;
}

export async function summarise(
  transcript: string,
  meta: { filename: string; durationSec: number | null; language: string },
  /** When false, a rate limit throws instead of degrading, so the pipeline can retry later. */
  allowDegrade = true,
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

  const providers = configuredProviders();
  if (!providers.length) return extractiveSummary(clean, meta.filename);

  const prompt = buildPrompt(clean, meta);
  let lastError = '';

  // Walk every configured provider before giving up. A quota exhausted on one
  // vendor should not cost the user their summary if another key is present.
  const budgetStart = Date.now();

  for (const provider of providers) {
    // Stop walking providers before the function ceiling rather than being
    // killed halfway through one.
    if (Date.now() - budgetStart > 35_000) break;
    {
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
        // A quota error will not clear on an immediate second attempt.
        if (isRateLimited(lastError)) break;
      }
    }
  }

  // Quotas reset. Let the pipeline back off and come back rather than
  // permanently downgrading a summary the user could have had.
  if (isRateLimited(lastError) && !allowDegrade) {
    throw new SummariserBusy(lastError.slice(0, 160));
  }

  // The transcript is the primary artefact — never fail the whole note because
  // the summariser had a bad day. Degrade to extractive and say so.
  const fallback = extractiveSummary(clean, meta.filename);
  fallback.generatedBy = `extractive fallback (${providers.join('/')} failed: ${lastError.slice(0, 120)})`;
  return fallback;
}
