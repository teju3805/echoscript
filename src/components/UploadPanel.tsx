'use client';

import { upload } from '@vercel/blob/client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioPrepError, formatBytes, formatDuration, prepareAudio, type PreparedAudio } from '@/lib/audio/segment';
import { apiJson } from '@/lib/client';
import { LANGUAGES, type NoteDTO } from '@/lib/types';

type Phase = 'idle' | 'preparing' | 'uploading' | 'creating' | 'error';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

interface Failure {
  title: string;
  detail: string;
  hint?: string;
}

export default function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [language, setLanguage] = useState('en-IN');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stageLabel, setStageLabel] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number; duration: number | null } | null>(null);

  const busy = phase === 'preparing' || phase === 'uploading' || phase === 'creating';

  const handleFile = useCallback(
    async (file: File, source: 'upload' | 'microphone') => {
      setFailure(null);
      setWarning(null);
      setProgress(0);
      setFileInfo({ name: file.name, size: file.size, duration: null });

      if (file.size === 0) {
        setPhase('error');
        setFailure({ title: 'That file is empty', detail: 'The selected file contains 0 bytes.' });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setPhase('error');
        setFailure({
          title: 'File is too large',
          detail: `${formatBytes(file.size)} exceeds the ${formatBytes(MAX_FILE_BYTES)} limit.`,
          hint: 'Export a compressed MP3 or M4A version and try again.',
        });
        return;
      }

      // ---- 1. Decode and split in the browser -------------------------------
      setPhase('preparing');
      let prepared: PreparedAudio | null = null;
      try {
        prepared = await prepareAudio(file, (fraction, label) => {
          setProgress(Math.round(fraction * 22));
          setStageLabel(label);
        });
        setFileInfo({ name: file.name, size: file.size, duration: prepared.durationSec });
      } catch (err) {
        if (err instanceof AudioPrepError && err.code === 'TOO_LONG') {
          setPhase('error');
          setFailure({ title: 'Recording is too long', detail: err.message });
          return;
        }
        // Decoding failed but the bytes are still fine — hand the original to
        // Gnani's batch decoder rather than refusing the upload outright.
        setWarning(
          'This browser could not decode the file, so it will be sent to Gnani whole instead of being split. Long recordings may fail this way.',
        );
      }

      // ---- 2. Upload straight to blob storage -------------------------------
      setPhase('uploading');
      const stamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60) || 'audio';

      try {
        setStageLabel('Uploading original');
        const original = await upload(`notes/${stamp}/original-${safeName}`, file, {
          access: 'public',
          handleUploadUrl: '/api/blob/upload',
          // MediaRecorder reports 'audio/webm;codecs=opus'; blob storage
          // matches content types exactly, so drop the codec parameter.
          contentType: (file.type || 'application/octet-stream').split(';')[0].trim(),
          multipart: file.size > 8 * 1024 * 1024,
          onUploadProgress: ({ percentage }) => {
            setProgress(22 + Math.round((percentage / 100) * (prepared ? 26 : 70)));
          },
        });

        const uploadedChunks: {
          idx: number;
          start: number;
          end: number;
          url: string;
          pathname: string;
          size: number;
        }[] = [];

        if (prepared) {
          const total = prepared.chunks.length;
          for (const chunk of prepared.chunks) {
            setStageLabel(`Uploading chunk ${chunk.idx + 1} of ${total}`);
            const res = await upload(
              `notes/${stamp}/chunk-${String(chunk.idx).padStart(3, '0')}.wav`,
              chunk.blob,
              {
                access: 'public',
                handleUploadUrl: '/api/blob/upload',
                contentType: 'audio/wav',
              },
            );
            uploadedChunks.push({
              idx: chunk.idx,
              start: chunk.start,
              end: chunk.end,
              url: res.url,
              pathname: res.pathname,
              size: chunk.blob.size,
            });
            setProgress(48 + Math.round(((chunk.idx + 1) / total) * 44));
          }
        }

        // ---- 3. Register the note and hand off to the pipeline --------------
        setPhase('creating');
        setStageLabel('Starting transcription');
        setProgress(96);

        const created = await apiJson<{ note: NoteDTO }>('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || null,
            sizeBytes: file.size,
            durationSec: prepared?.durationSec ?? null,
            languageCode: language,
            source,
            audio: { url: original.url, pathname: original.pathname },
            chunks: uploadedChunks,
          }),
        });

        setProgress(100);
        router.push(`/notes/${created.note.id}`);
        router.refresh();
      } catch (err) {
        setPhase('error');
        const message = err instanceof Error ? err.message : 'Upload failed.';
        setFailure({
          title: 'Upload failed',
          detail: message,
          hint: /STORAGE_NOT_CONFIGURED|BLOB_READ_WRITE_TOKEN/i.test(message)
            ? 'Blob storage is not wired up on this deployment yet.'
            : 'Check your connection and try again — nothing was saved.',
        });
      }
    },
    [language, router],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file, 'upload');
    },
    [handleFile],
  );

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <span className="label">New recording</span>
        <label className="flex items-center gap-2 text-xs text-bone-400">
          <span className="label">Spoken language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-ink-850 px-2.5 py-1.5 font-mono text-[11px] text-bone-200 outline-none transition-colors focus:border-ember-500/60 disabled:opacity-50"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {busy ? (
        <ProgressView progress={progress} label={stageLabel} fileInfo={fileInfo} warning={warning} />
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`px-5 py-10 transition-colors ${dragging ? 'bg-ember-500/[0.06]' : ''}`}
        >
          <div
            className={`rounded-xl border border-dashed p-8 text-center transition-colors ${
              dragging ? 'border-ember-500/70' : 'border-white/[0.12]'
            }`}
          >
            <div className="mx-auto mb-5 flex h-10 items-end justify-center gap-[3px]" aria-hidden>
              {[6, 14, 24, 34, 22, 30, 12, 20, 8].map((h, i) => (
                <span
                  key={i}
                  className="w-[3px] rounded-full bg-gradient-to-t from-ember-600/30 to-ember-500"
                  style={{ height: h }}
                />
              ))}
            </div>

            <p className="font-display text-2xl text-bone-100">Drop a recording here</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-bone-400">
              WAV, MP3, M4A, FLAC, OGG or WebM. Anything over ~25 seconds is split in your browser
              before it is uploaded, so a long lecture works the same way a voice memo does.
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button className="btn-primary" onClick={() => inputRef.current?.click()}>
                Choose a file
              </button>
              <Recorder onRecorded={(file) => handleFile(file, 'microphone')} />
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="audio/*,video/mp4,video/webm"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file, 'upload');
                e.target.value = '';
              }}
            />
          </div>

          {failure && (
            <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-4">
              <p className="text-sm font-medium text-rose-400">{failure.title}</p>
              <p className="mt-1 text-sm text-bone-400">{failure.detail}</p>
              {failure.hint && <p className="mt-2 text-xs text-bone-600">{failure.hint}</p>}
            </div>
          )}

          {warning && !failure && (
            <div className="mt-5 rounded-xl border border-ember-500/25 bg-ember-500/[0.05] p-4 text-sm text-bone-400">
              {warning}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressView({
  progress,
  label,
  fileInfo,
  warning,
}: {
  progress: number;
  label: string;
  fileInfo: { name: string; size: number; duration: number | null } | null;
  warning: string | null;
}) {
  return (
    <div className="px-5 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 flex items-end justify-center gap-[3px]" aria-hidden>
          {Array.from({ length: 28 }).map((_, i) => (
            <span
              key={i}
              className="w-[3px] origin-bottom rounded-full bg-ember-500/80 animate-barPulse"
              style={{ height: 26, animationDelay: `${i * 55}ms` }}
            />
          ))}
        </div>

        <div className="flex items-baseline justify-between">
          <p className="truncate font-mono text-xs text-bone-400">{fileInfo?.name}</p>
          <p className="font-mono text-xs text-ember-400">{progress}%</p>
        </div>

        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-ember-600 to-ember-400 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="mt-3 text-center text-sm text-bone-400">{label}</p>

        {fileInfo && (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <span className="chip">{formatBytes(fileInfo.size)}</span>
            {fileInfo.duration !== null && <span className="chip">{formatDuration(fileInfo.duration)}</span>}
          </div>
        )}

        {warning && (
          <p className="mt-5 rounded-lg border border-ember-500/25 bg-ember-500/[0.05] p-3 text-xs leading-relaxed text-bone-400">
            {warning}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Microphone capture — so a reviewer can test without hunting for a file */
/* ------------------------------------------------------------------ */

function Recorder({ onRecorded }: { onRecorded: (file: File) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes('mp4') ? 'm4a' : 'webm';
        onRecorded(
          new File([blob], `mic-recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${ext}`, {
            type,
          }),
        );
      };

      recorder.start(1000);
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
    } catch {
      setError('Microphone permission was denied.');
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  if (error) {
    return <span className="text-xs text-rose-400">{error}</span>;
  }

  return recording ? (
    <button className="btn border border-rose-500/40 bg-rose-500/10 text-rose-400" onClick={stop}>
      <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulseDot" />
      Stop — {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
    </button>
  ) : (
    <button className="btn-ghost" onClick={start}>
      Record from mic
    </button>
  );
}
