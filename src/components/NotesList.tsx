'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/audio/segment';
import { apiJson, sleep } from '@/lib/client';
import { isTerminal, type NoteDTO } from '@/lib/types';

export default function NotesList({ initial }: { initial: NoteDTO[] }) {
  const [notes, setNotes] = useState<NoteDTO[]>(initial);
  const loopRunning = useRef(false);

  const active = notes.filter((n) => !isTerminal(n.status));

  // Keep pushing unfinished notes forward even when their own page is closed —
  // otherwise a note would sit half-done until the daily cron sweep.
  useEffect(() => {
    if (!active.length || loopRunning.current) return;
    loopRunning.current = true;
    let stop = false;

    (async () => {
      for (let i = 0; i < 600 && !stop; i++) {
        const pending = notes.filter((n) => !isTerminal(n.status)).slice(0, 2);
        if (!pending.length) break;
        await Promise.all(
          pending.map((n) =>
            apiJson(`/api/notes/${n.id}/step`, { method: 'POST' }).catch(() => null),
          ),
        );
        try {
          const data = await apiJson<{ notes: NoteDTO[] }>('/api/notes');
          setNotes(data.notes);
          if (data.notes.every((n) => isTerminal(n.status))) break;
        } catch {
          /* transient — try again next tick */
        }
        await sleep(2_500);
      }
      loopRunning.current = false;
    })();

    return () => {
      stop = true;
      loopRunning.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length]);

  if (!notes.length) {
    return (
      <div className="panel px-6 py-14 text-center">
        <p className="font-display text-xl text-bone-200">No recordings yet</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-bone-600">
          Upload an audio file or record straight from your microphone. Everything you process shows
          up here and stays reopenable.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2.5">
      {notes.map((note) => (
        <li key={note.id} className="animate-riseIn">
          <NoteCard note={note} />
        </li>
      ))}
    </ul>
  );
}

function NoteCard({ note }: { note: NoteDTO }) {
  const processing = !isTerminal(note.status);

  return (
    <Link
      href={`/notes/${note.id}`}
      className="panel group block px-5 py-4 transition-all duration-150 hover:border-white/[0.16] hover:bg-ink-850/70"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg leading-snug text-bone-100 group-hover:text-white">
            {note.title}
          </p>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-bone-600">
            {note.summary?.tldr ||
              (processing ? note.stageDetail || 'Queued' : note.error?.message || 'No summary')}
          </p>
        </div>
        <StatusPill note={note} />
      </div>

      {processing && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-ember-600 to-ember-400 transition-all duration-500"
            style={{ width: `${note.progress}%` }}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-bone-600">
        <span>{new Date(note.createdAt).toLocaleString()}</span>
        <span>{formatDuration(note.durationSec)}</span>
        <span>{note.languageCode}</span>
        {note.wordCount > 0 && <span>{note.wordCount.toLocaleString()} words</span>}
        {note.source === 'microphone' && <span className="text-ember-400/70">mic</span>}
      </div>
    </Link>
  );
}

export function StatusPill({ note }: { note: NoteDTO }) {
  const map: Record<string, { label: string; className: string; dot: string }> = {
    QUEUED: { label: 'Queued', className: 'border-white/10 text-bone-400', dot: 'bg-bone-400' },
    TRANSCRIBING: {
      label: 'Transcribing',
      className: 'border-ember-500/30 text-ember-400',
      dot: 'bg-ember-500 animate-pulseDot',
    },
    SUMMARIZING: {
      label: 'Summarising',
      className: 'border-ember-500/30 text-ember-400',
      dot: 'bg-ember-500 animate-pulseDot',
    },
    READY: { label: 'Ready', className: 'border-mint-500/30 text-mint-400', dot: 'bg-mint-500' },
    READY_PARTIAL: {
      label: 'Ready · gaps',
      className: 'border-mint-500/25 text-mint-400/80',
      dot: 'bg-mint-500/70',
    },
    FAILED: { label: 'Failed', className: 'border-rose-500/30 text-rose-400', dot: 'bg-rose-500' },
  };
  const s = map[note.status] || map.QUEUED;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${s.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
