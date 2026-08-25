import { NextResponse } from 'next/server';
import { dbHealth } from '@/lib/db';
import { gnaniConfigured } from '@/lib/gnani';
import { summariserLabel } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Booleans and labels only — never echoes a secret. */
export async function GET() {
  const db = await dbHealth();
  return NextResponse.json({
    ok: db.ok && gnaniConfigured() && Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    checks: {
      database: { ok: db.ok, detail: db.ok ? 'connected' : db.detail.slice(0, 160) },
      blobStorage: {
        ok: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        detail: process.env.BLOB_READ_WRITE_TOKEN ? 'token present' : 'BLOB_READ_WRITE_TOKEN missing',
      },
      gnaniAsr: {
        ok: gnaniConfigured(),
        detail: gnaniConfigured() ? 'GNANI_API_KEY present' : 'GNANI_API_KEY missing',
      },
      summariser: { ok: true, detail: summariserLabel() },
    },
    time: new Date().toISOString(),
  });
}
