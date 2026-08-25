import { notFound } from 'next/navigation';
import NoteView from '@/components/NoteView';
import { getNote, toDTO } from '@/lib/notes';
import { ownerFromContext } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export default async function NotePage({ params }: { params: { id: string } }) {
  let note = null;
  try {
    note = await getNote(params.id);
  } catch {
    note = null;
  }

  if (!note) notFound();
  if (note.owner_id !== ownerFromContext()) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-24 text-center">
        <h1 className="font-display text-3xl text-bone-100">This recording isn&apos;t yours</h1>
        <p className="mt-3 text-sm text-bone-400">
          Notes are scoped to the browser session that uploaded them. Nothing is shared between
          visitors.
        </p>
      </div>
    );
  }

  return <NoteView initial={toDTO(note)} />;
}
