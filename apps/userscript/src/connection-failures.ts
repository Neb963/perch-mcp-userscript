/** Retry only connectivity/read-only reconciliation. Never replay a source or provider effect. */
const TEMPORARY = new Set([
  'INTERNAL_ERROR', 'GATEWAY_DEGRADED', 'GATEWAY_TIMEOUT',
  'GATEWAY_UNAVAILABLE', 'RECONNECT_FAILED',
  'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
]);
export function isRetryableGatewayFailure(code: string | null | undefined, connectivityRetryable?: boolean): boolean {
  return connectivityRetryable !== false && typeof code === 'string' && TEMPORARY.has(code);
}
