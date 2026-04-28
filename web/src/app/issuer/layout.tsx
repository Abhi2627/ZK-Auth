/**
 * Issuer Portal Layout — standalone Next.js App Router layout.
 * Does NOT inherit the main app's WsProvider / TelemetryProvider
 * (this is a separate demo portal actor).
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:       'MANIT — ZK-Auth Issuer Portal',
  description: 'University credential issuer demo node for the ZK-Auth three-actor ecosystem',
};

export default function IssuerLayout({
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
