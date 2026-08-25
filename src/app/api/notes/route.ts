import { NextResponse } from 'next/server';
import { createNote, listNotes, toDTO } from '@/lib/notes';
import { ownerFromRequest } from '@/lib/owner';
import { isValidLanguage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only accept blob URLs we actually issued — a note must never point at an arbitrary host. */
function isOurBlob(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && u.hostname.endsWith('.public.blob.vercel-storage.com')) {
      return true;
    }
    // Escape hatch for local development and the end-to-end test harness, where
    // the blob store is a plain-http stub. Never set in production.
    const devHost = process.env.BLOB_PUBLIC_HOST;
    if (devHost && u.hostname === devHost && (u.protocol === 'https:' || u.protocol === 'http:')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface CreateBody {
  filename?: string;
  mimeType?: string | null;
  sizeBytes?: number;
  durationSec?: number | null;
  languageCode?: string;
  source?: string;
  audio?: { url?: string; pathname?: string | null };
  chunks?: { idx: number; start: number; end: number; url: string; pathname?: string | null; size?: number }[];
}

export async function GET(request: Request) {
  try {
    const owner = ownerFromRequest(request);
    const rows = await listNotes(owner);
    return NextResponse.json({ notes: rows.map(toDTO) });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'DB_UNAVAILABLE',
        message: err instanceof Error ? err.message : 'Database unavailable.',
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const owner = ownerFromRequest(request);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'BAD_JSON', message: 'Malformed request body.' }, { status: 400 });
  }

  const audioUrl = body.audio?.url;
  if (!audioUrl || !isOurBlob(audioUrl)) {
    return NextResponse.json(
      { error: 'BAD_AUDIO_URL', message: 'The audio URL is missing or not from this app’s blob store.' },
      { status: 400 },
    );
  }

  const language = body.languageCode && isValidLanguage(body.languageCode) ? body.languageCode : 'en-IN';
  const chunks = (body.chunks || []).filter((c) => isOurBlob(c.url));
  if ((body.chunks?.length || 0) !== chunks.length) {
    return NextResponse.json(
      { error: 'BAD_CHUNK_URL', message: 'One or more chunk URLs were rejected.' },
      { status: 400 },
    );
  }

  const filename = (body.filename || 'recording').slice(0, 180);

  try {
    const note = await createNote({
      ownerId: owner,
      title: filename.replace(/\.[^.]+$/, '').slice(0, 90) || 'Untitled recording',
      filename,
      mimeType: body.mimeType ?? null,
      sizeBytes: Math.max(0, Math.round(body.sizeBytes || 0)),
      durationSec: typeof body.durationSec === 'number' ? body.durationSec : null,
      languageCode: language,
      source: body.source === 'microphone' ? 'microphone' : 'upload',
      audioUrl,
      audioPathname: body.audio?.pathname ?? null,
      segments: chunks.map((c) => ({
        idx: c.idx,
        start: c.start,
        end: c.end,
        url: c.url,
        pathname: c.pathname ?? null,
        size: c.size ?? 0,
      })),
    });

    return NextResponse.json({ note: toDTO(note) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'CREATE_FAILED',
        message: err instanceof Error ? err.message : 'Could not create the note.',
      },
      { status: 500 },
    );
  }
}
