// Mock of Gnani's STT REST + Batch APIs, and a stand-in for public blob storage.
// Lets us exercise the whole pipeline locally without spending real credits.
const http = require('http');

const jobs = new Map();
let jobSeq = 0;

// Flip these to exercise failure paths.
const MODE = process.env.MOCK_MODE || 'ok'; // ok | rest_fail | batch_start_fail | auth_fail | partial

const TEXTS = [
  'good morning everyone thanks for joining the sprint review today',
  'we shipped the new billing flow on tuesday and error rates dropped by about forty percent',
  'the main blocker is the vendor api which is still returning timeouts under load',
  'priya will own the retry logic and we should have it merged before friday',
  'lets also decide whether we push the mobile release to next sprint',
];

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const key = req.headers['x-api-key-id'];

  // ---- fake blob storage -------------------------------------------------
  if (path.startsWith('/blob/')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.alloc(2048));
    return;
  }

  if (MODE === 'auth_fail' && path.startsWith('/stt')) {
    return json(res, 401, { detail: { error_code: 'MISSING_API_KEY', message: 'Missing API key' } });
  }
  if (path.startsWith('/stt') && !key) {
    return json(res, 401, { detail: { error_code: 'MISSING_API_KEY', message: 'Missing API key' } });
  }

  // ---- REST ---------------------------------------------------------------
  if (path === '/stt/v3' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (MODE === 'rest_fail') {
      return json(res, 503, { success: false, error: { type: 'SERVICE_UNAVAILABLE', message: 'down' } });
    }
    return json(res, 200, {
      success: true,
      request_id: `req_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: '20260825_120000.000',
      transcript: TEXTS[Math.floor(Math.random() * TEXTS.length)],
    });
  }

  // ---- Batch --------------------------------------------------------------
  if (path === '/stt/v3/batch/jobs' && req.method === 'POST') {
    const body = await readJson(req);
    const id = `job_${++jobSeq}`;
    jobs.set(id, { polls: 0, paths: body?.source?.paths || [], started: false });
    return json(res, 201, { job_id: id, status: 'CREATED', total_files_accepted: null });
  }

  const startMatch = path.match(/^\/stt\/v3\/batch\/jobs\/([^/]+)\/start$/);
  if (startMatch && req.method === 'POST') {
    const job = jobs.get(startMatch[1]);
    if (job) job.started = true;
    return json(res, 202, { job_id: startMatch[1], status: 'STARTING' });
  }

  const filesMatch = path.match(/^\/stt\/v3\/batch\/jobs\/([^/]+)\/files$/);
  if (filesMatch) {
    const job = jobs.get(filesMatch[1]);
    const data = (job?.paths || []).map((p, i) => {
      const failThis = MODE === 'partial' && i === 1;
      return {
        file_id: `f${i}`,
        original_path: p,
        status: failThis ? 'FAILED' : 'COMPLETED',
        duration_seconds: '45.0',
        transcript_url: failThis ? null : `http://localhost:4010/transcripts/${filesMatch[1]}/${i}`,
        error_message: failThis ? 'Empty transcript after 3 retries' : null,
      };
    });
    return json(res, 200, {
      job_id: filesMatch[1],
      data,
      pagination: { has_more: false, next_cursor: null, total_count: data.length },
    });
  }

  const jobMatch = path.match(/^\/stt\/v3\/batch\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'JOB_NOT_FOUND' });
    job.polls++;
    if (MODE === 'batch_start_fail') {
      return json(res, 200, {
        job_id: jobMatch[1],
        status: 'START_FAILED',
        progress: { total_files: 0, completed_files: 0, failed_files: 0, in_progress_files: 0, queued_files: 0, cancelled_files: 0 },
        cancel_reason: 'All provided paths were invalid — nothing to process.',
      });
    }
    const total = job.paths.length;
    const done = job.polls >= 2 ? total : Math.min(total, job.polls);
    const terminal = job.polls >= 2;
    return json(res, 200, {
      job_id: jobMatch[1],
      status: terminal ? (MODE === 'partial' ? 'PARTIAL_FAILURE' : 'COMPLETED') : 'IN_PROGRESS',
      progress: {
        total_files: total,
        completed_files: done,
        failed_files: 0,
        in_progress_files: terminal ? 0 : total - done,
        queued_files: 0,
        cancelled_files: 0,
      },
      cancel_reason: null,
    });
  }

  const tMatch = path.match(/^\/transcripts\/([^/]+)\/(\d+)$/);
  if (tMatch) {
    const i = Number(tMatch[2]);
    const text = TEXTS[i % TEXTS.length];
    const words = text.split(' ');
    const segments = [];
    let t = 0;
    for (let w = 0; w < words.length; w += 5) {
      const piece = words.slice(w, w + 5).join(' ');
      segments.push({ segment_id: 0, start_time: t, end_time: t + 2.5, text: piece, speaker_id: 1 });
      t += 2.5;
    }
    return json(res, 200, {
      file_id: `f${i}`,
      full_transcript: text,
      language_code: 'en-IN',
      duration_seconds: 45,
      segments,
    });
  }

  json(res, 404, { error: 'NOT_FOUND', path });
});

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

server.listen(4010, () => console.log(`mock gnani listening on 4010 (mode=${MODE})`));
