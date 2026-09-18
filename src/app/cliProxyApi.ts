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
