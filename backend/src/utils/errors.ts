/**
 * Domain Error Classes
 *
 * All application-layer errors extend AppError, which carries
 * a machine-readable code and HTTP status code.
 * The global error handler in app.ts serialises these to JSON.
 */

export const ErrorCode = {
  // Auth
  INVALID_PROOF: 'INVALID_PROOF',
  NULLIFIER_REPLAY: 'NULLIFIER_REPLAY',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',

  // Credential
  CREDENTIAL_NOT_FOUND: 'CREDENTIAL_NOT_FOUND',
  CREDENTIAL_REVOKED: 'CREDENTIAL_REVOKED',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  INVALID_CLAIM_PROOF: 'INVALID_CLAIM_PROOF',

  // User
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_SUSPENDED: 'USER_SUSPENDED',
  COMMITMENT_ALREADY_REGISTERED: 'COMMITMENT_ALREADY_REGISTERED',

  // Infrastructure
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // General
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  public readonly code: ErrorCodeType;
  public readonly statusCode: number;

  constructor(code: ErrorCodeType, message: string, statusCode = 500) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    // Maintains proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Convenience constructors ─────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message: string) {
    super(ErrorCode.VALIDATION_ERROR, message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(ErrorCode.UNAUTHORIZED, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(ErrorCode.FORBIDDEN, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(ErrorCode.NOT_FOUND, `${resource} not found`, 404);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(ErrorCode.RATE_LIMIT_EXCEEDED, 'Rate limit exceeded', 429);
  }
}

export class StepUpRequiredError extends AppError {
  constructor() {
    super(ErrorCode.STEP_UP_REQUIRED, 'Step-up authentication required', 403);
  }
}
