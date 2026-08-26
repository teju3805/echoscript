# Echoscript

Upload a recording, get a timestamped transcript from **Gnani Prisma v2.5** and an LLM-generated summary. Past uploads are listed and reopenable.

Built for the Audio Notes Platform assignment.

- **Live:** _add your Vercel URL here_
- **Architecture write-up:** `/architecture` on the deployed site

---

## The core problem

Gnani's synchronous REST endpoint (`POST /stt/v3`) caps at **60 seconds**. The brief asks for 2-minute-plus audio. Everything in this codebase follows from that gap, plus a second constraint: serverless functions can be killed mid-flight, so no step may assume it will finish.

**How it's solved**

1. The browser decodes the file with the Web Audio API and resamples to 16 kHz mono — the format Gnani normalises to internally.
2. Audio over ~25 s is split at **silence-aware boundaries**: RMS energy is computed over 100 ms frames, and each cut lands on the quietest frame within ±4 s of the target, so chunks break in pauses rather than mid-word.
3. Chunks upload **directly to blob storage**, bypassing the 4.5 MB serverless body limit entirely. Each 25 s chunk is ~800 KB, far inside the Batch API's 10 MB per-file ceiling regardless of source bitrate.
4. Gnani's **Batch Jobs API** pulls those public URLs itself — the audio is never uploaded twice.
5. Per-chunk timestamps are **shifted by each chunk's offset** so the stitched transcript maps back onto the original timeline. That's what makes the transcript click-to-seek.

**Strategy routing** — selected once and shown in the UI:

| Strategy | When | How |
|---|---|---|
| `rest_single` | one chunk under 25 s | single synchronous REST call |
| `batch_segments` | over 8 chunks (~3.5 min), batch-supported language | one batch job, poll every 10 s, stitch |
| `rest_segments` | under 8 chunks, Gujarati/Punjabi, or batch fallback | chunks over REST, one at a time |
| `batch_whole` | browser couldn't decode the file | hand the original to Gnani's decoder |

## Background processing

Rather than one long-running job, the pipeline is a **state machine where every transition is small, idempotent, and committed before the function returns**. Notes are claimed with an optimistic lock:

```sql
UPDATE notes SET locked_until = NOW() + interval '55 seconds'
 WHERE id = $1 AND status NOT IN ('READY','READY_PARTIAL','FAILED')
   AND next_run_at <= NOW()
   AND (locked_until IS NULL OR locked_until < NOW())
RETURNING *
```

Whoever wins the `UPDATE` does the next step; everyone else gets current state back. Safe for the note page, the home page and the cron sweeper to push the same note concurrently.

**Known limitation, stated honestly:** the loop is driven by the browser. Vercel's Hobby plan fires cron only once a day, so `/api/cron/tick` is a sweeper for abandoned notes, not the primary driver. Close the tab mid-transcription and the note resumes when you reopen the app. On a paid plan, change the cron to `* * * * *` and the browser becomes irrelevant — no code change needed.

## Failure handling

Every failure normalises to a code with a user-facing message, a hint, and a **retryable** flag. Retry is only offered when retrying could actually help.

| Failure | Behaviour |
|---|---|
| Corrupt / exotic codec | warning, upload continues, original sent to Batch |
| File too large or too long | rejected before upload with real numbers |
| Gnani 401 | `ASR_AUTH`, non-retryable, names the env var to fix |
| Gnani 429 / timeout / 5xx | backoff 2 s → 6 s → 15 s → 40 s, max 4 attempts |
| One chunk fails | note completes `READY_PARTIAL`, gap marked inline at its real timestamp |
| Batch job `START_FAILED` | strategy rewritten to `rest_segments`, same chunks retried |
| Summariser fails | labelled extractive fallback; the transcript is never lost |
| Silent / music-only audio | `ASR_EMPTY`, non-retryable, likely cause named |

Every transition appends to a per-note timeline the UI renders as a live pipeline log. No silent failure states.

## Stack

Next.js 14 (App Router) · TypeScript · Postgres via `pg` (schema self-bootstraps, no migration step) · Vercel Blob · Gnani Prisma v2.5 · pluggable LLM (Gemini / Groq / OpenAI / Anthropic) with a deterministic extractive fallback.

---

## Deploy

**1. Push to GitHub**

```bash
git init && git add -A && git commit -m "Echoscript"
git remote add origin https://github.com/<you>/echoscript.git
git push -u origin main
```

**2. Import on Vercel** — vercel.com → Add New → Project → pick the repo. Don't deploy yet.

**3. Create a Blob store** — project → Storage → Create → Blob → Connect. This injects `BLOB_READ_WRITE_TOKEN` automatically.

**4. Add environment variables** — Settings → Environment Variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (`postgresql://…`) |
| `GNANI_API_KEY` | from the Gnani dashboard (Speech-to-Text scope) |
| `GEMINI_API_KEY` | from aistudio.google.com |
| `NEXT_PUBLIC_REPO_URL` | your GitHub repo URL |

**5. Deploy.** The schema creates itself on first request. Visit `/api/health` to confirm all four checks are green.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

## Tests

`test/mock-gnani.js` is a stand-in for Gnani's REST + Batch APIs that can be forced into failure modes, so the pipeline can be exercised without spending credits.

```bash
node test/mock-gnani.js &                    # or MOCK_MODE=auth_fail|batch_start_fail|partial
GNANI_BASE_URL=http://localhost:4010 \
BLOB_PUBLIC_HOST=localhost npm start &
node test/e2e.js
```

### Calibrated against the live API

Two constants were corrected after the first real run, and both are worth knowing:

- **The REST endpoint rejects clips well short of its documented 60 s ceiling.** 45 s chunks came back as `AUDIO_TOO_LONG`, so the target chunk is 25 s and `restMaxSeconds` is 30.
- **Three concurrent REST calls trip the free tier's rate limiter.** Requests are now serial.
- **Google retires Gemini model ids on a schedule.** `gemini-2.5-flash` started returning 404 mid-deployment, so the adapter now asks the API which models it currently serves and picks the newest Flash it offers, caching the answer. Gemini 3.x also dropped the sampling parameters, so `temperature` is no longer sent.

The first live run also exercised the resilience paths for real: a batch job returned `START_FAILED (ReadTimeout)` when Gnani could not pull the blob URLs in time, and the pipeline fell back to REST on its own — exactly as designed.

Verified: all four strategies reach `READY`; auth failure is non-retryable with a clear hint; a `START_FAILED` batch job falls back to REST and still completes; a failed chunk yields `READY_PARTIAL` with the gap marked; unreachable upstream retries with backoff; cross-session note access returns 403.
