import { PipelineError, asPipelineError, fromGnaniStatus } from './errors';
import type { TranscriptLine } from './types';

const BASE = process.env.GNANI_BASE_URL || 'https://api.vachana.ai';
const MODEL = process.env.GNANI_MODEL || 'gnani-prisma-v2.5';

/** Hard limits published by Gnani — encoded here so the pipeline can plan around them. */
export const GNANI_LIMITS = {
  restMaxSeconds: 60,
  restIdealSeconds: 30,
  batchMaxFileBytes: 10 * 1024 * 1024,
  batchMaxFilesPerJob: 100,
  batchMinPollSeconds: 10,
};

function apiKey(): string {
  const key = process.env.GNANI_API_KEY;
  if (!key) {
    throw new PipelineError('CONFIG_MISSING', 'GNANI_API_KEY is not configured on the server.', {
      hint: 'Add GNANI_API_KEY in the hosting provider’s environment variables and redeploy.',
      retryable: false,
    });
  }
  return key;
}

export function gnaniConfigured(): boolean {
  return Boolean(process.env.GNANI_API_KEY);
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new PipelineError('ASR_TIMEOUT', `Gnani did not respond within ${Math.round(ms / 1000)}s.`, {
        hint: 'The request is retried automatically with backoff.',
        retryable: true,
      });
    }
    throw asPipelineError(err);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Synchronous REST transcription (clips up to 60 s)                    */
/* ------------------------------------------------------------------ */

