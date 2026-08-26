import { dbHealth } from '@/lib/db';
import { gnaniConfigured } from '@/lib/gnani';
import { summariserLabel } from '@/lib/pipeline';
import { REPO_URL } from '@/lib/site';

export const dynamic = 'force-dynamic';

function Section({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-white/[0.07] py-10">
      <div className="mb-5 flex items-baseline gap-3">
        <span className="font-mono text-[11px] text-ember-500">{n}</span>
        <h2 className="font-display text-2xl text-bone-100 sm:text-3xl">{title}</h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-bone-400">{children}</div>
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-white/[0.07] bg-white/[0.02]">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-600">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-white/[0.05] last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 align-top text-bone-300">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const M = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12px] text-ember-400">{children}</code>
);

function FlowDiagram() {
  const box = (x: number, y: number, w: number, label: string, sub: string, accent = false) => (
    <g key={`${x}-${y}`}>
      <rect
        x={x}
        y={y}
        width={w}
        height={54}
        rx={10}
        fill={accent ? 'rgba(255,122,47,0.08)' : 'rgba(255,255,255,0.03)'}
        stroke={accent ? 'rgba(255,122,47,0.45)' : 'rgba(255,255,255,0.12)'}
      />
      <text x={x + 14} y={y + 23} fill="#E4E0D8" fontSize="13" fontFamily="Inter, sans-serif">
        {label}
      </text>
      <text x={x + 14} y={y + 40} fill="#6E6E68" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
        {sub}
      </text>
    </g>
  );

  const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) => (
    <line
      key={`${x1}-${y1}-${x2}-${y2}`}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="rgba(255,255,255,0.22)"
      strokeWidth="1.2"
      strokeDasharray={dashed ? '4 4' : undefined}
      markerEnd="url(#arrowhead)"
    />
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.07] bg-ink-950/40 p-4">
      <svg viewBox="0 0 940 400" className="w-full min-w-[720px]" role="img" aria-label="System flow diagram">
        <defs>
          <marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.3)" />
          </marker>
        </defs>

        <text x="16" y="24" fill="#6E6E68" fontSize="10" fontFamily="JetBrains Mono, monospace">
          BROWSER
        </text>
        {box(16, 36, 190, 'Decode + segment', 'Web Audio → 16 kHz mono WAV', true)}
        {arrow(206, 63, 246, 63)}
        {box(246, 36, 180, 'Direct blob upload', 'bypasses the 4.5 MB limit')}

        <text x="16" y="140" fill="#6E6E68" fontSize="10" fontFamily="JetBrains Mono, monospace">
          NEXT.JS ROUTE HANDLERS
        </text>
        {arrow(336, 90, 336, 152)}
        {box(246, 152, 180, 'POST /api/notes', 'writes note + chunk rows')}
        {arrow(426, 179, 470, 179)}
        {box(470, 152, 190, 'POST /notes/:id/step', 'one unit of work, then return', true)}

        <text x="700" y="140" fill="#6E6E68" fontSize="10" fontFamily="JetBrains Mono, monospace">
          UPSTREAM
        </text>
        {arrow(660, 179, 704, 179)}
        {box(704, 152, 216, 'Gnani Prisma v2.5', 'REST /stt/v3 · Batch jobs API')}
        {arrow(812, 206, 812, 250)}
        {box(704, 250, 216, 'LLM summariser', 'Gemini / Groq / OpenAI / Claude')}

        <text x="16" y="258" fill="#6E6E68" fontSize="10" fontFamily="JetBrains Mono, monospace">
          STATE
        </text>
        {box(246, 270, 180, 'Postgres', 'notes · segments · timeline')}
        {arrow(565, 206, 426, 288, true)}
        {arrow(336, 270, 336, 224, true)}

        {box(16, 270, 190, 'Blob storage', 'public URLs Gnani can pull', true)}
        {arrow(246, 297, 206, 297, true)}

        <text x="470" y="352" fill="#6E6E68" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
          solid = request path · dashed = state read/write
        </text>
        <text x="470" y="372" fill="#6E6E68" fontSize="10.5" fontFamily="JetBrains Mono, monospace">
          every step commits before returning — nothing is held in memory
        </text>
      </svg>
    </div>
  );
}

