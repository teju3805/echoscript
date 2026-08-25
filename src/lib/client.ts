'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteDTO } from './types';
import { isTerminal } from './types';

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const message =
      (body as { message?: string })?.message || `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

/**
 * Drives a note to completion from the browser.
 *
 * Each POST performs one small unit of server work and tells us how long to
 * wait before the next one, so a stalled Gnani job costs us one cheap poll
 * every ten seconds instead of a function held open for minutes.
 */
export function useNoteProcessor(initial: NoteDTO | null) {
  const [note, setNote] = useState<NoteDTO | null>(initial);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const running = useRef(false);
  const cancelled = useRef(false);

  const drive = useCallback(async (id: string) => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    let consecutiveFailures = 0;

    try {
      for (let i = 0; i < 400 && !cancelled.current; i++) {
        try {
          const data = await apiJson<{
            step: { done: boolean; nextDelayMs: number };
            note: NoteDTO | null;
          }>(`/api/notes/${id}/step`, { method: 'POST' });

          consecutiveFailures = 0;
          setWorkerError(null);
          if (data.note) setNote(data.note);
          if (data.step.done) break;

          await sleep(Math.max(data.step.nextDelayMs, 400));
        } catch (err) {
          consecutiveFailures++;
          setWorkerError(err instanceof Error ? err.message : 'Worker request failed');
          if (consecutiveFailures >= 5) break;
          await sleep(2_000 * consecutiveFailures);
        }
      }
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    if (note && !isTerminal(note.status)) void drive(note.id);
    return () => {
      cancelled.current = true;
    };
    // Intentionally keyed on the id only — we don't want to restart the loop on
    // every progress update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);

  const retry = useCallback(async () => {
    if (!note) return;
    const data = await apiJson<{ note: NoteDTO }>(`/api/notes/${note.id}/retry`, { method: 'POST' });
    setNote(data.note);
    void drive(note.id);
  }, [note, drive]);

  return { note, setNote, retry, workerError };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
