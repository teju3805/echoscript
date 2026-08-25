import { NextResponse } from 'next/server';
import { getNote, toDTO } from '@/lib/notes';
import { ownerFromRequest } from '@/lib/owner';
import { step } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Advances a note by exactly one unit of work.
 *
 * The browser calls this in a loop while a note is processing, and the cron
 * sweeper calls it for notes whose browser tab went away. It is safe to call
 * concurrently: the note is claimed with an optimistic lock, so the loser of a
 * race just gets the current state back.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const note = await getNote(params.id);
    if (!note) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'No such note.' }, { status: 404 });
    }
    if (note.owner_id !== ownerFromRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN', message: 'This note belongs to another session.' }, { status: 403 });
    }

    const result = await step(params.id);
    const fresh = await getNote(params.id);

    return NextResponse.json({ step: result, note: fresh ? toDTO(fresh) : null });
  } catch (err) {
    return NextResponse.json(
      { error: 'STEP_FAILED', message: err instanceof Error ? err.message : 'Worker error.' },
      { status: 500 },
    );
  }
}
