import { ChatWebSources } from "./ChatWebSources";
import { webSources } from "../../app/chatWebSources";
import { diffLineKind } from "../../app/gitChanges";
import { useState } from "react";
import { useI18n } from "../../i18n/context";
import { looksLikeDiff } from "../../app/agentChat";
import { readableToolOutput, type ToolPresentation } from "../../app/toolPresentation";
import { ChatImageStrip } from "./ChatImagePreviews";

/** One presentation for app-server events and paired native transcript calls. */
export function ReadableToolCard({ tool, forceOpen = false, directory = "", threadId }: {
  tool: ToolPresentation; forceOpen?: boolean; directory?: string; threadId?: string;
}) {
  const { t } = useI18n();
  const [rawOpen, setRawOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const output = tool.output === null ? null : tool.raw.map(raw => raw.output === null ? "" : readableToolOutput(raw.output)).filter(Boolean).join("\n\n");
  const preview = output?.split("\n").slice(0, 3).join("\n").slice(0, 600) ?? "";
  const rawDiff = looksLikeDiff(tool.input) || /apply_patch/i.test(tool.name);
  const protectedOutput = tool.isError || looksLikeDiff(output) || /<image\b|data:image\//.test(output ?? "");
  const outputExpanded = forceOpen || outputOpen || protectedOutput || !tool.done;
  if (!tool.commands.length) return <>
    <details className={`chat-card chat-card--tool${tool.isError ? " is-error" : ""}${!tool.done ? " is-running" : ""}`} open={forceOpen || rawOpen || protectedOutput || rawDiff || !tool.done}
      onToggle={event => { if (event.target === event.currentTarget) setRawOpen(event.currentTarget.open); }}>
      <summary className="chat-card__head"><span className="chat-card__label">{tool.name}</span><span className="chat-card__summary">{tool.input.split("\n")[0]?.slice(0, 160)}</span>
        {(!tool.done || tool.isError) && <span className="chat-card__state">{t(tool.isError ? "chat.tool.failed" : "chat.tool.running")}</span>}
      </summary>
      {(forceOpen || rawOpen || protectedOutput || rawDiff || !tool.done) && <div className="chat-card__body">{tool.raw.map((raw, index) => <div key={index}>
        <pre className="chat-card__output">{raw.input}</pre>{raw.output !== null && <pre className="chat-card__output">{raw.output}</pre>}</div>)}</div>}
    </details>
    {!!tool.images?.length && <ChatImageStrip paths={tool.images} workingDirectory={directory} threadId={threadId} captions={false} />}
    {tool.done && !tool.isError && <ChatWebSources sources={webSources(tool.name, tool.output)} />}
  </>;
  return <section className={`chat-card chat-card--tool chat-readable-tool${tool.isError ? " is-error" : ""}${!tool.done ? " is-running" : ""}`}>
    <header className="chat-card__head">
      {tool.commands.length ? <><span>{t(tool.isError ? "chat.tool.failed" : tool.done ? "chat.tool.executed" : "chat.tool.running")}</span>
        <code className="chat-readable-tool__command">{tool.commands.map(command => command.command).join(" · ")}</code></>
        : <><span className="chat-card__label">{tool.name}</span><code className="chat-card__summary">{tool.input.split("\n")[0]?.slice(0, 160)}</code></>}
      {tool.meta?.exitCode !== undefined && <span className="chat-chip">{t("chat.tool.exitCode", { code: tool.meta.exitCode })}</span>}
      {tool.meta?.durationMs !== undefined && <span className="chat-chip">{t("chat.turn.duration", { seconds: (tool.meta.durationMs / 1000).toFixed(1) })}</span>}
    </header>
    {output !== null && <div className="chat-readable-tool__result">
      {outputExpanded ? <pre className={`chat-card__output${looksLikeDiff(output) ? " chat-card__output--diff" : ""}`}>{looksLikeDiff(output) ? output?.split("\n").map((line, index) => <span key={index} className={`chat-diff__line is-${diffLineKind(line)}`}>{line}{"\n"}</span>) : output}</pre>
        : preview && <pre className="chat-card__output chat-readable-tool__preview">{preview}</pre>}
      {output.length > preview.length && !protectedOutput && tool.done && <button type="button" className="button button--ghost button--sm"
        aria-expanded={outputExpanded} onClick={() => setOutputOpen(current => !current)}>{t(outputExpanded ? "chat.tool.hideOutput" : "chat.tool.showOutput")}</button>}
    </div>}
    <details open={forceOpen || rawOpen || rawDiff} onToggle={event => { if (event.target === event.currentTarget) setRawOpen(event.currentTarget.open); }} className="chat-tool-raw">
      <summary>{t("chat.tool.rawDetails")}</summary>
      {(forceOpen || rawOpen || rawDiff) && <>
      {tool.commands.map((command, index) => command.directory && <p key={index}>{t("chat.tool.directory")}: <code>{command.directory}</code></p>)}
      {tool.raw.map((raw, index) => <div key={index}><strong>{raw.name}</strong><pre className="chat-card__output">{raw.input}</pre>
        {raw.output !== null && <pre className="chat-card__output">{raw.output}</pre>}</div>)}
      </>}
    </details>
    {!!tool.images?.length && <ChatImageStrip paths={tool.images} workingDirectory={directory} threadId={threadId} captions={false} />}
    {tool.done && !tool.isError && <ChatWebSources sources={webSources(tool.name, tool.output)} />}
  </section>;
}
