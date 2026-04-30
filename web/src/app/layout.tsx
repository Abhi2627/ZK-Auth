import type { Metadata } from 'next';
import { WsProvider }        from '../contexts/WsContext';
import { TelemetryProvider } from '../lib/telemetry';
import { StepUpModal }       from '../components/AuthFlow/StepUpModal';
import './globals.css';

export const metadata: Metadata = {
  title:       'ZK-Auth',
  description: 'Passwordless zero-knowledge proof authentication',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WsProvider>
          <TelemetryProvider>
            {children}
            <StepUpModal />
          </TelemetryProvider>
        </WsProvider>
      </body>
    </html>
  );
}