export async function transcribeRest(opts: {
  audio: ArrayBuffer;
  filename: string;
  contentType: string;
  languageCode: string;
  timeoutMs?: number;
}): Promise<string> {
  const form = new FormData();
  form.append('audio_file', new Blob([opts.audio], { type: opts.contentType }), opts.filename);
  form.append('language_code', opts.languageCode);
  // `transcribe` turns on Inverse Text Normalisation: "five thousand rupees" -> "₹5,000".
  form.append('format', 'transcribe');
  form.append('itn_native_numerals', 'false');

  const res = await withTimeout(opts.timeoutMs ?? 90_000, (signal) =>
    fetch(`${BASE}/stt/v3`, {
      method: 'POST',
      headers: { 'X-API-Key-ID': apiKey() },
      body: form,
      signal,
    }),
  );

  const text = await res.text();
  if (!res.ok) throw fromGnaniStatus(res.status, text);

  let parsed: { success?: boolean; transcript?: string; error?: { message?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PipelineError('UNKNOWN', 'Gnani returned a response that was not valid JSON.', {
      retryable: true,
    });
  }
  if (parsed.success === false) {
    throw new PipelineError('ASR_BAD_REQUEST', parsed.error?.message || 'Transcription failed.', {
      retryable: false,
    });
  }
  return (parsed.transcript || '').trim();
}

/* ------------------------------------------------------------------ */
/* Batch Jobs API (long / many files)                                   */
/* ------------------------------------------------------------------ */

export interface BatchProgress {
  total_files: number;
  completed_files: number;
  failed_files: number;
  in_progress_files: number;
  queued_files: number;
  cancelled_files: number;
}

export interface BatchJobStatus {
  status: string;
  progress: BatchProgress;
  cancelReason: string | null;
}

export interface BatchFile {
  file_id: string;
  original_path: string;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | string;
  transcript_url: string | null;
  error_message: string | null;
  duration_seconds: string | null;
}

const BATCH_TERMINAL = [
  'COMPLETED',
  'PARTIAL_FAILURE',
  'FAILED',
  'START_FAILED',
  'CANCELLED',
];

export function isBatchTerminal(status: string): boolean {
  return BATCH_TERMINAL.includes(status);
}

/** Creates a job from public HTTPS URLs — Gnani pulls the audio itself, so we never re-upload. */
export async function createBatchJobFromUrls(urls: string[], languageCode: string): Promise<string> {
  const res = await withTimeout(30_000, (signal) =>
    fetch(`${BASE}/stt/v3/batch/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': apiKey() },
      body: JSON.stringify({
        config: {
          model: MODEL,
          language_code: languageCode,
          mode: 'transcribe',
          with_diarization: false,
          is_multi_channel: false,
        },
        source: { type: 'cloud_storage', auth: { mode: 'public' }, paths: urls },
      }),
      signal,
    }),
  );

  const text = await res.text();
  if (!res.ok) throw fromGnaniStatus(res.status, text);

  const parsed = JSON.parse(text) as { job_id?: string };
  if (!parsed.job_id) {
    throw new PipelineError('UNKNOWN', 'Gnani did not return a job id.', { retryable: true });
  }
  return parsed.job_id;
}

/** Creating a job does not start it — this is the step everyone forgets. */
export async function startBatchJob(jobId: string): Promise<void> {
  const res = await withTimeout(30_000, (signal) =>
    fetch(`${BASE}/stt/v3/batch/jobs/${jobId}/start`, {
      method: 'POST',
      headers: { 'X-API-Key-ID': apiKey() },
      signal,
    }),
  );
  if (!res.ok && res.status !== 409) {
    throw fromGnaniStatus(res.status, await res.text());
  }
}

export async function getBatchJob(jobId: string): Promise<BatchJobStatus> {
  const res = await withTimeout(20_000, (signal) =>
    fetch(`${BASE}/stt/v3/batch/jobs/${jobId}`, {
      headers: { 'X-API-Key-ID': apiKey() },
      cache: 'no-store',
      signal,
    }),
  );
  const text = await res.text();
  if (!res.ok) throw fromGnaniStatus(res.status, text);

  const parsed = JSON.parse(text) as {
    status?: string;
    progress?: Partial<BatchProgress>;
    cancel_reason?: string | null;
  };
  return {
    status: parsed.status || 'UNKNOWN',
    progress: {
      total_files: parsed.progress?.total_files ?? 0,
      completed_files: parsed.progress?.completed_files ?? 0,
      failed_files: parsed.progress?.failed_files ?? 0,
      in_progress_files: parsed.progress?.in_progress_files ?? 0,
      queued_files: parsed.progress?.queued_files ?? 0,
      cancelled_files: parsed.progress?.cancelled_files ?? 0,
    },
    cancelReason: parsed.cancel_reason ?? null,
  };
}

/** Lists every file in the job (all statuses) so failures are visible, not silently dropped. */
export async function getBatchJobFiles(jobId: string): Promise<BatchFile[]> {
  const out: BatchFile[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 5; page++) {
    const url = new URL(`${BASE}/stt/v3/batch/jobs/${jobId}/files`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res: Response = await withTimeout(20_000, (signal) =>
      fetch(url.toString(), {
        headers: { 'X-API-Key-ID': apiKey() },
        cache: 'no-store',
        signal,
      }),
    );
    const text = await res.text();
    if (!res.ok) throw fromGnaniStatus(res.status, text);

    const parsed = JSON.parse(text) as {
      data?: BatchFile[];
      pagination?: { has_more?: boolean; next_cursor?: string | null };
    };
    out.push(...(parsed.data || []));
    if (!parsed.pagination?.has_more || !parsed.pagination.next_cursor) break;
    cursor = parsed.pagination.next_cursor;
  }
  return out;
}

/** Pre-signed S3 URL, valid for one hour, no API key required. */
export async function downloadTranscript(
  transcriptUrl: string,
): Promise<{ text: string; lines: TranscriptLine[] }> {
  const res = await withTimeout(30_000, (signal) =>
    fetch(transcriptUrl, { cache: 'no-store', signal }),
  );
  if (!res.ok) {
    throw new PipelineError('ASR_TIMEOUT', `Transcript download failed (${res.status}).`, {
      hint: 'Pre-signed transcript URLs expire after an hour; the job re-requests a fresh one.',
      retryable: true,
    });
  }
  const data = (await res.json()) as {
    full_transcript?: string;
    segments?: { start_time?: number; end_time?: number; text?: string; speaker_id?: number | null }[];
  };

  const lines: TranscriptLine[] = (data.segments || [])
    .filter((s) => (s.text || '').trim().length > 0)
    .map((s) => ({
      start: Number(s.start_time ?? 0),
      end: Number(s.end_time ?? 0),
      text: (s.text || '').trim(),
      speaker: s.speaker_id ?? null,
    }));

  return { text: (data.full_transcript || '').trim(), lines };
}
