import { NextResponse } from 'next/server';
import { findStalledNotes } from '@/lib/notes';
import { step } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Safety net for notes whose browser tab was closed mid-processing.
 *
 * On Vercel's Hobby plan crons only fire once a day, so this is a sweeper, not
 * the primary driver — the browser loop and the /api/notes/[id]/step endpoint
 * do the real work. On a paid plan you would run this every minute and it
 * becomes a proper background worker with no client involvement at all.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORISED' }, { status: 401 });
  }

  const started = Date.now();
  const processed: { id: string; status: string }[] = [];

  try {
    const stalled = await findStalledNotes(5);
    for (const note of stalled) {
      let guard = 0;
      let result = await step(note.id);
      processed.push({ id: note.id, status: result.status });

      while (!result.done && result.nextDelayMs === 0 && guard++ < 8 && Date.now() - started < 45_000) {
        result = await step(note.id);
        processed[processed.length - 1].status = result.status;
      }
      if (Date.now() - started > 45_000) break;
    }
    return NextResponse.json({ swept: processed.length, processed });
  } catch (err) {
    return NextResponse.json(
      { error: 'SWEEP_FAILED', message: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }
}
