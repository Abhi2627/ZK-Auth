/**
 * Session Routes — /api/v1/session
 * WebSocket upgrade is handled separately in wsServer.ts.
 * These REST endpoints cover session introspection and revocation.
 * Phase 3 will implement full logic.
 */
import { Router } from 'express';

export const sessionRouter = Router();

// GET /api/v1/session/me  — return current session state + risk level
sessionRouter.get('/me', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});

// DELETE /api/v1/session/:sessionId  — revoke a specific session
sessionRouter.delete('/:sessionId', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});

// DELETE /api/v1/session/all  — revoke all sessions for authenticated user
sessionRouter.delete('/all', (_req, res) => {
  res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Phase 3 target' });
});
