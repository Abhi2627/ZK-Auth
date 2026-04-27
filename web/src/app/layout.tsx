import type { Metadata } from 'next';
import { WsProvider }         from '../contexts/WsContext.js';
import { TelemetryProvider }  from '../lib/telemetry.js';
import { StepUpModal }        from '../components/AuthFlow/StepUpModal.js';

export const metadata: Metadata = {
  title:       'ZK-Auth',
  description: 'Passwordless zero-knowledge proof authentication',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/*
          Provider order:
            WsProvider      — establishes the authenticated WebSocket connection
            TelemetryProvider — attaches event listeners, writes to WS
            StepUpModal     — subscribes to STEP_UP_REQUIRED WS events
        */}
        <WsProvider>
          <TelemetryProvider>
            {children}
            {/* StepUpModal renders at root level so it overlays all routes */}
            <StepUpModal />
          </TelemetryProvider>
        </WsProvider>
      </body>
    </html>
  );
}
