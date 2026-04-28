/**
 * Verifier Portal Layout — standalone Next.js App Router layout.
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:       'Acme Corp — ZK-Auth Verifier Portal',
  description: 'Corporate HR credential verifier demo node for the ZK-Auth three-actor ecosystem',
};

export default function VerifierLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#010409' }}>
        {children}
      </body>
    </html>
  );
}
