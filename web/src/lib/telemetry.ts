/**
 * Behavioral telemetry collector — stub.
 * Captures mouse/keyboard/scroll events and streams them to the
 * backend WebSocket endpoint.
 * Phase 3 implementation.
 */

export function startTelemetry(_sessionId: string, _wsUrl: string): () => void {
  // Phase 3: attach event listeners, open WebSocket, stream BehaviorEvents
  console.warn('Telemetry collector — Phase 3 target');
  return () => {}; // cleanup fn
}
