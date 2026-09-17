/** Only classify a relay DNS lookup failure; other relay errors need their own details. */
export function isRelayDnsFailure(reason: string | null): boolean {
  return reason !== null &&
    /^relay\s*[:.]\s*(?:i\/o|io) error:/i.test(reason) &&
    /\(os error 11001\)|no such host is known|failed to lookup address information|name or service not known|nodename nor servname provided/i.test(reason);
}
