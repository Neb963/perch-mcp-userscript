export const errorCodes = [
  'AUTH_REQUIRED', 'SCOPE_DENIED', 'REVOKED', 'APPROVAL_REQUIRED', 'TAB_OFFLINE',
  'TAB_BUSY', 'BINDING_MISMATCH', 'STALE_EPOCH', 'STALE_REVISION', 'NATIVE_CONFLICT',
  'UNSUPPORTED_INTERFACE', 'INVALID_INPUT', 'PATH_DENIED', 'LIMIT_EXCEEDED',
  'QUEUE_FULL', 'QUOTA_EXCEEDED', 'CHALLENGE_REQUIRED', 'PROVIDER_REJECTED',
  'TIMEOUT', 'CANCELLED', 'EFFECT_UNKNOWN', 'PARTIAL_EFFECT', 'RESOURCE_CONFLICT',
  'INCOMPATIBLE_VERSION', 'RESULT_EXPIRED', 'NOT_FOUND', 'FILE_NOT_FOUND',
  'BINARY_FILE', 'PARSE_ERROR', 'STORAGE_CORRUPT',
] as const;

export type ErrorCode = typeof errorCodes[number];

/** Only known-no-effect failures may be retried. An unknown effect is never retryable. */
export class ToolError extends Error {
  readonly name = 'ToolError';
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly recovery = 'Inspect workspace_status and operation_status before changing the request.',
    retryable = false,
  ) {
    super(message);
    this.retryable = code === 'EFFECT_UNKNOWN' || code === 'PARTIAL_EFFECT' ? false : retryable;
  }
  toJSON(): { code: ErrorCode; message: string; recovery: string; retryable: boolean } {
    return { code: this.code, message: this.message, recovery: this.recovery, retryable: this.retryable };
  }
}
