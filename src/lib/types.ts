export type NoteStatus =
  | 'QUEUED'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'READY'
  | 'READY_PARTIAL'
  | 'FAILED';

export type Strategy =
  | 'rest_single' // one clip <= 55 s -> single synchronous REST call
  | 'batch_segments' // long audio, split client-side -> one Gnani batch job
  | 'batch_whole' // long audio we could not split -> batch job on the raw file
  | 'rest_segments'; // fallback: segments transcribed one-by-one over REST

export type SegmentStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';

export interface TimelineEvent {
  t: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  msg: string;
}

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
  speaker?: number | null;
}

export interface Summary {
  title: string;
  tldr: string;
  keyPoints: string[];
  actionItems: string[];
  topics: string[];
  tone?: string;
  generatedBy: string;
}

export interface SegmentRow {
  id: string;
  note_id: string;
  idx: number;
  start_sec: number;
  end_sec: number;
  url: string;
  pathname: string | null;
  size_bytes: string | number;
  status: SegmentStatus;
  text: string | null;
  lines: TranscriptLine[] | null;
  error_message: string | null;
  attempts: number;
}

export interface NoteRow {
  id: string;
  owner_id: string;
  title: string;
  original_filename: string;
  mime_type: string | null;
  size_bytes: string | number;
  duration_sec: number | null;
  language_code: string;
  source: string;
  audio_url: string | null;
  audio_pathname: string | null;
  status: NoteStatus;
  stage_detail: string | null;
  strategy: Strategy | null;
  gnani_job_id: string | null;
  transcript: string | null;
  transcript_json: TranscriptLine[] | null;
  word_count: number;
  segments_total: number;
  segments_done: number;
  segments_failed: number;
  summary: Summary | null;
  summary_model: string | null;
  error_code: string | null;
  error_message: string | null;
  error_hint: string | null;
  retryable: boolean;
  attempts: number;
  locked_until: string | null;
  next_run_at: string;
  timeline: TimelineEvent[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** What the browser receives. Never includes owner_id or lock bookkeeping. */
export interface NoteDTO {
  id: string;
  title: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  durationSec: number | null;
  languageCode: string;
  source: string;
  audioUrl: string | null;
  status: NoteStatus;
  stageDetail: string | null;
  strategy: Strategy | null;
  transcript: string | null;
  lines: TranscriptLine[] | null;
  wordCount: number;
  segmentsTotal: number;
  segmentsDone: number;
  segmentsFailed: number;
  summary: Summary | null;
  summaryModel: string | null;
  error: { code: string; message: string; hint: string | null; retryable: boolean } | null;
  timeline: TimelineEvent[];
  progress: number;
  createdAt: string;
  completedAt: string | null;
}

export const TERMINAL: NoteStatus[] = ['READY', 'READY_PARTIAL', 'FAILED'];

export function isTerminal(status: NoteStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Languages Gnani Prisma v2.5 accepts.
 * `batch: false` marks the two languages that REST/Realtime support but the
 * Batch Jobs API does not — we route those through the REST path instead.
 */
export const LANGUAGES: { code: string; label: string; batch: boolean }[] = [
  { code: 'en-IN', label: 'English (India)', batch: true },
  { code: 'hi-IN', label: 'Hindi', batch: true },
  { code: 'bn-IN', label: 'Bengali', batch: true },
  { code: 'kn-IN', label: 'Kannada', batch: true },
  { code: 'ml-IN', label: 'Malayalam', batch: true },
  { code: 'mr-IN', label: 'Marathi', batch: true },
  { code: 'ta-IN', label: 'Tamil', batch: true },
  { code: 'te-IN', label: 'Telugu', batch: true },
  { code: 'gu-IN', label: 'Gujarati (REST only)', batch: false },
  { code: 'pa-IN', label: 'Punjabi (REST only)', batch: false },
];

export function languageSupportsBatch(code: string): boolean {
  return LANGUAGES.find((l) => l.code === code)?.batch ?? true;
}

export function isValidLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}
