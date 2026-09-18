/**
 * The address of a CLIProxyAPI server the user runs themselves.
 *
 * Only the address lives here. The API key is held by the desktop side in the
 * credential store and is never read back into the interface, so there is
 * nothing secret to keep in local storage.
 *
 * Address rules are deliberately not repeated on this side: the desktop
 * normalizes and checks the address, and its refusals arrive as message keys
 * that `cliProxyMessageKey` turns back into translated text. Two copies of the
 * same rules would drift, and the desktop's copy is the one that decides.
 */

export const CLI_PROXY_SETTINGS_KEY = "latticeterm.cliProxyApi.v2";
/** The single-proxy shape that shipped first. It is read once and then
 * replaced by the list, so an upgrade keeps the address already saved. */
export const CLI_PROXY_LEGACY_SETTINGS_KEY = "latticeterm.cliProxyApi.v1";
export const CLI_PROXY_SETTINGS_CHANGED = "latticeterm:cliproxy-changed";
export const CLI_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CLI_PROXY_NAME = "CLIProxyAPI";
/** The proxy that existed before several could be configured. Its key stays
 * in the original credential slot, so nobody has to enter it again. */
export const CLI_PROXY_DEFAULT_ID = "default";
/** Enough for a few upstream accounts without turning the picker into a list
 * nobody can read. */
export const CLI_PROXY_LIMIT = 8;

const PROVIDER = "latticeterm_cliproxyapi";
const MAX_BASE_URL_LENGTH = 256;
const MAX_LABEL_LENGTH = 64;
const ID_PATTERN = /^[a-z0-9]{1,32}$/;

export interface CliProxyEndpoint {
  /** Stable across address changes; names this proxy's credential slot. */
  id: string;
  /** What the pickers show. The address stands in when it is empty. */
  label: string;
  baseUrl: string;
}

export interface CliProxySettings {
  proxies: readonly CliProxyEndpoint[];
}

export interface CliProxyModel {
  id: string;
  ownedBy: string | null;
}

export const emptyCliProxySettings: CliProxySettings = { proxies: [] };

export function validCliProxyId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Identifiers are only ever compared, never shown, so a short random value
 * is enough and keeps the launch arguments readable. */
export function newCliProxyId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cliProxyLabel(endpoint: CliProxyEndpoint): string {
  if (endpoint.label) return endpoint.label;
  try {
    return new URL(endpoint.baseUrl).host;
  } catch {
    return endpoint.baseUrl;
  }
}

export function findCliProxy(settings: CliProxySettings, id: string | undefined): CliProxyEndpoint | null {
  const wanted = id ?? CLI_PROXY_DEFAULT_ID;
  return settings.proxies.find((endpoint) => endpoint.id === wanted) ?? null;
}

function sanitizeEndpoint(value: unknown): CliProxyEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<CliProxyEndpoint>;
  const id = typeof entry.id === "string" ? entry.id : "";
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  const label = typeof entry.label === "string" ? entry.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  if (!validCliProxyId(id) || baseUrl === "" || baseUrl.length > MAX_BASE_URL_LENGTH) return null;
  return { id, label, baseUrl };
}

function sanitizeProxies(list: unknown): CliProxyEndpoint[] {
  if (!Array.isArray(list)) return [];
  const proxies: CliProxyEndpoint[] = [];
  for (const entry of list) {
    const endpoint = sanitizeEndpoint(entry);
    if (!endpoint || proxies.some((kept) => kept.id === endpoint.id)) continue;
    proxies.push(endpoint);
    if (proxies.length === CLI_PROXY_LIMIT) break;
  }
  return proxies;
}

export function loadCliProxySettings(storage: Pick<Storage, "getItem">): CliProxySettings {
  try {
    const raw = storage.getItem(CLI_PROXY_SETTINGS_KEY);
    if (raw !== null) {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return emptyCliProxySettings;
      return { proxies: sanitizeProxies((value as { proxies?: unknown }).proxies) };
    }
    const legacy: unknown = JSON.parse(storage.getItem(CLI_PROXY_LEGACY_SETTINGS_KEY) ?? "null");
    if (!legacy || typeof legacy !== "object") return emptyCliProxySettings;
    const baseUrl = (legacy as { baseUrl?: unknown }).baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "" || baseUrl.length > MAX_BASE_URL_LENGTH) {
      return emptyCliProxySettings;
    }
    return { proxies: [{ id: CLI_PROXY_DEFAULT_ID, label: "", baseUrl: baseUrl.trim() }] };
  } catch {
    return emptyCliProxySettings;
  }
}

export function saveCliProxySettings(
  storage: Pick<Storage, "setItem" | "removeItem">,
  settings: CliProxySettings,
): void {
  const proxies = sanitizeProxies(settings.proxies);
  if (proxies.length === 0) storage.removeItem(CLI_PROXY_SETTINGS_KEY);
  else storage.setItem(CLI_PROXY_SETTINGS_KEY, JSON.stringify({ proxies }));
  // The migrated copy would otherwise reappear once the list is emptied.
  storage.removeItem(CLI_PROXY_LEGACY_SETTINGS_KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLI_PROXY_SETTINGS_CHANGED));
}