export default async function ArchitecturePage() {
  const db = await dbHealth();
  const checks = [
    { name: 'Postgres', ok: db.ok, detail: db.ok ? 'connected' : db.detail.slice(0, 90) },
    {
      name: 'Blob storage',
      ok: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      detail: process.env.BLOB_READ_WRITE_TOKEN ? 'token present' : 'BLOB_READ_WRITE_TOKEN missing',
    },
    {
      name: 'Gnani ASR',
      ok: gnaniConfigured(),
      detail: gnaniConfigured() ? 'GNANI_API_KEY present' : 'GNANI_API_KEY missing',
    },
    { name: 'Summariser', ok: true, detail: summariserLabel() },
  ];

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <header>
        <p className="label">Architecture</p>
        <h1 className="mt-3 font-display text-4xl leading-tight text-bone-100 sm:text-5xl">
          How Echoscript actually works
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-bone-400">
          The interesting problem in this assignment is not &ldquo;call an ASR API&rdquo;. It is that
          Gnani&apos;s synchronous endpoint caps at 60 seconds while the brief asks for 2-minute-plus
          audio, and that serverless functions can be killed at any moment. Everything below follows
          from those two constraints.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn-primary">
            View the source on GitHub
          </a>
          <a href="/api/health" className="btn-ghost">
            Live health JSON
          </a>
        </div>
      </header>

      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {checks.map((c) => (
          <div
            key={c.name}
            className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-ink-900/60 px-4 py-3"
          >
            <span className="text-sm text-bone-200">{c.name}</span>
            <span
              className={`flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] ${
                c.ok ? 'text-mint-400' : 'text-rose-400'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${c.ok ? 'bg-mint-500' : 'bg-rose-500'}`} />
              {c.detail}
            </span>
          </div>
        ))}
      </div>

      <Section n="01" title="The stack, and why">
        <Table
          head={['Layer', 'Choice', 'Reasoning']}
          rows={[
            ['App', 'Next.js 14 (App Router), TypeScript', 'One deployable for UI and API; server components render the list without a client round-trip.'],
            ['Database', <>Postgres via <M>pg</M></>, 'Row-level locking is what makes the job queue safe. The schema bootstraps itself on first request, so a fresh deploy needs no migration step.'],
            ['Storage', 'Vercel Blob (public)', 'Client-direct uploads, and public URLs that Gnani can fetch itself — no re-uploading audio to the ASR.'],
            ['ASR', 'Gnani Prisma v2.5', <>REST <M>/stt/v3</M> for short clips, the Batch Jobs API for long ones.</>],
            ['Summary', 'Pluggable LLM adapter', 'Gemini, Groq, OpenAI or Claude — whichever key is present. Falls back to an extractive summary so the app never hard-fails on the summary step.'],
            ['Hosting', 'Vercel', 'Serverless fits a bursty, IO-bound workload; the design does not assume any single function survives.'],
          ]}
        />
      </Section>

      <Section n="02" title="Upload to transcript, end to end">
        <FlowDiagram />
        <ol className="mt-6 space-y-4">
          {[
            ['Decode in the browser', <>The file is decoded with the Web Audio API and resampled to 16 kHz mono — the exact format Gnani normalises to internally. If the browser cannot decode it, we keep going and let Gnani&apos;s own decoder try the original file.</>],
            ['Split on silence', <>Audio longer than ~25 s is cut into chunks. Boundaries are not fixed intervals: we compute RMS energy over 100 ms frames and pick the quietest frame within ±4 s of each target, so cuts land in pauses instead of mid-word. Cutting mid-word is the single largest accuracy loss when chunking for ASR.</>],
            ['Upload straight to blob storage', <>The browser gets a short-lived token from <M>/api/blob/upload</M> and uploads directly. Nothing large passes through a function, so the 4.5 MB serverless body limit never applies. Progress comes from real upload events, not a fake timer.</>],
            ['Register the note', <><M>POST /api/notes</M> writes one <M>notes</M> row and one <M>segments</M> row per chunk, all in <M>QUEUED</M>. Blob URLs are validated against our own store before they are accepted.</>],
            ['Work the queue', <>The browser calls <M>POST /api/notes/:id/step</M> in a loop. Each call performs one small unit of work, commits it, and returns how long to wait before the next call.</>],
            ['Stitch and summarise', <>Gnani returns timestamps relative to each chunk. We shift them by the chunk&apos;s offset so the assembled transcript maps back onto the original timeline — which is what makes the transcript click-to-seek. The stitched text then goes to the LLM.</>],
          ].map(([title, body], i) => (
            <li key={i} className="flex gap-4">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ember-500/40 font-mono text-[10px] text-ember-400">
                {i + 1}
              </span>
              <div>
                <p className="text-bone-100">{title}</p>
                <p className="mt-1 text-bone-400">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section n="03" title="File storage">
        <p>
          Audio lives in Vercel Blob under <M>notes/&lt;timestamp&gt;/</M> — the original file plus one
          WAV per chunk. Postgres stores only URLs and metadata; no audio bytes ever go into the
          database.
        </p>
        <p>
          The blobs are public on purpose. Gnani&apos;s Batch API takes a list of public HTTPS paths
          and fetches the audio itself, which means a long recording is never uploaded twice: once
          from the browser to storage, and that is it. The trade-off is that a blob URL is
          unguessable but not secret — for anything with real confidentiality you would issue
          pre-signed URLs with a short TTL instead, which the Batch API also supports.
        </p>
        <p>
          Chunks are 16 kHz mono WAV, roughly 800 KB per 25 seconds. That keeps every file far inside
          the Batch API&apos;s 10 MB per-file ceiling regardless of how the source was encoded, so a
          320 kbps stereo MP3 and a phone voice memo behave identically.
        </p>
      </Section>

      <Section n="04" title="Long audio — the actual problem">
        <p>
          Gnani exposes three speech interfaces, and the assignment sits right on the seam between
          two of them:
        </p>
        <Table
          head={['Interface', 'Limit', 'Used here for']}
          rows={[
            [<M>POST /stt/v3</M>, '30 s in practice (60 s documented)', 'Short clips, and the workhorse path for long audio'],
            ['Batch Jobs API', '100 files/job, 10 MB/file', 'Everything over ~55 s'],
            ['Realtime WebSocket', 'live microphone', 'Not used — this is a file-upload product'],
          ]}
        />
        <p>
          So the router picks a strategy once, at <M>QUEUED</M>, and records it on the note so it is
          visible in the UI:
        </p>
        <Table
          head={['Strategy', 'When', 'How it runs']}
          rows={[
            [<M>rest_single</M>, 'One chunk, under 25 s', 'A single synchronous REST call. Fastest path — usually done in a few seconds.'],
            [<M>batch_segments</M>, 'Over 8 chunks (~3.5 min), batch-supported language', 'All chunks submitted as one batch job by public URL. Poll every 10 s, then download each transcript and stitch.'],
            [<M>rest_segments</M>, <>Under 8 chunks, Gujarati/Punjabi, or as a fallback</>, 'Chunks transcribed over REST one at a time, committing after each. Serial requests never trip Gnani\u2019s rate limiter.'],
            [<M>batch_whole</M>, 'Browser could not decode the file', 'Hand the original to the Batch API and let Gnani decode it.'],
          ]}
        />
        <p>
          Two details matter more than they look. First, <span className="text-bone-200">Gujarati and
          Punjabi are supported on REST but not on Batch</span> — picking either one automatically
          routes to the REST path instead of failing halfway through a job. Second, if a batch job
          comes back <M>START_FAILED</M> (usually because Gnani could not reach a URL), the pipeline
          does not give up: it rewrites the strategy to <M>rest_segments</M> and re-transcribes the
          same chunks over REST.
        </p>
        <p>
          The ceiling is 100 chunks ≈ 40 minutes. Past that the upload is rejected up front with a
          real explanation rather than failing deep in the pipeline.
        </p>
      </Section>

      <Section n="05" title="Synchronous vs background">
        <Table
          head={['Work', 'Where it runs', 'Why']}
          rows={[
            ['Decode, segment, encode WAV', 'Browser, synchronously', 'Uses the user\'s CPU instead of paid compute, and it is the only place the raw file already exists.'],
            ['Upload', 'Browser → blob storage', 'Direct, with real progress events. Never touches a function.'],
            ['Creating the note', 'Server, synchronous (~50 ms)', 'Just two inserts.'],
            ['Transcription + summary', 'Background, one step per request', 'Can take minutes. Never held open in a single function.'],
            ['Progress display', 'Derived from DB state', 'Progress is computed from committed rows, so it can never claim more than actually happened.'],
          ]}
        />
        <p className="text-bone-300">
          The background worker is the part worth explaining. Instead of one long-running job, the
          pipeline is a state machine where <span className="text-bone-100">every transition is small,
          idempotent, and committed before the function returns</span>. A note is claimed with an
          optimistic lock:
        </p>
        <pre className="overflow-x-auto rounded-xl border border-white/[0.07] bg-ink-950/60 p-4 font-mono text-[12px] leading-relaxed text-bone-300">
{`UPDATE notes
   SET locked_until = NOW() + interval '55 seconds'
 WHERE id = $1
   AND status NOT IN ('READY','READY_PARTIAL','FAILED')
   AND next_run_at <= NOW()
   AND (locked_until IS NULL OR locked_until < NOW())
RETURNING *`}
        </pre>
        <p>
          Whoever wins that <M>UPDATE</M> does the next step; everyone else gets the current state
          back. That makes it safe for the note page, the home page and the cron sweeper to all push
          the same note at once, and it means a function killed mid-flight costs one lease window,
          not a corrupted job.
        </p>
        <p>
          <span className="text-bone-200">The honest limitation:</span> the loop is currently driven
          by the browser. Vercel&apos;s Hobby plan only fires cron once a day, so
          <M>/api/cron/tick</M> is a sweeper for abandoned notes rather than the primary driver. If
          you close the tab mid-transcription the note resumes the moment you reopen the app — not
          instantly. The server-side pieces are already in place; on a paid plan you change one cron
          expression to <M>* * * * *</M> and the browser becomes irrelevant.
        </p>
      </Section>

      <Section n="06" title="When things go wrong">
        <p>
          Every failure is normalised into a code with a user-facing message, a hint, and a
          retryable flag. The UI only shows a Retry button when retrying could actually help — an
          invalid API key is not a network blip and pretending otherwise wastes the user&apos;s time.
        </p>
        <Table
          head={['Failure', 'What the user sees', 'What the system does']}
          rows={[
            ['Corrupt or exotic codec', 'A warning, and the upload continues', 'Skips browser segmentation, sends the original to the Batch API'],
            ['File too large / too long', 'Rejected before upload with the actual numbers', 'No wasted bandwidth or credits'],
            [<>Gnani 401 <M>ASR_AUTH</M></>, '"Gnani rejected the API key" + where to fix it', 'Marked non-retryable, no retry loop'],
            [<>Gnani 429 <M>ASR_RATE_LIMIT</M></>, '"Retrying in 6 s (attempt 2/4)"', 'Exponential backoff: 2 s → 6 s → 15 s → 40 s'],
            ['Upstream timeout', 'Same backoff, visible in the log', 'Aborted at the client with AbortController, never hangs'],
            ['One chunk fails', <>Note completes as <M>READY_PARTIAL</M></>, 'The gap is marked inline at its real timestamp — a 40-minute recording is not lost to one bad chunk'],
            ['Batch job cannot start', '"Falling back to REST" in the log', 'Strategy rewritten, same chunks retried on the other endpoint'],
            ['Summariser fails', 'Summary labelled as extractive fallback', 'Transcript is the primary artefact and is never lost'],
            ['Silent / music-only audio', '"The recogniser found no speech"', 'Non-retryable, with the likely cause named'],
          ]}
        />
        <p>
          Every one of those transitions is appended to a per-note timeline that the UI renders as a
          live pipeline log. There is no silent failure state: if something went sideways, it is on
          the page with a timestamp.
        </p>
      </Section>

      <Section n="07" title="Data model">
        <pre className="overflow-x-auto rounded-xl border border-white/[0.07] bg-ink-950/60 p-4 font-mono text-[12px] leading-relaxed text-bone-300">
{`notes      id, owner_id, title, original_filename, duration_sec, language_code,
           audio_url, status, strategy, gnani_job_id, transcript, transcript_json,
           summary, segments_total/done/failed, error_code/message/hint, retryable,
           attempts, locked_until, next_run_at, timeline, timestamps

segments   id, note_id, idx, start_sec, end_sec, url, status, text, lines,
           error_message, attempts`}
        </pre>
        <p>
          <M>owner_id</M> is a random uuid in an httpOnly cookie — no accounts, no personal data, and
          your uploads are not visible to anyone else who opens the URL. <M>transcript_json</M> holds
          the timestamped lines that drive click-to-seek; <M>transcript</M> holds the flat text that
          goes to the LLM and to the .txt export.
        </p>
      </Section>

      <Section n="08" title="Trade-offs, and what I would do next">
        <p className="text-bone-300">Things I chose deliberately, and would revisit with more time:</p>
        <ul className="space-y-3">
          {[
            ['Probe the real limits instead of trusting the docs', 'Two of these numbers came from a live run, not the documentation: the REST endpoint rejects clips well short of its stated 60 s ceiling, and three concurrent requests trip the rate limiter on the free tier. A startup probe that measures both and caches the result would beat hard-coded constants.'],
            ['Move the queue off the browser', 'The state machine is already durable and idempotent — it just needs a real trigger. Upstash QStash or a per-minute cron would make transcription fully server-side, and Gnani\'s callback_url webhook would remove polling entirely.'],
            ['Speaker diarization', 'The Batch API supports two-speaker diarization and the schema already carries a speaker field per line. It is off because chunked audio makes speaker ids inconsistent across chunks — doing it properly needs whole-file jobs plus voice-embedding matching at the seams.'],
            ['Ask questions of a recording', 'Transcripts with timestamps are the hard part, and they are done. Chunk-and-embed for retrieval, then answer with citations that jump to the right second.'],
            ['Better chunk boundaries', 'RMS energy is a cheap proxy for silence. A real VAD (Silero, or WebRTC VAD in WASM) would place cuts more reliably in noisy recordings, and would let us drop long silences entirely to cut ASR cost.'],
            ['Cost and quota visibility', 'Gnani bills by audio minute. The system knows the duration of everything it has processed, so a running credit estimate per note would be a small change and genuinely useful.'],
            ['Resumable uploads', 'Multipart upload is on for files over 8 MB, but a dropped connection still restarts the current part. tus-style resumption would matter for hour-long recordings on mobile data.'],
          ].map(([title, body], i) => (
            <li key={i} className="rounded-xl border border-white/[0.07] px-4 py-3.5">
              <p className="text-bone-100">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-bone-400">{body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section n="09" title="Running it yourself">
        <Table
          head={['Variable', 'Required', 'Notes']}
          rows={[
            [<M>DATABASE_URL</M>, 'Yes', 'Any Postgres. The schema creates itself on first request.'],
            [<M>BLOB_READ_WRITE_TOKEN</M>, 'Yes', 'Injected automatically when a Vercel Blob store is linked to the project.'],
            [<M>GNANI_API_KEY</M>, 'Yes', <>From the Gnani dashboard. Sent as <M>X-API-Key-ID</M>.</>],
            [<M>GEMINI_API_KEY</M>, 'Optional', 'Or GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY. Without one, summaries fall back to extractive and say so.'],
            [<M>CRON_SECRET</M>, 'Optional', 'Locks the sweeper endpoint.'],
          ]}
        />
        <p>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="link-underline text-bone-200">
            The full source, including the README and deploy steps, is on GitHub.
          </a>
        </p>
      </Section>
    </div>
  );
}
