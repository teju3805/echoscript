// Drives the real API the way the browser does: create a note, then loop /step.
const BASE = 'http://localhost:3000';
const COOKIE = 'es_owner=test-owner-1';

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

function chunks(n) {
  return Array.from({ length: n }, (_, i) => ({
    idx: i,
    start: i * 45,
    end: (i + 1) * 45,
    url: `http://localhost:4010/blob/notes/1/chunk-${String(i).padStart(3, '0')}.wav`,
    pathname: `notes/1/chunk-${i}.wav`,
    size: 1440000,
  }));
}

async function run(label, payload, { expect = 'READY', maxSteps = 40 } = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const created = await api('/api/notes', { method: 'POST', body: JSON.stringify(payload) });
  if (created.status !== 201) {
    console.log(`   ✗ create failed ${created.status}`, created.body);
    return false;
  }
  const id = created.body.note.id;

  let note = created.body.note;
  for (let i = 0; i < maxSteps; i++) {
    const r = await api(`/api/notes/${id}/step`, { method: 'POST' });
    if (r.status !== 200) {
      console.log(`   ✗ step failed ${r.status}`, r.body);
      return false;
    }
    note = r.body.note;
    const step = r.body.step;
    process.stdout.write(
      `   ${String(i).padStart(2)} ${note.status.padEnd(14)} ${String(note.progress).padStart(3)}%  ${(note.stageDetail || '').slice(0, 62)}\n`,
    );
    if (step.done) break;
    if (step.nextDelayMs) await new Promise((r2) => setTimeout(r2, Math.min(step.nextDelayMs, 1200)));
  }

  const ok = note.status === expect;
  console.log(`   ${ok ? '✓' : '✗'} final=${note.status} (expected ${expect}) strategy=${note.strategy} words=${note.wordCount} lines=${note.lines?.length ?? 0}`);
  if (note.error) console.log(`     error: ${note.error.code} — ${note.error.message}`);
  if (note.summary) console.log(`     summary: "${note.summary.tldr.slice(0, 90)}…" via ${note.summary.generatedBy.slice(0, 50)}`);
  if (note.lines?.length) console.log(`     first line @${note.lines[0].start}s: "${note.lines[0].text.slice(0, 60)}"`);
  if (note.lines?.length) {
    const last = note.lines[note.lines.length - 1];
    console.log(`     last  line @${last.start}s (timestamps ${last.start > 45 ? 'offset correctly' : 'NOT offset!'})`);
  }
  return ok;
}

(async () => {
  const base = {
    filename: 'sprint-review.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 5_200_000,
    languageCode: 'en-IN',
    source: 'upload',
    audio: { url: 'http://localhost:4010/blob/notes/1/original.m4a', pathname: 'notes/1/original.m4a' },
  };

  const results = [];

  results.push([
    'short clip → rest_single',
    await run('short clip (40 s, 1 chunk) → rest_single', {
      ...base,
      filename: 'voice-memo.m4a',
      durationSec: 40,
      chunks: [{ ...chunks(1)[0], end: 40 }],
    }),
  ]);

  results.push([
    'long audio → batch_segments',
    await run('long audio (4 min, 5 chunks) → batch_segments', {
      ...base,
      durationSec: 225,
      chunks: chunks(5),
    }),
  ]);

  results.push([
    'REST-only language → rest_segments',
    await run('Punjabi (REST-only language) → rest_segments', {
      ...base,
      languageCode: 'pa-IN',
      durationSec: 135,
      chunks: chunks(3),
    }),
  ]);

  results.push([
    'undecodable file → batch_whole',
    await run('browser could not decode → batch_whole', {
      ...base,
      durationSec: null,
      chunks: [],
    }),
  ]);

  console.log('\n════ results');
  for (const [name, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
