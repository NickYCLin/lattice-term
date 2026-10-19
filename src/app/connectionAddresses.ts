import { isRelayProfile, validateConnectionDraft, type ConnectionDraft } from "../domain/connection";

export function connectionAddressDrafts(draft: ConnectionDraft, hostname: string, port: string) {
  const alternate = !isRelayProfile(draft) && hostname.trim()
    ? { ...draft, hostname, port: port.trim() ? Number(port) : draft.port }
    : undefined;
  return !draft.hostname.trim() && alternate
    ? { primary: alternate, additional: undefined }
    : { primary: draft, additional: alternate };
}

export function validateAdditionalAddress(draft: ConnectionDraft | undefined) {
  if (!draft) return {};
  const { hostname, port } = validateConnectionDraft(draft);
  return { ...(hostname ? { hostname } : {}), ...(port ? { port } : {}) };
}
