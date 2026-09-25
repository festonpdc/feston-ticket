import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const script = dev
    ? "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://js.stripe.com"
    : "script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic' https://js.stripe.com";
  const style = dev
    ? "style-src 'self' 'unsafe-inline'"
    : "style-src 'self' 'nonce-" + nonce + "'";
  const connect = "connect-src 'self' https://api.stripe.com https://r.stripe.com https://m.stripe.network"
    + (dev ? ' ws: http://localhost:* http://127.0.0.1:*' : '');
  const csp = [
    "default-src 'self'",
    script,
    style,
    "img-src 'self' data: https://js.stripe.com https://m.stripe.network",
    "font-src 'self'",
    connect,
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
