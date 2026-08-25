import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/webm',
  'application/octet-stream',
];

const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Issues short-lived client tokens so the browser uploads straight to blob
 * storage. This is what lets us accept a 90-minute recording at all: the file
 * never passes through a serverless function, so the 4.5 MB request-body limit
 * simply does not apply.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error: 'STORAGE_NOT_CONFIGURED',
        message:
          'Blob storage is not configured. Create a Vercel Blob store and set BLOB_READ_WRITE_TOKEN.',
      },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED,
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
      }),
      // Fired by Vercel after the upload lands. We don't depend on it — the
      // browser tells us about the blob explicitly — so this is just a log hook.
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob] stored', blob.pathname);
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UPLOAD_TOKEN_FAILED',
        message: err instanceof Error ? err.message : 'Could not authorise the upload.',
      },
      { status: 400 },
    );
  }
}
