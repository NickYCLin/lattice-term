import { useState } from "react";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";

/**
 * An MCP server asking for a few values (a form) or for a page to be opened
 * (a URL). The desktop checks every answer against the server's schema
 * again; this only draws the fields and keeps the values typed.
 */

type FieldKind = "string" | "number" | "integer" | "boolean" | "choices";

export interface ElicitationField {
  name: string;
  kind: FieldKind;
  title: string;
  description: string;
  required: boolean;
  choices: { value: string; label: string }[];
  format: string | null;
  defaultValue: unknown;
  /** Multi-select only, straight from the schema. */
  minItems: number | null;
  maxItems: number | null;
}

export interface ElicitationRequest {
  mode: "form" | "url";
  serverName: string;
  message: string;
  url: string | null;
  fields: ElicitationField[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function parseElicitation(input: string): ElicitationRequest | null {
  let params: Record<string, unknown> | null;
  try {
    params = object(JSON.parse(input));
  } catch {
    return null;
  }
  if (!params) return null;
  const serverName = typeof params.serverName === "string" ? params.serverName : "";
  const message = typeof params.message === "string" ? params.message : "";
  if (params.mode === "url") {
    if (typeof params.url !== "string") return null;
    try {
      const url = new URL(params.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return { mode: "url", serverName, message, url: url.href, fields: [] };
    } catch {
      return null;
    }
  }
  const schema = object(params.requestedSchema);
  const properties = object(schema?.properties);
  if (!schema || !properties) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const fields: ElicitationField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const field = object(raw);
    const rawKind = field?.type;
    // A list of choices from a fixed set is the one array shape the desktop
    // can check again, so it is the one the window draws.
    const items = rawKind === "array" ? object(field?.items) : null;
    const kind: FieldKind | null =
      rawKind === "string" || rawKind === "number" || rawKind === "integer" || rawKind === "boolean"
        ? rawKind
        : items?.type === "string" && Array.isArray(items.enum)
          ? "choices"
          : null;
    if (!field || !kind) return null;
    const source = kind === "choices" ? (items as Record<string, unknown>) : field;
    const values = Array.isArray(source.enum)
      ? source.enum.filter((v): v is string => typeof v === "string")
      : [];
    if (kind === "choices" && values.length === 0) return null;
    const names = Array.isArray(source.enumNames) ? source.enumNames : [];
    const count = (key: string) =>
      typeof field[key] === "number" && Number.isInteger(field[key]) ? (field[key] as number) : null;
    fields.push({
      name,
      kind,
      title: typeof field.title === "string" && field.title ? field.title : name,
      description: typeof field.description === "string" ? field.description : "",
      required: required.has(name),
      choices: values.map((value, index) => ({
        value,
        label: typeof names[index] === "string" ? (names[index] as string) : value,
      })),
      format: typeof field.format === "string" ? field.format : null,
      defaultValue: field.default,
      minItems: kind === "choices" ? count("minItems") : null,
      maxItems: kind === "choices" ? count("maxItems") : null,
    });
  }
  return fields.length ? { mode: "form", serverName, message, url: null, fields } : null;
}

/** Draft text per field, turned into typed values only on submit. */
function initialDraft(fields: ElicitationField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = field.defaultValue;
      if (field.kind === "boolean") return [field.name, value === true ? "true" : "false"];
      if (field.kind === "choices") {
        const picked = Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : [];
        return [field.name, JSON.stringify(picked.filter((entry) => field.choices.some((c) => c.value === entry)))];
      }
      return [field.name, typeof value === "string" || typeof value === "number" ? String(value) : ""];
    }),
  );
}

/** The answer object, or the name of the first field that is not valid yet. */
export function elicitationAnswer(
  fields: ElicitationField[],
  draft: Record<string, string>,
): { content: Record<string, unknown> } | { invalid: string } {
  // Field names come from the server; a name like "__proto__" must stay a
  // plain key instead of reaching the object's prototype.
  const content: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const text = (draft[field.name] ?? "").trim();
    if (field.kind === "boolean") {
      content[field.name] = draft[field.name] === "true";
      continue;
    }
    if (field.kind === "choices") {
      const picked = decodeChoices(draft[field.name]);
      if (field.required && picked.length === 0) return { invalid: field.name };
      if (field.minItems !== null && picked.length < field.minItems) return { invalid: field.name };
      if (field.maxItems !== null && picked.length > field.maxItems) return { invalid: field.name };
      content[field.name] = picked;
      continue;
    }
    if (!text) {
      if (field.required) return { invalid: field.name };
      continue;
    }
    if (field.kind === "string") {
      content[field.name] = draft[field.name];
      continue;
    }
    const number = Number(text);
    if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) {
      return { invalid: field.name };
    }
    content[field.name] = number;
  }
  return { content };
}