export function cliProxyConfigured(settings: CliProxySettings): boolean {
  return settings.proxies.length > 0;
}

/** Reserved provider; only public connection metadata goes into saved launches. */
export function cliProxyLaunchArguments(baseUrl: string, proxyId: string = CLI_PROXY_DEFAULT_ID): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("cliproxy.url.empty");
  if (!validCliProxyId(proxyId)) throw new Error("cliproxy.id.invalid");
  const provider = proxyId === CLI_PROXY_DEFAULT_ID ? PROVIDER : `${PROVIDER}_${proxyId}`;
  return ["-c", `model_provider=${provider}`, "-c",
    `model_providers.${provider}.base_url=${JSON.stringify(`${base}/v1`)}`];
}

/**
 * Which configured proxy a saved launch belongs to. The marker written before
 * this list existed carries no identifier and answers with the default one,
 * so restoring an older workspace still finds its key.
 */
export function cliProxyIdFromArguments(launchArguments: readonly string[] | undefined): string | null {
  const args = launchArguments ?? [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index - 1] !== "-c" && args[index - 1] !== "--config") continue;
    const value = args[index];
    if (!value.startsWith("model_provider=")) continue;
    const provider = value.slice("model_provider=".length);
    if (provider === PROVIDER) return CLI_PROXY_DEFAULT_ID;
    if (!provider.startsWith(`${PROVIDER}_`)) continue;
    const id = provider.slice(PROVIDER.length + 1);
    if (validCliProxyId(id)) return id;
  }
  return null;
}

/** A session started through the proxy is named after the proxy, because the
 * model it answers with belongs to the proxy rather than to the CLI account. */
export function launchedThroughCliProxy(launchArguments: readonly string[] | undefined): boolean {
  return cliProxyIdFromArguments(launchArguments) !== null;
}

const MESSAGE_KEYS = [
  "cliproxy.id.invalid",
  "cliproxy.url.empty",
  "cliproxy.url.long",
  "cliproxy.url.invalid",
  "cliproxy.url.scheme",
  "cliproxy.key.empty",
  "cliproxy.key.long",
  "cliproxy.key.invalid",
  "cliproxy.key.rebound",
  "cliproxy.models.unauthorized",
  "cliproxy.models.unreadable",
  "cliproxy.models.oversized",
  "cliproxy.models.empty",
] as const;

export type CliProxyMessageKey = (typeof MESSAGE_KEYS)[number];

/**
 * Desktop refusals arrive as a message key so they can be translated. A
 * transport failure arrives as the underlying text instead; that text is
 * shown as-is rather than guessed at, because it names the real problem.
 */
export function cliProxyMessageKey(reason: unknown): CliProxyMessageKey | null {
  const text = String(reason);
  return MESSAGE_KEYS.find((key) => text === key) ?? null;
}

/** The status code the proxy answered with, when it answered at all. */
export function cliProxyStatusCode(reason: unknown): number | null {
  const match = /^cliproxy\.models\.status:(\d{3})$/.exec(String(reason));
  return match ? Number(match[1]) : null;
}

export function cliProxyModelLabel(model: CliProxyModel): string {
  return model.ownedBy ? `${model.id} · ${model.ownedBy}` : model.id;
}

export interface CliProxyModelGroup {
  brand: string | null;
  models: readonly CliProxyModel[];
}

/**
 * The picker shows one brand at a time, strongest model first. The proxy
 * list arrives in whatever order the proxy chose, and the id is the only
 * strength signal available, so the numbers inside it (6, 5.6, 2.5, …) are
 * compared from the left as dotted versions and bigger means stronger.
 * Models without a number, and models without a brand, sink to the end of
 * their group and of the list; ties keep the proxy's own order.
 */
export function groupCliProxyModels(models: readonly CliProxyModel[]): CliProxyModelGroup[] {
  const groups: { brand: string | null; key: string | null; models: CliProxyModel[] }[] = [];
  for (const model of models) {
    const brand = model.ownedBy?.trim() || null;
    const key = brand === null ? null : brand.toLowerCase();
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.models.push(model);
    else groups.push({ brand, key, models: [model] });
  }
  for (const group of groups) {
    group.models.sort((first, second) => compareModelStrength(first.id, second.id));
  }
  return [...groups.filter((group) => group.key !== null), ...groups.filter((group) => group.key === null)]
    .map(({ brand, models: grouped }) => ({ brand, models: grouped }));
}

function dottedVersions(id: string): number[][] {
  return (id.match(/\d+(?:\.\d+)*/g) ?? []).map((version) => version.split(".").map(Number));
}

function compareModelStrength(first: string, second: string): number {
  const left = dottedVersions(first);
  const right = dottedVersions(second);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftParts = left[index] ?? [];
    const rightParts = right[index] ?? [];
    for (let part = 0; part < Math.max(leftParts.length, rightParts.length); part += 1) {
      const difference = (rightParts[part] ?? 0) - (leftParts[part] ?? 0);
      if (difference !== 0) return difference;
    }
  }
  return 0;
}
