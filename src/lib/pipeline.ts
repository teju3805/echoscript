import { PipelineError, asPipelineError } from './errors';
import {
  createBatchJobFromUrls,
  downloadTranscript,
  getBatchJob,
  getBatchJobFiles,
  isBatchTerminal,
  startBatchJob,
  transcribeRest,
  GNANI_LIMITS,
} from './gnani';
import { activeProvider, modelFor, summarise } from './llm';
import {
  appendEvent,
  claimNote,
  event,
  getNote,
  getSegments,
  releaseNote,
  updateNote,
  updateSegment,
} from './notes';
import type { NoteRow, SegmentRow, TranscriptLine } from './types';
import { isTerminal, languageSupportsBatch } from './types';

const MAX_ATTEMPTS = 4;
const STEP_BUDGET_MS = 20_000;
const REST_CONCURRENCY = 3;

export interface StepResult {
  id: string;
  status: string;
  detail: string | null;
  done: boolean;
  /** How long the caller should wait before asking for the next step. */
  nextDelayMs: number;
}

function backoffMs(attempt: number): number {
  return [2_000, 6_000, 15_000, 40_000][Math.min(attempt, 3)];
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Runs exactly one unit of work for a note and returns immediately.
 *
 * The whole pipeline is built out of small, idempotent, committed-as-you-go
 * steps rather than one long-running job. That is what makes it survive a
 * serverless function being killed mid-flight: whoever calls next picks up
 * from the last committed state.
 */
export async function step(noteId: string): Promise<StepResult> {
  const note = await claimNote(noteId);

  if (!note) {
    const current = await getNote(noteId);
    if (!current) throw new PipelineError('UNKNOWN', 'Note not found.', { retryable: false });
    const terminal = isTerminal(current.status);
    return {
      id: current.id,
      status: current.status,
      detail: current.stage_detail,
      done: terminal,
      // Not claimable: either finished, someone else holds the lease, or we're
      // inside a backoff window. Either way, wait a beat.
      nextDelayMs: terminal ? 0 : 2_000,
    };
  }

  try {
    const result = await runStep(note);
    return result;
  } catch (err) {
    return await handleFailure(note, asPipelineError(err));
  } finally {
    await releaseNote(noteId).catch(() => undefined);
  }
}

async function runStep(note: NoteRow): Promise<StepResult> {
  switch (note.status) {
    case 'QUEUED':
      return planStrategy(note);
    case 'TRANSCRIBING':
      return note.strategy === 'rest_single' || note.strategy === 'rest_segments'
        ? transcribeOverRest(note)
        : driveBatchJob(note);
    case 'SUMMARIZING':
      return runSummary(note);
    default:
      return {
        id: note.id,
        status: note.status,
        detail: note.stage_detail,
        done: true,
        nextDelayMs: 0,
      };
  }
}

/* ------------------------------------------------------------------ */
/* 1. Strategy selection                                                */
/* ------------------------------------------------------------------ */

async function planStrategy(note: NoteRow): Promise<StepResult> {
  const segments = await getSegments(note.id);
  const batchOk = languageSupportsBatch(note.language_code);
  const duration = note.duration_sec ?? 0;

  let strategy: NoteRow['strategy'];
  let why: string;

  if (segments.length === 0) {
    // The browser could not decode this file, so we hand the original straight
    // to the Batch API and let Gnani's decoder have a go at it.
    if (!batchOk) {
      throw new PipelineError(
        'AUDIO_UNREADABLE',
        'This file could not be decoded in the browser, and the chosen language has no batch support.',
        {
          hint: 'Convert the recording to WAV or MP3 and upload again, or pick a language that supports batch transcription.',
          retryable: false,
        },
      );
    }
    strategy = 'batch_whole';
    why = 'Browser could not decode the file — sending the original to the Batch API';
    await updateNote(note.id, { segmentsTotal: 1 });
  } else if (segments.length === 1 && duration > 0 && duration <= GNANI_LIMITS.restMaxSeconds - 5) {
    strategy = 'rest_single';
    why = `Clip is ${Math.round(duration)}s — one synchronous REST call is fastest`;
  } else if (batchOk) {
    strategy = 'batch_segments';
    why = `${segments.length} chunks submitted as a single Gnani batch job`;
  } else {
    strategy = 'rest_segments';
    why = `${note.language_code} is REST-only at Gnani — transcribing ${segments.length} chunks over REST`;
  }

  await updateNote(note.id, {
    strategy,
    status: 'TRANSCRIBING',
    stageDetail: why,
    nextRunAt: new Date(),
  });
  await appendEvent(note.id, event('info', why));

  return { id: note.id, status: 'TRANSCRIBING', detail: why, done: false, nextDelayMs: 0 };
}

/* ------------------------------------------------------------------ */
/* 2a. REST path — one chunk at a time, committed as it goes            */
/* ------------------------------------------------------------------ */

async function fetchAudio(url: string): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) {
      throw new PipelineError('STORAGE_FAILED', `Could not read the stored audio (${res.status}).`, {
        hint: 'The blob may have been deleted. Re-upload the recording.',
        retryable: res.status >= 500,
      });
    }
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeOverRest(note: NoteRow): Promise<StepResult> {
  const started = Date.now();
  const all = await getSegments(note.id);
  let pending = all.filter((s) => s.status === 'PENDING' || s.status === 'RUNNING');

  while (pending.length > 0 && Date.now() - started < STEP_BUDGET_MS) {
    const batch = pending.slice(0, REST_CONCURRENCY);
    await Promise.all(batch.map((seg) => transcribeOneSegment(note, seg)));
    pending = pending.slice(batch.length);

    const fresh = await getSegments(note.id);
    const done = fresh.filter((s) => s.status === 'DONE').length;
    const failed = fresh.filter((s) => s.status === 'FAILED').length;
    await updateNote(note.id, {
      segmentsDone: done,
      segmentsFailed: failed,
      stageDetail: `Transcribing chunk ${Math.min(done + failed + 1, fresh.length)} of ${fresh.length}`,
    });
  }

  const finalSegments = await getSegments(note.id);
  const remaining = finalSegments.filter((s) => s.status === 'PENDING' || s.status === 'RUNNING');
  if (remaining.length > 0) {
    return {
      id: note.id,
      status: 'TRANSCRIBING',
      detail: `${finalSegments.length - remaining.length}/${finalSegments.length} chunks transcribed`,
      done: false,
      nextDelayMs: 0,
    };
  }

  return assembleTranscript(note, finalSegments);
}

