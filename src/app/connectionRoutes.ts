import { emptyDraft, findProtocol, protocolCatalog, protocolUsesUsername, type ConnectionProfile, type Protocol } from "../domain/connection";

export function newRouteDraft(source: ConnectionProfile, profiles: readonly ConnectionProfile[], requestedProtocol?: Protocol) {
  const used = new Set(profiles.filter(profile => profile.id === source.id ||
    (source.machineId && profile.machineId === source.machineId)).map(profile => profile.protocol));
  const protocol = requestedProtocol ?? protocolCatalog.find(entry => !used.has(entry.id))?.id ?? source.protocol;
  return { ...emptyDraft(protocol), name: source.name,
    hostname: source.hostname, username: protocolUsesUsername(protocol) ? source.username : "",
    port: findProtocol(protocol).defaultPort, group: source.group, tags: [...source.tags],
    environment: source.environment, machineId: source.machineId ?? source.id };
}

export function savedRouteProfiles(profiles: readonly ConnectionProfile[], profile: ConnectionProfile, linkedProfileId?: string) {
  const source = linkedProfileId ? profiles.find(entry => entry.id === linkedProfileId) : undefined;
  if (linkedProfileId && (!source || source.id === profile.id)) throw new Error("The source connection is no longer available.");
  if (linkedProfileId && profiles.some(entry => entry.id === profile.id)) throw new Error("A new route needs its own identity.");
  const machineId = source?.machineId ?? source?.id;
  const saved = machineId ? { ...profile, machineId } : profile;
  const next = profiles.map(entry => entry.id === saved.id ? saved : source && entry.id === source.id
    ? { ...entry, machineId } : entry);
  return profiles.some(entry => entry.id === saved.id) ? next : [...next, saved];
}
