import type { WebSource } from "../../app/chatWebSources";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";

/** Opens a source in the default browser, never inside the app's WebView. */
async function openSource(url: string) {
  if (hasDesktopBackend()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function ChatWebSources({ sources }: { sources: WebSource[] }) {
  const { t } = useI18n();
  if (sources.length === 0) return null;
  return (
    <div className="chat-sources">
      <span className="chat-sources__label">
        {t("chat.sources", { count: sources.length })}
      </span>
      <ul className="chat-sources__list">
        {sources.map((source) => (
          <li key={source.url}>
            <a
              href={source.url}
              title={source.url}
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void openSource(source.url).catch(() => {});
              }}
            >
              {source.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