async function transcribeOneSegment(note: NoteRow, seg: SegmentRow): Promise<void> {
  try {
    const audio = await fetchAudio(seg.url);
    const text = await transcribeRest({
      audio,
      filename: `chunk-${String(seg.idx).padStart(3, '0')}.wav`,
      contentType: 'audio/wav',
      languageCode: note.language_code,
    });
    await updateSegment(seg.id, { status: 'DONE', text, error: null });
  } catch (err) {
    const pe = asPipelineError(err);
    // A single bad chunk must not sink a 40-minute recording: mark it, keep going,
    // and show the gap in the transcript.
    const giveUp = !pe.retryable || seg.attempts >= 2;
    await updateSegment(seg.id, {
      status: giveUp ? 'FAILED' : 'PENDING',
      error: pe.message.slice(0, 300),
    });
    if (giveUp) {
      await appendEvent(
        note.id,
        event('warn', `Chunk ${seg.idx + 1} failed (${pe.code}) — transcript will show a gap`),
      );
    }
    if (!giveUp) throw pe;
  }
}

/* ------------------------------------------------------------------ */
/* 2b. Batch path — create, start, poll, collect                        */
/* ------------------------------------------------------------------ */

async function driveBatchJob(note: NoteRow): Promise<StepResult> {
  const segments = await getSegments(note.id);

  if (!note.gnani_job_id) {
    const urls =
      note.strategy === 'batch_whole'
        ? [note.audio_url!]
        : segments.map((s) => s.url);

    if (urls.length > GNANI_LIMITS.batchMaxFilesPerJob) {
      throw new PipelineError(
        'AUDIO_TOO_LONG',
        `This recording produced ${urls.length} chunks, over Gnani's limit of ${GNANI_LIMITS.batchMaxFilesPerJob} files per job.`,
        { hint: 'Split the recording into shorter files and upload them separately.', retryable: false },
      );
    }

    const jobId = await createBatchJobFromUrls(urls, note.language_code);
    await startBatchJob(jobId);
    await updateNote(note.id, {
      gnaniJobId: jobId,
      stageDetail: `Batch job ${jobId.slice(0, 8)} queued at Gnani`,
      nextRunAt: new Date(Date.now() + 8_000),
    });
    await appendEvent(note.id, event('info', `Gnani batch job created and started (${urls.length} file(s))`));

    return {
      id: note.id,
      status: 'TRANSCRIBING',
      detail: 'Queued at Gnani',
      done: false,
      nextDelayMs: 8_000,
    };
  }

  const job = await getBatchJob(note.gnani_job_id);

  if (!isBatchTerminal(job.status)) {
    const detail =
      job.progress.total_files > 0
        ? `Gnani ${job.status.toLowerCase().replace('_', ' ')} — ${job.progress.completed_files}/${job.progress.total_files} chunks done`
        : `Gnani job ${job.status.toLowerCase().replace('_', ' ')}`;

    await updateNote(note.id, {
      stageDetail: detail,
      segmentsDone: job.progress.completed_files,
      segmentsFailed: job.progress.failed_files,
      segmentsTotal: job.progress.total_files || note.segments_total,
      // Gnani asks for a minimum 10 s poll interval; we respect it.
      nextRunAt: new Date(Date.now() + GNANI_LIMITS.batchMinPollSeconds * 1000),
    });

    return {
      id: note.id,
      status: 'TRANSCRIBING',
      detail,
      done: false,
      nextDelayMs: GNANI_LIMITS.batchMinPollSeconds * 1000,
    };
  }

  if (job.status === 'START_FAILED' || job.status === 'CANCELLED') {
    // The most common cause is Gnani being unable to fetch our public URLs.
    // Fall back to pushing the audio through REST chunk by chunk instead.
    if (note.strategy === 'batch_segments' && segments.length > 0) {
      await updateNote(note.id, {
        strategy: 'rest_segments',
        gnaniJobId: null,
        stageDetail: 'Batch job could not start — falling back to per-chunk REST transcription',
        nextRunAt: new Date(),
      });
      await appendEvent(
        note.id,
        event('warn', `Batch job ${job.status} (${job.cancelReason || 'no reason given'}) — retrying over REST`),
      );
      return {
        id: note.id,
        status: 'TRANSCRIBING',
        detail: 'Falling back to REST',
        done: false,
        nextDelayMs: 0,
      };
    }
    throw new PipelineError('ASR_JOB_FAILED', `Gnani could not start the job: ${job.cancelReason || job.status}`, {
      hint: 'Check that the stored audio URL is publicly reachable.',
      retryable: false,
    });
  }

  // COMPLETED / PARTIAL_FAILURE / FAILED — collect whatever succeeded.
  const files = await getBatchJobFiles(note.gnani_job_id);
  await appendEvent(
    note.id,
    event(
      job.status === 'COMPLETED' ? 'success' : 'warn',
      `Gnani job ${job.status.toLowerCase()} — ${files.filter((f) => f.status === 'COMPLETED').length}/${files.length} chunks transcribed`,
    ),
  );

  if (note.strategy === 'batch_whole') {
    const file = files.find((f) => f.status === 'COMPLETED' && f.transcript_url);
    if (!file) {
      const reason = files[0]?.error_message || job.cancelReason || 'no transcript produced';
      throw new PipelineError('ASR_JOB_FAILED', `Gnani could not transcribe this file: ${reason}`, {
        hint: /empty transcript/i.test(reason)
          ? 'The recogniser found no speech — check the recording is not silent or music-only.'
          : 'Try re-uploading as WAV or MP3.',
        retryable: false,
      });
    }
    const { text, lines } = await downloadTranscript(file.transcript_url!);
    return finishTranscript(note, text, lines, 0);
  }

  // Map results back onto our chunks by URL, then stitch in chunk order.
  const byUrl = new Map<string, (typeof files)[number]>();
  for (const f of files) byUrl.set(normaliseUrl(f.original_path), f);

  let downloaded = 0;
  for (const seg of segments) {
    if (seg.status === 'DONE') continue;
    const file = byUrl.get(normaliseUrl(seg.url));
    if (!file || file.status !== 'COMPLETED' || !file.transcript_url) {
      await updateSegment(seg.id, {
        status: 'FAILED',
        error: file?.error_message || 'Gnani returned no transcript for this chunk',
      });
      continue;
    }
    try {
      const { text, lines } = await downloadTranscript(file.transcript_url);
      await updateSegment(seg.id, { status: 'DONE', text, lines, error: null });
      downloaded++;
    } catch (err) {
      await updateSegment(seg.id, { status: 'FAILED', error: asPipelineError(err).message });
    }
    if (Date.now() % 1 === 0 && downloaded >= 40) break; // safety valve on very long notes
  }

  const finalSegments = await getSegments(note.id);
  return assembleTranscript(note, finalSegments);
}

