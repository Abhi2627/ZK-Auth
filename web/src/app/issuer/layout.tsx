import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:       'MANIT — ZK-Auth Issuer Portal',
  description: 'University credential issuer demo node for the ZK-Auth three-actor ecosystem',
};

export default function IssuerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
