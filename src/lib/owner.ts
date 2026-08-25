import { cookies, headers } from 'next/headers';

const COOKIE = 'es_owner';

/** Owner id for a route handler request. */
export function ownerFromRequest(req: Request): string {
  const header = req.headers.get('x-echo-owner');
  if (header) return header;
  const raw = req.headers.get('cookie') || '';
  const match = raw.match(new RegExp(`${COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : 'anonymous';
}

/** Owner id inside a server component. */
export function ownerFromContext(): string {
  const fromHeader = headers().get('x-echo-owner');
  if (fromHeader) return fromHeader;
  return cookies().get(COOKIE)?.value || 'anonymous';
}
