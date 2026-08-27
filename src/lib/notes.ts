import { query, queryOne } from './db';
import type {
  NoteDTO,
  NoteRow,
  NoteStatus,
  SegmentRow,
  Strategy,
  TimelineEvent,
  TranscriptLine,
} from './types';

export function newId(prefix = 'n'): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}_${out}`;
}

/** Progress is derived, never stored, so it can never drift from the real state. */
export function progressOf(n: NoteRow): number {
  switch (n.status) {
    case 'QUEUED':
      return 8;
    case 'TRANSCRIBING': {
      if (n.segments_total > 0) {
        const done = Math.min(n.segments_done + n.segments_failed, n.segments_total);
        return 15 + Math.round((done / n.segments_total) * 65);
      }
      return 25;
    }
    case 'SUMMARIZING':
      return 88;
    case 'READY':
    case 'READY_PARTIAL':
      return 100;
    case 'FAILED':
      return 100;
    default:
      return 0;
  }
}

export function toDTO(n: NoteRow): NoteDTO {
  return {
    id: n.id,
    title: n.title,
    originalFilename: n.original_filename,
    mimeType: n.mime_type,
    sizeBytes: Number(n.size_bytes || 0),
    durationSec: n.duration_sec,
    languageCode: n.language_code,
    source: n.source,
    audioUrl: n.audio_url,
    status: n.status,
    stageDetail: n.stage_detail,
    strategy: n.strategy,
    transcript: n.transcript,
    lines: n.transcript_json,
    wordCount: n.word_count,
    segmentsTotal: n.segments_total,
    segmentsDone: n.segments_done,
    segmentsFailed: n.segments_failed,
    summary: n.summary,
    summaryModel: n.summary_model,
    error: n.error_code
      ? {
          code: n.error_code,
          message: n.error_message || 'Processing failed.',
          hint: n.error_hint,
          retryable: n.retryable,
        }
      : null,
    timeline: Array.isArray(n.timeline) ? n.timeline : [],
    progress: progressOf(n),
    createdAt: n.created_at,
    completedAt: n.completed_at,
  };
}

export async function createNote(input: {
  ownerId: string;
  title: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  durationSec: number | null;
  languageCode: string;
  source: string;
  audioUrl: string;
  audioPathname: string | null;
  segments: { idx: number; start: number; end: number; url: string; pathname: string | null; size: number }[];
}): Promise<NoteRow> {
  const id = newId();
  const timeline: TimelineEvent[] = [
    event('info', `Upload complete — ${(input.sizeBytes / 1024 / 1024).toFixed(1)} MB stored`),
  ];
  if (input.segments.length > 1) {
    timeline.push(
      event('info', `Audio split into ${input.segments.length} chunks in the browser before upload`),
    );
  }

  const rows = await query<NoteRow>(
    `INSERT INTO notes
      (id, owner_id, title, original_filename, mime_type, size_bytes, duration_sec,
       language_code, source, audio_url, audio_pathname, status, stage_detail,
       segments_total, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'QUEUED','Waiting for a worker',$12,$13)
     RETURNING *`,
    [
      id,
      input.ownerId,
      input.title,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.durationSec,
      input.languageCode,
      input.source,
      input.audioUrl,
      input.audioPathname,
      input.segments.length,
      JSON.stringify(timeline),
    ],
  );

  if (input.segments.length) {
    const values: string[] = [];
    const params: unknown[] = [];
    input.segments.forEach((s, i) => {
      const b = i * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(newId('s'), id, s.idx, s.start, s.end, s.url, s.pathname);
    });
    await query(
      `INSERT INTO segments (id, note_id, idx, start_sec, end_sec, url, pathname)
       VALUES ${values.join(',')}`,
      params,
    );
  }

  return rows[0];
}

export function event(kind: TimelineEvent['kind'], msg: string): TimelineEvent {
  return { t: new Date().toISOString(), kind, msg };
}

export async function appendEvent(noteId: string, ev: TimelineEvent): Promise<void> {
  // Keep the tail bounded so a pathological retry loop can't grow the row forever.
  await query(
    `UPDATE notes
        SET timeline = (
              CASE WHEN jsonb_array_length(timeline) >= 60
                   THEN timeline - 0
                   ELSE timeline END
            ) || $2::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [noteId, JSON.stringify([ev])],
  );
}

export async function getNote(id: string): Promise<NoteRow | null> {
  return queryOne<NoteRow>('SELECT * FROM notes WHERE id = $1', [id]);
}

export async function listNotes(ownerId: string, limit = 50): Promise<NoteRow[]> {
  return query<NoteRow>(
    'SELECT * FROM notes WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
    [ownerId, limit],
  );
}

export async function deleteNote(id: string, ownerId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM notes WHERE id = $1 AND owner_id = $2 RETURNING id',
    [id, ownerId],
  );
  return rows.length > 0;
}

