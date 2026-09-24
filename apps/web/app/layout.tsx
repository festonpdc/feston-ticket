import type { ReactNode } from 'react';
// Every document, including 404s, needs a fresh nonce matching its CSP.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Programita Ticketing Core', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="es"><body>{children}</body></html>;
}
