'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '@/lib/audio/segment';
import { useNoteProcessor } from '@/lib/client';
import { isTerminal, type NoteDTO, type TranscriptLine } from '@/lib/types';
import { StatusPill } from './NotesList';

const STAGES = [
  { key: 'upload', label: 'Uploaded', match: () => true },
  { key: 'transcribe', label: 'Transcribed', match: (n: NoteDTO) => Boolean(n.transcript) },
  { key: 'summarise', label: 'Summarised', match: (n: NoteDTO) => Boolean(n.summary) },
] as const;

export default function NoteView({ initial }: { initial: NoteDTO }) {
  const { note, retry, workerError } = useNoteProcessor(initial);
  const [retrying, setRetrying] = useState(false);
  const current = note || initial;
  const processing = !isTerminal(current.status);

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <Link
        href="/"
        className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-600 transition-colors hover:text-ember-400"
      >
        ← All recordings
      </Link>

      <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-3xl leading-tight text-bone-100 sm:text-4xl">
            {current.title}
          </h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="chip">{formatDuration(current.durationSec)}</span>
            <span className="chip">{current.languageCode}</span>
            <span className="chip">{current.originalFilename}</span>
            {current.wordCount > 0 && <span className="chip">{current.wordCount.toLocaleString()} words</span>}
            {current.strategy && <span className="chip">{current.strategy}</span>}
          </div>
        </div>
        <StatusPill note={current} />
      </header>

      {processing && <ProcessingCard note={current} workerError={workerError} />}

      {current.status === 'FAILED' && (
        <div className="mt-8 rounded-2xl border border-rose-500/30 bg-rose-500/[0.06] p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-rose-400">
            {current.error?.code || 'FAILED'}
          </p>
          <p className="mt-2 font-display text-2xl text-bone-100">Processing failed</p>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-400">
            {current.error?.message}
          </p>
          {current.error?.hint && (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-600">{current.error.hint}</p>
          )}

          <div className="mt-5 flex flex-wrap gap-3">
            {current.error?.retryable !== false && (
              <button
                className="btn-primary"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await retry();
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                {retrying ? 'Retrying…' : 'Retry processing'}
              </button>
            )}
            <Link href="/" className="btn-ghost">
              Upload something else
            </Link>
          </div>
          <ActivityLog note={current} className="mt-6" />
        </div>
      )}

      {current.status === 'READY_PARTIAL' && (
        <p className="mt-6 rounded-xl border border-ember-500/25 bg-ember-500/[0.05] px-4 py-3 text-sm text-bone-400">
          {current.segmentsFailed} chunk{current.segmentsFailed === 1 ? '' : 's'} could not be
          transcribed. The gaps are marked inline so nothing is silently missing.
        </p>
      )}

      {current.transcript && (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <TranscriptPanel note={current} />
          <div className="space-y-6">
            <SummaryPanel note={current} />
            <ActivityLog note={current} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProcessingCard({ note, workerError }: { note: NoteDTO; workerError: string | null }) {
  return (
    <section className="panel mt-8 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-display text-2xl text-bone-100">Working on it</p>
        <span className="font-mono text-sm text-ember-400">{note.progress}%</span>
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-ember-600 to-ember-400 transition-all duration-500"
          style={{ width: `${note.progress}%` }}
        />
      </div>

      <p className="mt-3 text-sm text-bone-400">{note.stageDetail || 'Waiting for a worker'}</p>

      <ol className="mt-6 grid gap-3 sm:grid-cols-3">
        {STAGES.map((stage, i) => {
          const done = stage.match(note);
          const isCurrent = !done && (i === 0 || STAGES[i - 1].match(note));
          return (
            <li
              key={stage.key}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                done
                  ? 'border-mint-500/25 bg-mint-500/[0.05]'
                  : isCurrent
                    ? 'border-ember-500/35 bg-ember-500/[0.05]'
                    : 'border-white/[0.07]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    done ? 'bg-mint-500' : isCurrent ? 'bg-ember-500 animate-pulseDot' : 'bg-white/20'
                  }`}
                />
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
                    done ? 'text-mint-400' : isCurrent ? 'text-ember-400' : 'text-bone-600'
                  }`}
                >
                  {stage.label}
                </span>
              </div>
              {stage.key === 'transcribe' && note.segmentsTotal > 0 && (
                <p className="mt-1.5 font-mono text-[11px] text-bone-600">
                  {note.segmentsDone + note.segmentsFailed}/{note.segmentsTotal} chunks
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {workerError && (
        <p className="mt-4 rounded-lg border border-rose-500/25 bg-rose-500/[0.05] px-3 py-2 font-mono text-[11px] text-rose-400">
          Worker request failed: {workerError} — retrying automatically.
        </p>
      )}

      <ActivityLog note={note} className="mt-6" />
    </section>
  );
}

function ActivityLog({ note, className = '' }: { note: NoteDTO; className?: string }) {
  const [open, setOpen] = useState(true);
  if (!note.timeline.length) return null;

  const colour = {
    info: 'text-bone-400',
    success: 'text-mint-400',
    warn: 'text-ember-400',
    error: 'text-rose-400',
  } as const;

  return (
    <div className={`rounded-xl border border-white/[0.07] bg-ink-950/50 ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5"
      >
        <span className="label">Pipeline log</span>
        <span className="font-mono text-[10px] text-bone-600">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto px-4 pb-3.5">
          {note.timeline.map((e, i) => (
            <li key={i} className="flex gap-3 font-mono text-[11px] leading-relaxed">
              <span className="shrink-0 text-bone-600">
                {new Date(e.t).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={colour[e.kind]}>{e.msg}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TranscriptPanel({ note }: { note: NoteDTO }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(note.durationSec || 0);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const lines: TranscriptLine[] = useMemo(() => {
    if (note.lines?.length) return note.lines;
    return [{ start: 0, end: note.durationSec || 0, text: note.transcript || '' }];
  }, [note.lines, note.transcript, note.durationSec]);

  const filtered = useMemo(() => {
    if (!query.trim()) return lines;
    const q = query.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(q));
  }, [lines, query]);

  const activeIndex = useMemo(
    () => lines.findIndex((l) => time >= l.start && time < l.end),
    [lines, time],
  );

  const seek = (t: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    void audioRef.current.play();
  };

  return (
    <section className="panel flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <span className="label">Transcript</span>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-32 rounded-lg border border-white/10 bg-ink-850 px-2.5 py-1.5 font-mono text-[11px] text-bone-200 outline-none transition-colors placeholder:text-bone-600 focus:w-44 focus:border-ember-500/60"
          />
          <button
            className="chip transition-colors hover:border-white/25 hover:text-bone-200"
            onClick={async () => {
              await navigator.clipboard.writeText(note.transcript || '');
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            className="chip transition-colors hover:border-white/25 hover:text-bone-200"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(note.transcript || '')}`}
            download={`${note.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`}
          >
            .txt
          </a>
        </div>
      </div>

      {note.audioUrl && (
        <div className="border-b border-white/[0.06] px-5 py-3">
          <audio
            ref={audioRef}
            src={note.audioUrl}
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="hidden"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (!audioRef.current) return;
                if (playing) audioRef.current.pause();
                else void audioRef.current.play();
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ember-500 text-ink-950 transition-colors hover:bg-ember-400"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
                  <rect width="3" height="12" rx="1" />
                  <rect x="7" width="3" height="12" rx="1" />
                </svg>
              ) : (
                <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor">
                  <path d="M0 1.2c0-.9 1-1.5 1.8-1L10 4.9c.7.4.7 1.5 0 2L1.8 11.8c-.8.5-1.8-.1-1.8-1V1.2Z" />
                </svg>
              )}
            </button>
            <span className="font-mono text-[11px] tabular-nums text-bone-600">
              {formatDuration(time)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(time, duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              className="h-4 flex-1 cursor-pointer"
            />
            <span className="font-mono text-[11px] tabular-nums text-bone-600">
              {formatDuration(duration)}
            </span>
          </div>
        </div>
      )}

      <div className="max-h-[62vh] overflow-y-auto px-2 py-2">
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-bone-600">No lines match “{query}”.</p>
        )}
        {filtered.map((line, i) => {
          const original = lines.indexOf(line);
          const isActive = original === activeIndex;
          const isGap = line.text.startsWith('[chunk ');
          return (
            <button
              key={`${line.start}-${i}`}
              onClick={() => seek(line.start)}
              className={`flex w-full gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.04] ${
                isActive ? 'line-active' : ''
              }`}
            >
              <span className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-bone-600">
                {formatDuration(line.start)}
              </span>
              <span
                className={`text-[15px] leading-relaxed ${
                  isGap ? 'italic text-rose-400/70' : 'text-bone-200'
                }`}
              >
                {line.text}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function SummaryPanel({ note }: { note: NoteDTO }) {
  const s = note.summary;
  if (!s) {
    return (
      <section className="panel p-5">
        <span className="label">Summary</span>
        <p className="mt-3 text-sm text-bone-600">Not generated yet.</p>
      </section>
    );
  }

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
        <span className="label">Summary</span>
        {s.tone && <span className="font-mono text-[10px] text-bone-600">{s.tone}</span>}
      </div>

      <div className="space-y-6 px-5 py-5">
        <p className="font-display text-xl leading-snug text-bone-100">{s.tldr}</p>

        {s.keyPoints.length > 0 && (
          <div>
            <p className="label mb-2.5">Key points</p>
            <ul className="space-y-2.5">
              {s.keyPoints.map((point, i) => (
                <li key={i} className="flex gap-3 text-sm leading-relaxed text-bone-200">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ember-500" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.actionItems.length > 0 && (
          <div>
            <p className="label mb-2.5">Action items</p>
            <ul className="space-y-2">
              {s.actionItems.map((item, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-mint-500/20 bg-mint-500/[0.04] px-3 py-2 text-sm leading-relaxed text-bone-200"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.topics.length > 0 && (
          <div>
            <p className="label mb-2.5">Topics</p>
            <div className="flex flex-wrap gap-1.5">
              {s.topics.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <p className="border-t border-white/[0.06] pt-4 font-mono text-[10px] leading-relaxed text-bone-600">
          Generated by {s.generatedBy}. Transcript by Gnani Prisma v2.5.
        </p>
      </div>
    </section>
  );
}