export async function getSegments(noteId: string): Promise<SegmentRow[]> {
  return query<SegmentRow>('SELECT * FROM segments WHERE note_id = $1 ORDER BY idx ASC', [noteId]);
}

export async function updateSegment(
  id: string,
  patch: { status?: string; text?: string | null; lines?: TranscriptLine[] | null; error?: string | null },
): Promise<void> {
  await query(
    `UPDATE segments
        SET status = COALESCE($2, status),
            text = COALESCE($3, text),
            lines = COALESCE($4::jsonb, lines),
            error_message = $5,
            attempts = attempts + 1,
            updated_at = NOW()
      WHERE id = $1`,
    [id, patch.status ?? null, patch.text ?? null, patch.lines ? JSON.stringify(patch.lines) : null, patch.error ?? null],
  );
}

export interface NotePatch {
  status?: NoteStatus;
  stageDetail?: string | null;
  strategy?: Strategy;
  gnaniJobId?: string | null;
  transcript?: string;
  lines?: TranscriptLine[] | null;
  wordCount?: number;
  segmentsTotal?: number;
  segmentsDone?: number;
  segmentsFailed?: number;
  summary?: unknown;
  summaryModel?: string;
  title?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorHint?: string | null;
  retryable?: boolean;
  attempts?: number;
  nextRunAt?: Date;
  lockedUntil?: Date | null;
  completedAt?: Date | null;
}

export async function updateNote(id: string, patch: NotePatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.stageDetail !== undefined) push('stage_detail', patch.stageDetail);
  if (patch.strategy !== undefined) push('strategy', patch.strategy);
  if (patch.gnaniJobId !== undefined) push('gnani_job_id', patch.gnaniJobId);
  if (patch.transcript !== undefined) push('transcript', patch.transcript);
  if (patch.lines !== undefined) push('transcript_json', patch.lines ? JSON.stringify(patch.lines) : null, '::jsonb');
  if (patch.wordCount !== undefined) push('word_count', patch.wordCount);
  if (patch.segmentsTotal !== undefined) push('segments_total', patch.segmentsTotal);
  if (patch.segmentsDone !== undefined) push('segments_done', patch.segmentsDone);
  if (patch.segmentsFailed !== undefined) push('segments_failed', patch.segmentsFailed);
  if (patch.summary !== undefined) push('summary', patch.summary ? JSON.stringify(patch.summary) : null, '::jsonb');
  if (patch.summaryModel !== undefined) push('summary_model', patch.summaryModel);
  if (patch.title !== undefined) push('title', patch.title);
  if (patch.errorCode !== undefined) push('error_code', patch.errorCode);
  if (patch.errorMessage !== undefined) push('error_message', patch.errorMessage);
  if (patch.errorHint !== undefined) push('error_hint', patch.errorHint);
  if (patch.retryable !== undefined) push('retryable', patch.retryable);
  if (patch.attempts !== undefined) push('attempts', patch.attempts);
  if (patch.nextRunAt !== undefined) push('next_run_at', patch.nextRunAt.toISOString(), '::timestamptz');
  if (patch.lockedUntil !== undefined)
    push('locked_until', patch.lockedUntil ? patch.lockedUntil.toISOString() : null, '::timestamptz');
  if (patch.completedAt !== undefined)
    push('completed_at', patch.completedAt ? patch.completedAt.toISOString() : null, '::timestamptz');

  if (!sets.length) return;
  await query(`UPDATE notes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
}

/**
 * Claims a note for processing with an optimistic lock. Two workers racing on
 * the same note is normal here (the browser drives one loop and the cron drives
 * another) — only one wins the UPDATE, the other backs off.
 */
/**
 * Lease is deliberately shorter than the 60 s function ceiling: if a step is
 * killed mid-flight the note frees itself quickly instead of sitting locked.
 */
export async function claimNote(id: string, leaseSeconds = 40): Promise<NoteRow | null> {
  const rows = await query<NoteRow>(
    `UPDATE notes
        SET locked_until = NOW() + ($2 || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $1
        AND status NOT IN ('READY','READY_PARTIAL','FAILED')
        AND next_run_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      RETURNING *`,
    [id, String(leaseSeconds)],
  );
  return rows[0] ?? null;
}

export async function releaseNote(id: string): Promise<void> {
  await query('UPDATE notes SET locked_until = NULL, updated_at = NOW() WHERE id = $1', [id]);
}

/** Notes that stalled — used by the cron sweeper. */
export async function findStalledNotes(limit = 5): Promise<NoteRow[]> {
  return query<NoteRow>(
    `SELECT * FROM notes
      WHERE status NOT IN ('READY','READY_PARTIAL','FAILED')
        AND next_run_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
}
