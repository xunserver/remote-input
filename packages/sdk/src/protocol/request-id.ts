let requestSequence = 0n;

export function createDefaultRequestId(): string {
  requestSequence += 1n;
  return `request-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}