/** Blob URLs can come back with different query strings; compare on origin+path. */
function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Stitching                                                         */
/* ------------------------------------------------------------------ */

async function assembleTranscript(note: NoteRow, segments: SegmentRow[]): Promise<StepResult> {
  const parts: string[] = [];
  const lines: TranscriptLine[] = [];
  let failed = 0;

  for (const seg of segments) {
    if (seg.status === 'DONE' && (seg.text || '').trim()) {
      parts.push(seg.text!.trim());
      const segLines = Array.isArray(seg.lines) ? seg.lines : null;
      if (segLines && segLines.length) {
        // Gnani timestamps are relative to each chunk — shift them back onto the
        // original timeline so the transcript can drive the audio player.
        for (const l of segLines) {
          lines.push({
            start: Number(seg.start_sec) + l.start,
            end: Number(seg.start_sec) + l.end,
            text: l.text,
            speaker: l.speaker ?? null,
          });
        }
      } else {
        lines.push({
          start: Number(seg.start_sec),
          end: Number(seg.end_sec),
          text: seg.text!.trim(),
          speaker: null,
        });
      }
    } else if (seg.status === 'FAILED') {
      failed++;
      const marker = `[chunk ${fmtClock(Number(seg.start_sec))}–${fmtClock(Number(seg.end_sec))} could not be transcribed]`;
      parts.push(marker);
      lines.push({ start: Number(seg.start_sec), end: Number(seg.end_sec), text: marker, speaker: null });
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();

  if (!text || failed === segments.length) {
    throw new PipelineError('ASR_EMPTY', 'Gnani returned no usable text for this recording.', {
      hint: 'This usually means the audio is silent, music-only, or in a different language than the one selected.',
      retryable: false,
    });
  }

  return finishTranscript(note, text, lines, failed);
}

async function finishTranscript(
  note: NoteRow,
  text: string,
  lines: TranscriptLine[],
  failedChunks: number,
): Promise<StepResult> {
  await updateNote(note.id, {
    transcript: text,
    lines: lines.length ? lines : null,
    wordCount: countWords(text),
    segmentsFailed: failedChunks,
    status: 'SUMMARIZING',
    stageDetail: `Transcript ready (${countWords(text)} words) — summarising`,
    nextRunAt: new Date(),
  });
  await appendEvent(
    note.id,
    event('success', `Transcript assembled — ${countWords(text)} words${failedChunks ? `, ${failedChunks} chunk(s) missing` : ''}`),
  );

  return {
    id: note.id,
    status: 'SUMMARIZING',
    detail: 'Summarising',
    done: false,
    nextDelayMs: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Summary                                                           */
/* ------------------------------------------------------------------ */

async function runSummary(note: NoteRow): Promise<StepResult> {
  const transcript = note.transcript || '';
  const summary = await summarise(transcript, {
    filename: note.original_filename,
    durationSec: note.duration_sec,
    language: note.language_code,
  });

  const status = note.segments_failed > 0 ? 'READY_PARTIAL' : 'READY';

  await updateNote(note.id, {
    summary,
    summaryModel: summary.generatedBy,
    title: summary.title || note.title,
    status,
    stageDetail: null,
    errorCode: null,
    errorMessage: null,
    errorHint: null,
    completedAt: new Date(),
  });
  await appendEvent(note.id, event('success', `Summary generated by ${summary.generatedBy}`));

  return { id: note.id, status, detail: null, done: true, nextDelayMs: 0 };
}

/* ------------------------------------------------------------------ */
/* Failure handling                                                     */
/* ------------------------------------------------------------------ */

async function handleFailure(note: NoteRow, err: PipelineError): Promise<StepResult> {
  const attempts = note.attempts + 1;
  const canRetry = err.retryable && attempts < MAX_ATTEMPTS;

  if (canRetry) {
    const wait = backoffMs(attempts - 1);
    await updateNote(note.id, {
      attempts,
      stageDetail: `${err.message} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempts}/${MAX_ATTEMPTS})`,
      nextRunAt: new Date(Date.now() + wait),
    });
    await appendEvent(note.id, event('warn', `${err.code}: ${err.message} — retry ${attempts}/${MAX_ATTEMPTS}`));
    return {
      id: note.id,
      status: note.status,
      detail: err.message,
      done: false,
      nextDelayMs: wait,
    };
  }

  await updateNote(note.id, {
    status: 'FAILED',
    attempts,
    errorCode: err.code,
    errorMessage: err.message,
    errorHint: err.hint,
    retryable: err.retryable,
    stageDetail: null,
    completedAt: new Date(),
  });
  await appendEvent(note.id, event('error', `${err.code}: ${err.message}`));

  return { id: note.id, status: 'FAILED', detail: err.message, done: true, nextDelayMs: 0 };
}

/* ------------------------------------------------------------------ */
/* Retry from the UI                                                    */
/* ------------------------------------------------------------------ */

export async function retryNote(note: NoteRow): Promise<void> {
  const backToTranscription = !note.transcript;

  if (backToTranscription) {
    await import('./db').then(({ query }) =>
      query(
        `UPDATE segments SET status = 'PENDING', error_message = NULL, attempts = 0
          WHERE note_id = $1 AND status <> 'DONE'`,
        [note.id],
      ),
    );
  }

  await updateNote(note.id, {
    status: backToTranscription ? 'QUEUED' : 'SUMMARIZING',
    strategy: undefined,
    gnaniJobId: backToTranscription ? null : note.gnani_job_id,
    attempts: 0,
    errorCode: null,
    errorMessage: null,
    errorHint: null,
    retryable: true,
    stageDetail: 'Retrying',
    segmentsFailed: 0,
    completedAt: null,
    lockedUntil: null,
    nextRunAt: new Date(),
  });
  await appendEvent(note.id, event('info', 'Retry requested'));
}

export function summariserLabel(): string {
  const p = activeProvider();
  return p === 'extractive' ? 'extractive fallback (no LLM key set)' : `${p}/${modelFor(p)}`;
}
