import { NextResponse } from 'next/server';
import { deleteNote, getNote, toDTO } from '@/lib/notes';
import { ownerFromRequest } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const note = await getNote(params.id);
    if (!note) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'No such note.' }, { status: 404 });
    }
    if (note.owner_id !== ownerFromRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN', message: 'This note belongs to another session.' }, { status: 403 });
    }
    return NextResponse.json({ note: toDTO(note) });
  } catch (err) {
    return NextResponse.json(
      { error: 'DB_UNAVAILABLE', message: err instanceof Error ? err.message : 'Database unavailable.' },
      { status: 503 },
    );
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const ok = await deleteNote(params.id, ownerFromRequest(request));
    if (!ok) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'No such note.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'DELETE_FAILED', message: err instanceof Error ? err.message : 'Could not delete.' },
      { status: 500 },
    );
  }
}
