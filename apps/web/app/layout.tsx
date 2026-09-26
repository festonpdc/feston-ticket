import type { ReactNode } from 'react';
import './globals.css';
import { AuthRecoveryRedirect } from './auth/auth-recovery-redirect';
// Every document, including 404s, needs a fresh nonce matching its CSP.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fest-On · Fiesta de Disfraces Halloween', description: 'Fiesta de Disfraces Halloween · 31 de octubre de 2026 · La Hacienda Riviera Maya' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="es"><body><AuthRecoveryRedirect/>{children}</body></html>;
}