/** The picks a multi-select draft holds; anything unreadable counts as none. */
export function decodeChoices(draft: string | undefined): string[] {
  if (!draft) return [];
  try {
    const parsed = JSON.parse(draft);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

const inputType = (field: ElicitationField) =>
  field.kind !== "string"
    ? "number"
    : field.format === "email"
      ? "email"
      : field.format === "uri"
        ? "url"
        : field.format === "date"
          ? "date"
          : // A browser date-time input has no zone, which the protocol's
            // date-time requires; plain text lets the user write one.
            "text";

export function McpElicitation({
  request,
  onAnswer,
}: {
  request: ElicitationRequest;
  onAnswer: (allow: boolean, message?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => initialDraft(request.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = elicitationAnswer(request.fields, draft);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const decline = (
    <button
      type="button"
      className="button button--secondary button--sm"
      disabled={busy}
      onClick={() => void run(() => onAnswer(false))}
    >
      {t("chat.approval.deny")}
    </button>
  );

  if (request.mode === "url" && request.url) {
    const url = request.url;
    return (
      <div className="chat-elicitation">
        {request.message && <p>{request.message}</p>}
        <p className="chat-elicitation__url">
          <span>{t("chat.elicitation.urlHost", { host: new URL(url).host })}</span>
          <code title={url}>{url}</code>
        </p>
        {error && <p className="field__error">{error}</p>}
        <div className="chat-card__actions">
          <button
            type="button"
            className="button button--primary button--sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (hasDesktopBackend()) {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl(url);
                } else {
                  window.open(url, "_blank", "noopener,noreferrer");
                }
                await onAnswer(true);
              })
            }
          >
            {t("chat.elicitation.openUrl")}
          </button>
          {decline}
        </div>
      </div>
    );
  }

  return (
    <form
      className="chat-elicitation"
      onSubmit={(event) => {
        event.preventDefault();
        if ("content" in answer) void run(() => onAnswer(true, JSON.stringify(answer.content)));
      }}
    >
      {request.message && <p>{request.message}</p>}
      <p className="chat-elicitation__hint">{t("chat.elicitation.hint")}</p>
      {request.fields.map((field) => (
        <label className="field" key={field.name}>
          <span className="field__label">
            {field.title}
            {field.required && <span aria-hidden="true"> *</span>}
          </span>
          {field.kind === "boolean" ? (
            <input
              type="checkbox"
              checked={draft[field.name] === "true"}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: String(event.target.checked) }))
              }
            />
          ) : field.kind === "choices" ? (
            <span className="chat-elicitation__choices">
              {field.choices.map((choice) => {
                const picked = decodeChoices(draft[field.name]);
                return (
                  <label key={choice.value} className="checkbox">
                    <input
                      type="checkbox"
                      checked={picked.includes(choice.value)}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft((current) => {
                          const chosen = decodeChoices(current[field.name]).filter((entry) => entry !== choice.value);
                          if (event.target.checked) chosen.push(choice.value);
                          return { ...current, [field.name]: JSON.stringify(chosen) };
                        })
                      }
                    />
                    {choice.label}
                  </label>
                );
              })}
            </span>
          ) : field.choices.length > 0 ? (
            <select
              className="select"
              value={draft[field.name]}
              disabled={busy}
              required={field.required}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: event.target.value }))
              }
            >
              <option value="">{t("chat.elicitation.choose")}</option>
              {field.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type={inputType(field)}
              step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined}
              autoComplete="off"
              maxLength={field.kind === "string" ? 4096 : undefined}
              value={draft[field.name]}
              disabled={busy}
              required={field.required}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />
          )}
          {field.description && <small className="field__optional">{field.description}</small>}
        </label>
      ))}
      {error && <p className="field__error">{error}</p>}
      <div className="chat-card__actions">
        <button
          type="submit"
          className="button button--primary button--sm"
          disabled={busy || !("content" in answer)}
        >
          {t("chat.elicitation.submit")}
        </button>
        {decline}
      </div>
    </form>
  );
}
