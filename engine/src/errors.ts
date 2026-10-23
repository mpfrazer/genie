/** An expected, user-facing failure: printed without a stack trace. */
export class GenieError extends Error {
  override name = 'GenieError';
}
