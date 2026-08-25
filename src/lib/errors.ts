/**
 * Every failure the pipeline can hit is normalised into one of these codes.
 * The UI renders `message` (what happened) and `hint` (what to do next), and
 * only offers a Retry button when `retryable` is true.
 */
export type ErrorCode =
  | 'CONFIG_MISSING'
  | 'AUDIO_UNREADABLE'
  | 'AUDIO_TOO_LONG'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_SILENT'
  | 'ASR_AUTH'
  | 'ASR_RATE_LIMIT'
  | 'ASR_BAD_REQUEST'
  | 'ASR_TIMEOUT'
  | 'ASR_UNAVAILABLE'
  | 'ASR_JOB_FAILED'
  | 'ASR_EMPTY'
  | 'LLM_FAILED'
  | 'STORAGE_FAILED'
  | 'NETWORK'
  | 'UNKNOWN';

export class PipelineError extends Error {
  code: ErrorCode;
  hint: string | null;
  retryable: boolean;

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; retryable?: boolean }) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.hint = opts?.hint ?? null;
    this.retryable = opts?.retryable ?? true;
  }
}

export function asPipelineError(err: unknown): PipelineError {
  if (err instanceof PipelineError) return err;
  const message = err instanceof Error ? err.message : String(err);

  if (/abort|timed? ?out|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return new PipelineError('ASR_TIMEOUT', 'The upstream request timed out.', {
      hint: 'This is usually transient. Retrying normally clears it.',
      retryable: true,
    });
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(message)) {
    return new PipelineError('NETWORK', 'Could not reach the upstream service.', {
      hint: 'Network hiccup between the server and the API. Retry in a moment.',
      retryable: true,
    });
  }
  return new PipelineError('UNKNOWN', message || 'Something unexpected went wrong.', {
    retryable: true,
  });
}

/** Maps a Gnani HTTP status to our taxonomy. */
export function fromGnaniStatus(status: number, body: string): PipelineError {
  const snippet = body.slice(0, 400);

  if (status === 401 || status === 403) {
    return new PipelineError('ASR_AUTH', 'Gnani rejected the API key.', {
      hint: 'Check that GNANI_API_KEY is set correctly in the deployment environment and that the key still has credits.',
      retryable: false,
    });
  }
  if (status === 429) {
    return new PipelineError('ASR_RATE_LIMIT', 'Gnani rate limit hit.', {
      hint: 'The pipeline backs off and retries automatically. No action needed.',
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    if (/duration exceeds/i.test(snippet)) {
      return new PipelineError('AUDIO_TOO_LONG', 'A chunk was longer than the 60 s REST limit.', {
        hint: 'Re-upload so the audio is re-segmented, or pick a language that supports batch transcription.',
        retryable: false,
      });
    }
    return new PipelineError('ASR_BAD_REQUEST', `Gnani rejected the request: ${snippet}`, {
      hint: 'Usually an unsupported audio format or language code.',
      retryable: false,
    });
  }
  if (status === 503) {
    return new PipelineError('ASR_UNAVAILABLE', 'The Gnani speech service is temporarily down.', {
      hint: 'Retried automatically with backoff.',
      retryable: true,
    });
  }
  if (status >= 500) {
    return new PipelineError('ASR_UNAVAILABLE', `Gnani returned ${status}.`, {
      hint: 'Transient upstream error — retried automatically.',
      retryable: true,
    });
  }
  return new PipelineError('UNKNOWN', `Gnani returned ${status}: ${snippet}`, { retryable: true });
}
