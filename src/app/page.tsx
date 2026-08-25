import Link from 'next/link';
import NotesList from '@/components/NotesList';
import UploadPanel from '@/components/UploadPanel';
import { gnaniConfigured } from '@/lib/gnani';
import { listNotes, toDTO } from '@/lib/notes';
import { ownerFromContext } from '@/lib/owner';
import { summariserLabel } from '@/lib/pipeline';
import type { NoteDTO } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const owner = ownerFromContext();

  let notes: NoteDTO[] = [];
  let dbError: string | null = null;
  try {
    notes = (await listNotes(owner)).map(toDTO);
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'Database unavailable.';
  }

  const missing: string[] = [];
  if (dbError) missing.push('DATABASE_URL');
  if (!process.env.BLOB_READ_WRITE_TOKEN) missing.push('BLOB_READ_WRITE_TOKEN');
  if (!gnaniConfigured()) missing.push('GNANI_API_KEY');

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <section className="max-w-3xl">
        <p className="label">Audio notes platform</p>
        <h1 className="mt-3 font-display text-4xl leading-[1.1] text-bone-100 sm:text-6xl">
          Every recording becomes a{' '}
          <span className="italic text-ember-400">searchable transcript</span> and a summary worth
          reading.
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-bone-400">
          Drop in a lecture, a stand-up, a customer call or a voice memo. Echoscript splits it in
          your browser, runs it through Gnani&apos;s Prisma v2.5 speech models, stitches the
          timestamps back together and hands the transcript to an LLM for a summary you can act on.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <span className="chip">Gnani REST + Batch STT</span>
          <span className="chip">Timestamped, click-to-seek</span>
          <span className="chip">Summariser: {summariserLabel()}</span>
        </div>
      </section>

      {missing.length > 0 && (
        <div className="mt-10 rounded-2xl border border-ember-500/30 bg-ember-500/[0.06] p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ember-400">
            Configuration incomplete
          </p>
          <p className="mt-2 text-sm leading-relaxed text-bone-300">
            This deployment is missing{' '}
            <span className="font-mono text-ember-400">{missing.join(', ')}</span>. Uploads will fail
            until they are set in the hosting environment.
          </p>
          {dbError && (
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-bone-600">{dbError}</p>
          )}
          <Link href="/architecture" className="link-underline mt-3 inline-block text-sm text-bone-300">
            See the setup notes on the architecture page
          </Link>
        </div>
      )}

      <div className="mt-10">
        <UploadPanel />
      </div>

      <section className="mt-14">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-2xl text-bone-100">Past uploads</h2>
          <span className="font-mono text-[11px] text-bone-600">
            {notes.length} recording{notes.length === 1 ? '' : 's'}
          </span>
        </div>
        <NotesList initial={notes} />
      </section>
    </div>
  );
}
