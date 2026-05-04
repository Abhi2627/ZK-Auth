import type { Metadata } from 'next';

export const metadata: Metadata = {
  title:       'Acme Corp — ZK-Auth Verifier Portal',
  description: 'Corporate HR credential verifier demo node for the ZK-Auth three-actor ecosystem',
};

export default function VerifierLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
