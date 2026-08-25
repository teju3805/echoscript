import { NextResponse } from 'next/server';
import { getNote, toDTO } from '@/lib/notes';
import { ownerFromRequest } from '@/lib/owner';
import { retryNote } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const note = await getNote(params.id);
    if (!note) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'No such note.' }, { status: 404 });
    }
    if (note.owner_id !== ownerFromRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN', message: 'This note belongs to another session.' }, { status: 403 });
    }

    await retryNote(note);
    const fresh = await getNote(params.id);
    return NextResponse.json({ note: fresh ? toDTO(fresh) : null });
  } catch (err) {
    return NextResponse.json(
      { error: 'RETRY_FAILED', message: err instanceof Error ? err.message : 'Could not retry.' },
      { status: 500 },
    );
  }
}
