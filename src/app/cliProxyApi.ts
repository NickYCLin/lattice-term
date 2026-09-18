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

export const CLI_PROXY_SETTINGS_KEY = "latticeterm.cliProxyApi.v1";
export const CLI_PROXY_SETTINGS_CHANGED = "latticeterm:cliproxy-changed";
export const CLI_PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8317";
/** Reserved provider; only public connection metadata goes into saved launches. */
export function cliProxyLaunchArguments(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("cliproxy.url.empty");
  return ["-c", "model_provider=latticeterm_cliproxyapi", "-c",
    `model_providers.latticeterm_cliproxyapi.base_url=${JSON.stringify(`${base}/v1`)}`];
}
const MAX_BASE_URL_LENGTH = 256;

export interface CliProxySettings {
  baseUrl: string;
}

export interface CliProxyModel {
  id: string;
  ownedBy: string | null;
}

export const emptyCliProxySettings: CliProxySettings = { baseUrl: "" };

export function loadCliProxySettings(storage: Pick<Storage, "getItem">): CliProxySettings {
  try {
    const value: unknown = JSON.parse(storage.getItem(CLI_PROXY_SETTINGS_KEY) ?? "null");
    if (!value || typeof value !== "object") return emptyCliProxySettings;
    const baseUrl = (value as Partial<CliProxySettings>).baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "" || baseUrl.length > MAX_BASE_URL_LENGTH) {
      return emptyCliProxySettings;
    }
    return { baseUrl: baseUrl.trim() };
  } catch {
    return emptyCliProxySettings;
  }
}

export function saveCliProxySettings(
  storage: Pick<Storage, "setItem" | "removeItem">,
  settings: CliProxySettings,
): void {
  const baseUrl = settings.baseUrl.trim();
  if (baseUrl === "" || baseUrl.length > MAX_BASE_URL_LENGTH) storage.removeItem(CLI_PROXY_SETTINGS_KEY);
  else storage.setItem(CLI_PROXY_SETTINGS_KEY, JSON.stringify({ baseUrl }));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLI_PROXY_SETTINGS_CHANGED));
}

export function cliProxyConfigured(settings: CliProxySettings): boolean {
  return settings.baseUrl.trim() !== "";
}

const MESSAGE_KEYS = [
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
