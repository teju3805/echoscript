import { encodeWav } from './wav';

export const TARGET_SAMPLE_RATE = 16_000;
/**
 * Gnani's REST endpoint rejects clips well before its documented 60 s ceiling,
 * so we target 25 s and leave real headroom. Shorter chunks also mean finer
 * progress reporting and a smaller loss if any single chunk fails.
 */
export const TARGET_CHUNK_SEC = 25;
export const SEARCH_WINDOW_SEC = 4;
export const MAX_CHUNKS = 100;

export interface PreparedChunk {
  idx: number;
  start: number;
  end: number;
  blob: Blob;
}

export interface PreparedAudio {
  durationSec: number;
  chunks: PreparedChunk[];
  peaks: number[];
}

export class AudioPrepError extends Error {
  code: 'DECODE_FAILED' | 'TOO_LONG' | 'EMPTY' | 'UNSUPPORTED';
  constructor(code: AudioPrepError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

function audioContext(): AudioContext {
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new AudioPrepError('UNSUPPORTED', 'This browser has no Web Audio support.');
  return new Ctor();
}

/** Decodes anything the browser can read, then resamples to 16 kHz mono. */
async function decodeToMono16k(file: Blob): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = audioContext();

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new AudioPrepError(
      'DECODE_FAILED',
      'The browser could not decode this audio file. It may be corrupt or in an unsupported codec.',
    );
  } finally {
    void ctx.close();
  }

  if (!decoded.length) throw new AudioPrepError('EMPTY', 'This file contains no audio data.');

  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  // A mono destination makes the OfflineAudioContext down-mix for us.
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** RMS energy per 100 ms frame — used both for split points and the waveform. */
function frameEnergy(samples: Float32Array, frameSize: number): Float32Array {
  const count = Math.max(1, Math.floor(samples.length / frameSize));
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const v = samples[base + i] || 0;
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / frameSize);
  }
  return out;
}

/**
 * Picks the quietest 100 ms frame near each target boundary so chunks break in
 * a pause rather than in the middle of a word. Cutting mid-word is the single
 * biggest quality loss when you chunk audio for ASR.
 */
function findSplitPoints(energy: Float32Array, framesPerSec: number, totalSec: number): number[] {
  const points: number[] = [];
  let cursor = 0;

  while (totalSec - cursor > TARGET_CHUNK_SEC + SEARCH_WINDOW_SEC) {
    const target = cursor + TARGET_CHUNK_SEC;
    const from = Math.floor((target - SEARCH_WINDOW_SEC) * framesPerSec);
    const to = Math.min(energy.length - 1, Math.floor((target + SEARCH_WINDOW_SEC) * framesPerSec));

    let bestIdx = Math.floor(target * framesPerSec);
    let bestVal = Number.POSITIVE_INFINITY;
    for (let i = from; i <= to; i++) {
      if (energy[i] < bestVal) {
        bestVal = energy[i];
        bestIdx = i;
      }
    }
    const cut = bestIdx / framesPerSec;
    if (cut <= cursor + 1) break;
    points.push(cut);
    cursor = cut;
  }

  return points;
}

function downsamplePeaks(energy: Float32Array, buckets: number): number[] {
  const out: number[] = [];
  const size = Math.max(1, Math.floor(energy.length / buckets));
  let max = 0.0001;
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    for (let i = b * size; i < (b + 1) * size && i < energy.length; i++) {
      peak = Math.max(peak, energy[i]);
    }
    out.push(peak);
    max = Math.max(max, peak);
  }
  return out.map((v) => Math.min(1, v / max));
}

export async function prepareAudio(
  file: File | Blob,
  onProgress?: (fraction: number, label: string) => void,
): Promise<PreparedAudio> {
  onProgress?.(0.05, 'Decoding audio');
  const samples = await decodeToMono16k(file);
  const durationSec = samples.length / TARGET_SAMPLE_RATE;

  onProgress?.(0.35, 'Analysing waveform');
  const frameSize = Math.floor(TARGET_SAMPLE_RATE / 10); // 100 ms
  const energy = frameEnergy(samples, frameSize);
  const peaks = downsamplePeaks(energy, 240);

  const cuts = findSplitPoints(energy, 10, durationSec);
  const bounds = [0, ...cuts, durationSec];

  if (bounds.length - 1 > MAX_CHUNKS) {
    throw new AudioPrepError(
      'TOO_LONG',
      `This recording is ${Math.round(durationSec / 60)} minutes long, which exceeds the ${Math.round(
        (MAX_CHUNKS * TARGET_CHUNK_SEC) / 60,
      )}-minute ceiling for a single job. Split it and upload the parts separately.`,
    );
  }

  const chunks: PreparedChunk[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const from = Math.floor(start * TARGET_SAMPLE_RATE);
    const to = Math.min(samples.length, Math.floor(end * TARGET_SAMPLE_RATE));
    if (to - from < TARGET_SAMPLE_RATE * 0.2) continue; // skip slivers under 200 ms
    chunks.push({ idx: chunks.length, start, end, blob: encodeWav(samples.subarray(from, to), TARGET_SAMPLE_RATE) });
    onProgress?.(0.35 + (0.6 * (i + 1)) / (bounds.length - 1), `Encoding chunk ${i + 1}`);
  }

  if (!chunks.length) throw new AudioPrepError('EMPTY', 'No audible content found in this file.');

  onProgress?.(1, 'Ready to upload');
  return { durationSec, chunks, peaks };
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
