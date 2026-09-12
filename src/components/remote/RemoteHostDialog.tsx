import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { loadRemoteHostSettings } from "../../app/remoteHostSettings";
import { normalizePairingPassword } from "../../app/pairingToken";
import type { SensitiveClipboardClearChoice } from "../../app/preferences";
import { copyTextToClipboard } from "../../app/clipboardText";
import {
  formatDeviceId,
  loadRelayAddress,
  saveRelayAddress,
} from "../../app/remoteRelay";
import { copySensitiveText } from "../../app/sensitiveClipboard";
import type { RemoteHostApi } from "../../app/useRemoteHost";
import { displayPath } from "../../app/displayPath";
import { useI18n } from "../../i18n/context";
import { Callout } from "../common/Callout";
import { CloseIcon, CopyIcon, ScreenShareIcon, ShieldIcon } from "../icons";
import { RelayAddressField } from "./RelayAddressField";
import { moveRadioGroupFocus } from "../overlays/radioNavigation";
import { useModalFocus } from "../overlays/modalFocus";

export function RemoteHostDialog({
  host,
  platform,
  sensitiveClipboardClear,
  onClose,
}: {
  host: RemoteHostApi;
  platform?: string;
  sensitiveClipboardClear: SensitiveClipboardClearChoice;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [settings] = useState(() => host.configuration ?? loadRemoteHostSettings(window.localStorage));
  const [editing, setEditing] = useState(false);
  const [savedRelay] = useState(() => loadRelayAddress(window.localStorage));
  const [mode, setMode] = useState<"relay" | "direct">(
    settings.mode,
  );
  const [relayAddress, setRelayAddress] = useState(settings.relayAddress || savedRelay);
  const [fixedCode, setFixedCode] = useState("");
  const [bindAddress, setBindAddress] = useState(settings.bindAddress);
  const [port, setPort] = useState(settings.port);
  const [fps, setFps] = useState(settings.fps);
  const [allowInput, setAllowInput] = useState(settings.allowInput === true);
  const [allowChat, setAllowChat] = useState(settings.allowChat === true);
  const [allowCommands, setAllowCommands] = useState(settings.allowCommands === true);
  const [allowFiles, setAllowFiles] = useState(settings.allowFiles === true);
  const [fileRoot, setFileRoot] = useState(settings.fileRoot);
  const [submitting, setBusy] = useState(false);
  const busy = submitting || host.configuring === true;
  const [problem, setProblem] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<"address" | "code" | "deviceId" | null>(
    null,
  );
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  const dialogRef = useRef<HTMLDivElement>(null);
  const formId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const copyRequestRef = useRef(0);

  useModalFocus({
    dialogRef,
    getInitialFocus: () => closeRef.current,
    onEscape: onClose,
    escapeDisabled: busy,
  });

  useEffect(() => {
    if (!host.status) return;
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1_000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [host.status]);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  // The relay identity file holds a registration token and a Noise private
  // key. It is created on first read, so ask for it only once the user has
  // actually chosen relay sharing.
  const ensureDeviceId = host.ensureDeviceId;
  useEffect(() => {
    if (mode !== "relay") return;
    void ensureDeviceId();
  }, [ensureDeviceId, mode]);

  useEffect(
    () => () => {
      copyRequestRef.current += 1;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const secondsRemaining = Math.max(
    0,
    (host.status?.expiresAt ?? now) - now,
  );
  const expiry = useMemo(() => {
    const minutes = Math.floor(secondsRemaining / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (secondsRemaining % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }, [secondsRemaining]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = mode === "relay" && fixedCode ? normalizePairingPassword(fixedCode) : "";
    if (password === null) {
      setProblem(t("remote.connect.codeInvalid"));
      return;
    }
    setBusy(true);
    setProblem(null);
    host.clearClosedReason();
    try {
      await host.start({
        bindAddress: bindAddress.trim(),
        port,
        fps,
        allowInput,
        allowChat,
        allowCommands: platform === "windows" && allowCommands,
        allowFiles,
        fileRoot: fileRoot.trim(),
        mode,
        relayAddress: mode === "relay" ? relayAddress.trim() : "",
        pairingCode: password,
      });
      if (mode === "relay") {
        saveRelayAddress(window.localStorage, relayAddress);
      }
      setFixedCode("");
      setEditing(false);
      setNow(Math.floor(Date.now() / 1_000));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy(kind: "address" | "code" | "deviceId", value: string) {
    const request = ++copyRequestRef.current;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopied(null);
    setCopyProblem(null);
    try {
      if (kind === "code") {
        await copySensitiveText(value, sensitiveClipboardClear);
      } else {
        await copyTextToClipboard(value);
      }
      if (request !== copyRequestRef.current) return;
      setCopied(kind);
      copyTimerRef.current = window.setTimeout(() => {
        if (request === copyRequestRef.current) {
          setCopied(null);
          copyTimerRef.current = null;
        }
      }, 1_500);
    } catch (error) {
      if (request !== copyRequestRef.current) return;
      setCopyProblem(
        t("common.copyFailed.body", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const statusLabel = host.status
    ? t(`remote.host.state.${host.status.state}`)
    : null;

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--wide remote-host-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <ScreenShareIcon size={18} />
          </span>
          <h2 className="dialog__title" id="remote-host-title">
            {t("remote.host.title")}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-button icon-button--sm"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
            style={{ marginLeft: "auto" }}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <div className="dialog__stack">
          <Callout tone="security" title={t("remote.host.securityTitle")}>
            {t("remote.host.securityBody")}
          </Callout>

          {(problem || host.closedReason) && (
            <Callout tone="warn" title={t("remote.host.problemTitle")}>
              {problem ?? host.closedReason}
            </Callout>
          )}
          {copyProblem && (
            <Callout tone="warn" title={t("common.copyFailed.title")}>
              {copyProblem}
            </Callout>
          )}

          <p className="panel__hint" role="status">{t("remote.host.autoStandby")}</p>
          {host.status && !editing ? (
            <div className="remote-host-active">
              <div className="remote-host-state">
                <span
                  className={`remote-host-state__dot state-${host.status.state}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{statusLabel}</strong>
                  <small>
                    {host.status.peer
                      ? t("remote.host.peer", { peer: host.status.peer })
                      : t("remote.host.waiting")}
                  </small>
                </div>
                <span
                  className={host.status.viewOnly ? "badge tone-info" : "badge tone-warn"}
                  style={{ marginLeft: "auto" }}
                >
                  {host.status.viewOnly
                    ? t("remote.host.modeViewOnly")
                    : t("remote.host.modeInteractive")}
                </span>
                {host.status.commands && <span className="badge tone-warn">{t("remote.commands.title")}</span>}
                {host.status.fileTransfer && (
                  <span className="badge tone-security">
                    {t("remote.host.modeFiles")}
                  </span>
                )}
              </div>

              <div className="remote-host-share-grid">
                {host.status.deviceId ? (
                  <div className="remote-host-value remote-host-value--device">
                    <span>{t("remote.host.deviceId")}</span>
                    <code>{formatDeviceId(host.status.deviceId)}</code>
                    <button
                      type="button"
                      className="icon-button icon-button--sm"
                      onClick={() =>
                        void copy("deviceId", host.status!.deviceId ?? "")
                      }
                      aria-label={t("remote.host.copyDeviceId")}
                    >
                      <CopyIcon size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="remote-host-value">
                    <span>{t("remote.host.address")}</span>
                    <code>{host.status.address}</code>
                    <button
                      type="button"
                      className="icon-button icon-button--sm"
                      onClick={() => void copy("address", host.status!.address)}
                      aria-label={t("remote.host.copyAddress")}
                    >
                      <CopyIcon size={13} />
                    </button>
                  </div>
                )}
                {host.status.pairingCode && (
                  <div className="remote-host-value remote-host-value--code">
                    <span>{t("remote.host.code")}</span>
                    <code>{host.status.pairingCode}</code>
                    <button
                      type="button"
                      className="icon-button icon-button--sm"
                      onClick={() =>
                        void copy("code", host.status!.pairingCode)
                      }
                      aria-label={t("remote.host.copyCode")}
                    >
                      <CopyIcon size={13} />
                    </button>
                  </div>
                )}
                {host.status.fileTransfer && host.status.fileRoot && (
                  <div className="remote-host-value">
                    <span>{t("remote.host.fileRoot")}</span>
                    <code>{displayPath(host.status.fileRoot)}</code>
                  </div>
                )}
              </div>

              {host.status.state !== "streaming" && (
                <div className="remote-host-expiry">
                  <ShieldIcon size={14} />
                  <span>
                    {host.status.expiresAt === 0
                      ? t("remote.host.codePersistent")
                      : t("remote.host.expires", { time: expiry })}
                  </span>
                  <span>
                    {t("remote.host.attempts", {
                      count: host.status.attemptsRemaining,
                    })}
                  </span>
                </div>
              )}

              {copied && (
                <p className="text-muted" aria-live="polite">
                  {copied === "code" && sensitiveClipboardClear !== "off"
                    ? t("remote.host.copiedAutoClear", {
                        seconds: sensitiveClipboardClear,
                      })
                    : t("remote.host.copied")}
                </p>
              )}
            </div>
          ) : (
            <form id={formId} onSubmit={submit}>
              {mode === "relay" &&
                (host.deviceId ? (
                  <div className="remote-host-identity">
                    <div className="remote-host-value remote-host-value--device">
                      <span>{t("remote.host.permanentDeviceId")}</span>
                      <code>{formatDeviceId(host.deviceId)}</code>
                      <button
                        type="button"
                        className="icon-button icon-button--sm"
                        onClick={() => void copy("deviceId", host.deviceId ?? "")}
                        aria-label={t("remote.host.copyDeviceId")}
                      >
                        <CopyIcon size={13} />
                      </button>
                    </div>
                    <small>{t("remote.host.permanentDeviceIdHint")}</small>
                  </div>
                ) : host.deviceIdError ? (
                  <Callout
                    tone="warn"
                    title={t("remote.host.deviceIdUnavailable")}
                  >
                    {host.deviceIdError}
                  </Callout>
                ) : (
                  <div className="remote-host-identity remote-host-identity--loading">
                    {t("remote.host.deviceIdLoading")}
                  </div>
                ))}

              <div
                className="remote-host-mode"
                role="radiogroup"
                aria-label={t("remote.host.mode")}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "relay"}
                  tabIndex={mode === "relay" ? 0 : -1}
                  className={`remote-host-mode__option${
                    mode === "relay" ? " is-active" : ""
                  }`}
                  disabled={busy}
                  onClick={() => setMode("relay")}
                  onKeyDown={(event) =>
                    moveRadioGroupFocus(event, 0, (nextIndex) =>
                      setMode(nextIndex === 0 ? "relay" : "direct"),
                    )
                  }
                >
                  <strong>{t("remote.host.modeRelay")}</strong>
                  <small>{t("remote.host.modeRelayHint")}</small>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "direct"}
                  tabIndex={mode === "direct" ? 0 : -1}
                  className={`remote-host-mode__option${
                    mode === "direct" ? " is-active" : ""
                  }`}
                  disabled={busy}
                  onClick={() => setMode("direct")}
                  onKeyDown={(event) =>
                    moveRadioGroupFocus(event, 1, (nextIndex) =>
                      setMode(nextIndex === 0 ? "relay" : "direct"),
                    )
                  }
                >
                  <strong>{t("remote.host.modeDirect")}</strong>
                  <small>{t("remote.host.modeDirectHint")}</small>
                </button>
              </div>

              {mode === "relay" && (
                <>
                  <RelayAddressField
                    id="remote-host-relay"
                    value={relayAddress}
                    hasSaved={!!savedRelay}
                    busy={busy}
                    required
                    hint={t("remote.host.relayHint")}
                    onChange={setRelayAddress}
                  />
                  <div className="field">
                    <label
                      className="field__label"
                      htmlFor="remote-host-fixed-code"
                    >
                      {t("remote.host.fixedCode")}
                    </label>
                    <input
                      id="remote-host-fixed-code"
                      className="input mono"
                      value={fixedCode}
                      disabled={busy}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={64}
                      placeholder={t("remote.host.fixedCodePlaceholder")}
                      onChange={(event) => setFixedCode(event.currentTarget.value)}
                    />
                    <small className="field__optional">
                      {t("remote.host.fixedCodeHint")}
                    </small>
                  </div>
                </>
              )}

              {mode === "direct" && (
                <div className="field-grid field-grid--even">
                  <div className="field">
                    <label className="field__label" htmlFor="remote-host-address">
                      {t("remote.host.bindAddress")}
                    </label>
                    <input
                      id="remote-host-address"
                      className="input mono"
                      value={bindAddress}
                      disabled={busy}
                      onChange={(event) => setBindAddress(event.currentTarget.value)}
                    />
                    <small className="field__optional">
                      {t("remote.host.bindHint")}
                    </small>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="remote-host-port">
                      {t("remote.host.port")}
                    </label>
                    <input
                      id="remote-host-port"
                      className="input mono"
                      type="number"
                      min={1}
                      max={65_535}
                      value={port}
                      disabled={busy}
                      onChange={(event) => setPort(Number(event.currentTarget.value))}
                    />
                  </div>
                </div>
              )}

              <div className="field">
                <label className="field__label" htmlFor="remote-host-fps">
                  {t("remote.host.frameRate", { fps })}
                </label>
                <input
                  id="remote-host-fps"
                  type="range"
                  min={1}
                  max={10}
                  value={fps}
                  disabled={busy}
                  onChange={(event) => setFps(Number(event.currentTarget.value))}
                />
              </div>

              <label className="remote-host-toggle">
                <input
                  type="checkbox"
                  checked={allowInput}
                  disabled={busy}
                  onChange={(event) => setAllowInput(event.currentTarget.checked)}
                />
                <span>
                  <strong>{t("remote.host.allowInput")}</strong>
                  <small>{t("remote.host.allowInputHint")}</small>
                </span>
              </label>

              <label className="checkbox-field"><input type="checkbox" checked={allowChat} onChange={e => setAllowChat(e.currentTarget.checked)} />{t("remote.chat.allow")}</label>
              <p className="muted">{t("remote.chat.shareHint")}</p>
              {platform === "windows" && <label className="remote-host-toggle">
                <input type="checkbox" checked={allowCommands} disabled={busy} onChange={e => setAllowCommands(e.currentTarget.checked)} />
                <span><strong>{t("remote.commands.allow")}</strong><small>{t("remote.commands.allowHint")}</small></span>
              </label>}
              {allowInput && (
                <Callout tone="warn" title={t("remote.host.allowInputWarnTitle")}>
                  {t("remote.host.allowInputWarnBody")}
                </Callout>
              )}

              <label className="remote-host-toggle">
                <input
                  type="checkbox"
                  checked={allowFiles}
                  disabled={busy}
                  onChange={(event) => setAllowFiles(event.currentTarget.checked)}
                />
                <span>
                  <strong>{t("remote.host.allowFiles")}</strong>
                  <small>{t("remote.host.allowFilesHint")}</small>
                </span>
              </label>

              {allowFiles && (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="remote-host-file-root">
                      {t("remote.host.fileRoot")}
                    </label>
                    <input
                      id="remote-host-file-root"
                      className="input mono"
                      value={fileRoot}
                      disabled={busy}
                      placeholder={t("remote.host.fileRootPlaceholder")}
                      onChange={(event) => setFileRoot(event.currentTarget.value)}
                    />
                    <small className="field__optional">
                      {t("remote.host.fileRootHint")}
                    </small>
                  </div>
                  <Callout tone="warn" title={t("remote.host.allowFilesWarnTitle")}>
                    {t("remote.host.allowFilesWarnBody")}
                  </Callout>
                </>
              )}
            </form>
          )}
        </div>

        <footer className="dialog__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.close")}
          </button>
          {host.status && !editing ? (
            <button type="button" className="button button--primary" disabled={busy} onClick={() => setEditing(true)}>{t("remote.host.editSettings")}</button>
          ) : (
            <button type="submit" form={formId} className="button button--primary" disabled={busy}>{busy ? t("remote.host.applying") : t("remote.host.saveSettings")}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
