import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = 'es_owner';

/**
 * Every visitor gets an anonymous owner id so "past uploads" is scoped to the
 * person who made them. No accounts, no PII — just a random uuid in a cookie.
 * We forward it as a request header too, so the very first request (before the
 * Set-Cookie round-trip completes) already has an identity.
 */
export function middleware(request: NextRequest) {
  const existing = request.cookies.get(COOKIE)?.value;
  const owner = existing || crypto.randomUUID();

  const headers = new Headers(request.headers);
  headers.set('x-echo-owner', owner);

  const response = NextResponse.next({ request: { headers } });
  if (!existing) {
    response.cookies.set(COOKIE, owner, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
