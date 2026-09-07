/**
 * Key Vault view.
 *
 * Host trust and credential references are backed by the Rust core. The view
 * can verify and delete OS-store entries, but it never requests secret values.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useHostTrust } from "../app/useHostTrust";
import { copyTextToClipboard } from "../app/clipboardText";
import {
  useCredentialInventory,
  type CredentialInventoryEntry,
} from "../app/useSavedCredential";
import type { WorkspaceState } from "../app/useWorkspace";
import { connectionTarget, findProtocol } from "../domain/connection";
import {
  hostTargetKey,
  isValidFingerprint,
  isValidHost,
  type HostKeyRecord,
} from "../domain/security";
import { useI18n } from "../i18n/context";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
} from "../components/icons";
import { Chip } from "../components/common/Badge";
import { EncryptedVaultPanel } from "../components/vault/EncryptedVaultPanel";
import type { VaultApi } from "../app/useVault";
import { Callout, EmptyState } from "../components/common/Callout";
import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import { moveTabGroupFocus } from "../components/overlays/tabNavigation";
import { useModalFocus } from "../components/overlays/modalFocus";

const vaultTabs = ["hosts", "credentials", "encrypted"] as const;

const keyAlgorithms = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
] as const;

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function VaultView({
  workspace,
  vault,
}: {
  workspace: WorkspaceState;
  vault: VaultApi;
}) {
  const { t, tag } = useI18n();
  const trust = useHostTrust();
  const credentials = useCredentialInventory(workspace.profiles);
  const formId = useId();

  const [activeTab, setActiveTab] =
    useState<(typeof vaultTabs)[number]>("hosts");
  useEffect(() => {
    void credentials.refresh();
  }, [credentials.refresh, vault.backend, vault.status?.state]);
  const [hostSearch, setHostSearch] = useState("");
  const [showAddHostModal, setShowAddHostModal] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<HostKeyRecord | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const copyRequestRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pendingCredentialRemove, setPendingCredentialRemove] =
    useState<CredentialInventoryEntry | null>(null);
  const [removingCredential, setRemovingCredential] = useState(false);

  const [newHost, setNewHost] = useState("");
  const [newPort, setNewPort] = useState("22");
  const [newAlgorithm, setNewAlgorithm] = useState<(typeof keyAlgorithms)[number]>(
    "ssh-ed25519",
  );
  const [newFingerprint, setNewFingerprint] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const addHostDialogRef = useRef<HTMLDivElement>(null);
  const addHostInputRef = useRef<HTMLInputElement>(null);

  useModalFocus({
    dialogRef: addHostDialogRef,
    getInitialFocus: () => addHostInputRef.current,
    onEscape: closeAddHost,
    escapeDisabled: saving,
    active: showAddHostModal,
  });

  useEffect(() => {
    if (saving) addHostDialogRef.current?.focus();
  }, [saving]);

  useEffect(
    () => () => {
      copyRequestRef.current += 1;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const filteredHosts = useMemo(() => {
    const query = hostSearch.trim().toLocaleLowerCase();
    if (!query) return trust.knownHosts;

    return trust.knownHosts.filter((record) =>
      [
        hostTargetKey(record.host, record.port),
        record.algorithm,
        record.fingerprint,
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [hostSearch, trust.knownHosts]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(tag, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [tag],
  );

  function formatTrustedAt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return t("common.notSet");
    return dateFormatter.format(new Date(seconds * 1000));
  }

  function resetAddForm() {
    setNewHost("");
    setNewPort("22");
    setNewAlgorithm("ssh-ed25519");
    setNewFingerprint("");
    setFormError(null);
  }

  function closeAddHost() {
    if (saving) return;
    setShowAddHostModal(false);
    resetAddForm();
  }

  async function handleCopy(record: HostKeyRecord) {
    const target = hostTargetKey(record.host, record.port);
    const request = ++copyRequestRef.current;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopiedTarget(null);
    setCopyProblem(null);
    try {
      await copyTextToClipboard(record.fingerprint);
      if (request !== copyRequestRef.current) return;
      setCopiedTarget(target);
      copyTimerRef.current = window.setTimeout(() => {
        if (request === copyRequestRef.current) {
          setCopiedTarget(null);
          copyTimerRef.current = null;
        }
      }, 2_000);
    } catch (reason) {
      if (request !== copyRequestRef.current) return;
      setCopyProblem(
        t("common.copyFailed.body", { error: reasonText(reason) }),
      );
    }
  }

  async function handleAddHostSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setActionError(null);

    const host = newHost.trim();
    const port = Number.parseInt(newPort, 10);
    const fingerprint = newFingerprint.trim();
    const target = hostTargetKey(host, port);

    if (!host) {
      setFormError(t("vault.validation.hostRequired"));
      return;
    }
    if (!isValidHost(host)) {
      setFormError(t("vault.validation.hostInvalid"));
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setFormError(t("vault.validation.portInvalid"));
      return;
    }
    if (!isValidFingerprint(fingerprint)) {
      setFormError(t("vault.validation.fingerprintInvalid"));
      return;
    }
    if (
      trust.knownHosts.some(
        (record) => hostTargetKey(record.host, record.port) === target,
      )
    ) {
      setFormError(t("vault.validation.duplicate", { target }));
      return;
    }

    setSaving(true);
    try {
      const record = await trust.trustHost(
        host,
        port,
        newAlgorithm,
        fingerprint,
      );
      workspace.logActivity({
        type: "created",
        message: t("vault.activity.added", {
          target: hostTargetKey(record.host, record.port),
        }),
        detail: record.fingerprint,
      });
      setShowAddHostModal(false);
      resetAddForm();
    } catch (reason) {
      setActionError(
        t("vault.actionFailed.body", { error: reasonText(reason) }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveHost() {
    if (!pendingRemove || removing) return;

    setRemoving(true);
    setActionError(null);
    const record = pendingRemove;
    const target = hostTargetKey(record.host, record.port);

    try {
      const removed = await trust.forgetHost(record.host, record.port);
      if (removed) {
        workspace.logActivity({
          type: "deleted",
          message: t("vault.activity.removed", { target }),
          detail: record.fingerprint,
        });
      } else {
        trust.refresh();
      }
      setPendingRemove(null);
    } catch (reason) {
      setActionError(
        t("vault.actionFailed.body", { error: reasonText(reason) }),
      );
    } finally {
      setRemoving(false);
    }
  }

  async function handleRemoveCredential() {
    if (!pendingCredentialRemove || removingCredential) return;

    setRemovingCredential(true);
    setActionError(null);
    const entry = pendingCredentialRemove;
    const profile = workspace.profiles.find(
      (candidate) => candidate.id === entry.profileId,
    );

    try {
      await credentials.remove(entry);
      if (profile) {
        workspace.logActivity({
          type: "deleted",
          message: t("vault.credentials.activity.removed", {
            name: profile.name,
          }),
          detail: connectionTarget(profile),
        });
      }
      setPendingCredentialRemove(null);
    } catch (reason) {
      setActionError(
        t("credential.removeFailed.body", { detail: reasonText(reason) }),
      );
    } finally {
      setRemovingCredential(false);
    }
  }

  const pendingCredentialProfile = pendingCredentialRemove
    ? workspace.profiles.find(
        (profile) => profile.id === pendingCredentialRemove.profileId,
      )
    : null;

  const status =
    trust.mode === "ready"
      ? { tone: "ok" as const, label: t("vault.status.ready") }
      : trust.mode === "loading"
        ? { tone: "neutral" as const, label: t("vault.status.loading") }
        : trust.mode === "browser"
          ? { tone: "planned" as const, label: t("vault.status.browser") }
          : { tone: "danger" as const, label: t("vault.status.error") };

  return (
    <div className="stack vault">
      <section className="panel glass glass--sheen vault-status">
        <span className="vault-status__icon" aria-hidden="true">
          <ShieldIcon size={20} />
        </span>
        <div className="vault-status__body">
          <div className="vault-status__title">
            <h2 className="panel__title">{t("vault.title")}</h2>
            <Chip tone={status.tone}>{status.label}</Chip>
          </div>
          <p className="panel__hint">
            {trust.mode === "ready"
              ? t("vault.summary.ready", { count: trust.knownHosts.length })
              : trust.mode === "browser"
                ? t("vault.summary.browser")
                : trust.mode === "error"
                  ? t("vault.summary.error")
                  : t("vault.summary.loading")}
          </p>
        </div>
      </section>

      <div className="vault-toolbar">
        <div
          className="segmented"
          role="tablist"
          aria-label={t("vault.tabs.label")}
        >
          <button
            type="button"
            id={formId + "-hosts-tab"}
            className="segmented__btn"
            role="tab"
            aria-selected={activeTab === "hosts"}
            tabIndex={activeTab === "hosts" ? 0 : -1}
            onClick={() => setActiveTab("hosts")}
            onKeyDown={(event) =>
              moveTabGroupFocus(event, 0, (nextIndex) =>
                setActiveTab(vaultTabs[nextIndex]),
              )
            }
          >
            {t("vault.tabs.hosts", { count: trust.knownHosts.length })}
          </button>
          <button
            type="button"
            id={formId + "-credentials-tab"}
            className="segmented__btn"
            role="tab"
            aria-selected={activeTab === "credentials"}
            tabIndex={activeTab === "credentials" ? 0 : -1}
            onClick={() => setActiveTab("credentials")}
            onKeyDown={(event) =>
              moveTabGroupFocus(event, 1, (nextIndex) =>
                setActiveTab(vaultTabs[nextIndex]),
              )
            }
          >
            {t("vault.tabs.credentials", {
              count: credentials.state.entries.length,
            })}
            {credentials.state.mode === "ready" && (
              <Chip tone="ok">{t("common.available")}</Chip>
            )}
          </button>
          <button
            type="button"
            id={formId + "-encrypted-tab"}
            className="segmented__btn"
            role="tab"
            aria-selected={activeTab === "encrypted"}
            tabIndex={activeTab === "encrypted" ? 0 : -1}
            onClick={() => setActiveTab("encrypted")}
            onKeyDown={(event) =>
              moveTabGroupFocus(event, 2, (nextIndex) =>
                setActiveTab(vaultTabs[nextIndex]),
              )
            }
          >
            {t("vault.tabs.encrypted")}
            {vault.status?.state === "unlocked" && (
              <Chip tone="ok">{t("vault.encrypted.state.unlocked")}</Chip>
            )}
          </button>
        </div>

        {activeTab === "hosts" && trust.mode === "ready" && (
          <div className="vault-toolbar__actions">
            <input
              type="search"
              className="input input--sm"
              placeholder={t("vault.searchPlaceholder")}
              aria-label={t("vault.searchPlaceholder")}
              value={hostSearch}
              onChange={(event) => setHostSearch(event.target.value)}
            />
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => {
                setActionError(null);
                setShowAddHostModal(true);
              }}
            >
              <PlusIcon size={13} />
              {t("vault.add")}
            </button>
          </div>
        )}
      </div>

      <div
        className="vault-tabpanel"
        role="tabpanel"
        aria-labelledby={formId + `-${activeTab}-tab`}
      >
        {actionError && (
          <Callout tone="danger" title={t("vault.actionFailed.title")}>
            {actionError}
          </Callout>
        )}
        {copyProblem && (
          <Callout tone="danger" title={t("common.copyFailed.title")}>
            {copyProblem}
          </Callout>
        )}

        {activeTab === "hosts" && (
        <>
          {trust.mode === "loading" && (
            <div className="panel glass">
              <EmptyState
                icon={<RefreshIcon size={24} />}
                title={t("vault.loading.title")}
                description={t("vault.loading.body")}
              />
            </div>
          )}

          {trust.mode === "browser" && (
            <Callout tone="planned" title={t("vault.browser.title")}>
              {t("vault.browser.body")}
            </Callout>
          )}

          {trust.mode === "error" && (
            <Callout
              tone="danger"
              title={t("vault.loadError.title")}
              actions={
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={trust.refresh}
                >
                  <RefreshIcon size={13} />
                  {t("vault.retry")}
                </button>
              }
            >
              {t("vault.loadError.body", {
                error: trust.error ?? t("common.notSet"),
              })}
            </Callout>
          )}

          {trust.mode === "ready" && filteredHosts.length === 0 && (
            <div className="panel glass">
              <EmptyState
                icon={<ShieldIcon size={24} />}
                title={
                  hostSearch
                    ? t("vault.noResults.title")
                    : t("vault.empty.title")
                }
                description={
                  hostSearch
                    ? t("vault.noResults.body")
                    : t("vault.empty.body")
                }
                actions={
                  !hostSearch ? (
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => setShowAddHostModal(true)}
                    >
                      <PlusIcon size={14} />
                      {t("vault.add")}
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}

          {trust.mode === "ready" && filteredHosts.length > 0 && (
            <div className="vault-table-wrap glass">
              <table className="vault-table">
                <thead>
                  <tr>
                    <th>{t("vault.table.target")}</th>
                    <th>{t("vault.table.algorithm")}</th>
                    <th>{t("vault.table.fingerprint")}</th>
                    <th>{t("vault.table.trustedAt")}</th>
                    <th className="vault-table__actions">
                      {t("vault.table.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHosts.map((record) => {
                    const target = hostTargetKey(record.host, record.port);
                    const copied = copiedTarget === target;

                    return (
                      <tr key={target}>
                        <td data-label={t("vault.table.target")}>
                          <span className="mono vault-target">{target}</span>
                        </td>
                        <td data-label={t("vault.table.algorithm")}>
                          <Chip tone="neutral">{record.algorithm}</Chip>
                        </td>
                        <td data-label={t("vault.table.fingerprint")}>
                          <span className="mono vault-fingerprint">
                            {record.fingerprint}
                          </span>
                        </td>
                        <td data-label={t("vault.table.trustedAt")}>{formatTrustedAt(record.firstTrustedAt)}</td>
                        <td className="vault-table__actions">
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => void handleCopy(record)}
                            title={t("vault.copy")}
                            aria-label={t("vault.copyFor", { target })}
                          >
                            {copied ? (
                              <CheckIcon size={13} />
                            ) : (
                              <CopyIcon size={13} />
                            )}
                          </button>
                          <button
                            type="button"
                            className="icon-button icon-button--danger"
                            onClick={() => setPendingRemove(record)}
                            title={t("vault.remove")}
                            aria-label={t("vault.removeFor", { target })}
                          >
                            <TrashIcon size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
        )}

        {activeTab === "encrypted" && <EncryptedVaultPanel vault={vault} />}

        {activeTab === "credentials" && (
        <div className="stack">
          {credentials.state.mode === "loading" && (
            <div className="panel glass">
              <EmptyState
                icon={<RefreshIcon size={24} />}
                title={t("vault.credentials.loading.title")}
                description={t("vault.credentials.loading.body")}
              />
            </div>
          )}

          {credentials.state.mode === "unavailable" && (
            <Callout
              tone="warn"
              title={t("credential.unavailable.title")}
              actions={credentials.state.runtimeUnavailable ? undefined : (
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={() => void credentials.refresh()}
                >
                  <RefreshIcon size={13} />
                  {t("vault.retry")}
                </button>
              )}
            >
              {t(
                credentials.state.runtimeUnavailable
                  ? "credential.unavailable.browserBody"
                  : "credential.unavailable.body",
                { detail: credentials.state.detail },
              )}
            </Callout>
          )}

          {credentials.state.mode === "ready" && (
            <Callout
              tone="security"
              title={t("vault.credentials.ready.title", {
                provider: credentials.state.provider,
              })}
            >
              {t("vault.credentials.ready.body")}
            </Callout>
          )}

          {credentials.state.mode === "ready" &&
            credentials.state.entries.length === 0 && (
              <div className="panel glass">
                <EmptyState
                  icon={<ShieldIcon size={24} />}
                  title={t("vault.credentials.empty.title")}
                  description={t("vault.credentials.empty.body")}
                />
              </div>
            )}

          {credentials.state.mode === "ready" &&
            credentials.state.entries.length > 0 && (
              <div className="vault-table-wrap glass">
                <table className="vault-table">
                  <thead>
                    <tr>
                      <th>{t("vault.credentials.table.connection")}</th>
                      <th>{t("vault.credentials.table.protocol")}</th>
                      <th>{t("vault.credentials.table.target")}</th>
                      <th className="vault-table__actions">
                        {t("vault.table.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {credentials.state.entries.map((entry) => {
                      const profile = workspace.profiles.find(
                        (candidate) => candidate.id === entry.profileId,
                      );
                      if (!profile) return null;
                      return (
                        <tr key={entry.profileId + ":" + entry.kind}>
                          <td data-label={t("vault.credentials.table.connection")}>{profile.name}</td>
                          <td data-label={t("vault.credentials.table.protocol")}>
                            <Chip tone="neutral">
                              {findProtocol(profile.protocol).acronym}
                            </Chip>
                          </td>
                          <td data-label={t("vault.credentials.table.target")}>
                            <span className="mono vault-target">
                              {connectionTarget(profile)}
                            </span>
                          </td>
                          <td className="vault-table__actions">
                            <button
                              type="button"
                              className="icon-button icon-button--danger"
                              onClick={() => setPendingCredentialRemove(entry)}
                              title={t("credential.remove")}
                              aria-label={t(
                                "vault.credentials.removeFor",
                                { name: profile.name },
                              )}
                            >
                              <TrashIcon size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
        )}
      </div>

      {showAddHostModal && (
        <div
          className="scrim scrim--top"
          role="presentation"
          onMouseDown={closeAddHost}
        >
          <div
            ref={addHostDialogRef}
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={formId + "-title"}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog__head">
              <h2 className="dialog__title" id={formId + "-title"}>
                {t("vault.add.title")}
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={closeAddHost}
                aria-label={t("common.close")}
              >
                <CloseIcon size={14} />
              </button>
            </header>

            <form onSubmit={(event) => void handleAddHostSubmit(event)}>
              <div className="dialog__body stack">
                <Callout tone="security" title={t("vault.add.securityTitle")}>
                  {t("vault.add.securityBody")}
                </Callout>

                {formError && (
                  <Callout tone="danger" title={t("vault.validation.title")}>
                    {formError}
                  </Callout>
                )}

                <div className="vault-host-fields">
                  <div>
                    <label htmlFor={formId + "-host"} className="label">
                      {t("vault.form.host")}
                    </label>
                    <input
                      ref={addHostInputRef}
                      id={formId + "-host"}
                      type="text"
                      className="input"
                      placeholder={t("vault.form.hostPlaceholder")}
                      value={newHost}
                      onChange={(event) => setNewHost(event.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <label htmlFor={formId + "-port"} className="label">
                      {t("vault.form.port")}
                    </label>
                    <input
                      id={formId + "-port"}
                      type="number"
                      className="input"
                      min={1}
                      max={65535}
                      value={newPort}
                      onChange={(event) => setNewPort(event.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor={formId + "-algorithm"} className="label">
                    {t("vault.form.algorithm")}
                  </label>
                  <select
                    id={formId + "-algorithm"}
                    className="select"
                    value={newAlgorithm}
                    onChange={(event) =>
                      setNewAlgorithm(
                        event.target.value as (typeof keyAlgorithms)[number],
                      )
                    }
                  >
                    {keyAlgorithms.map((algorithm, index) => (
                      <option value={algorithm} key={algorithm}>
                        {algorithm}
                        {index === 0
                          ? " (" + t("vault.form.recommended") + ")"
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor={formId + "-fingerprint"} className="label">
                    {t("vault.form.fingerprint")}
                  </label>
                  <input
                    id={formId + "-fingerprint"}
                    type="text"
                    className="input mono"
                    placeholder="SHA256:..."
                    value={newFingerprint}
                    onChange={(event) => setNewFingerprint(event.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <span className="field__hint">
                    {t("vault.form.fingerprintHint")}
                  </span>
                </div>
              </div>

              <div className="dialog__foot">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={closeAddHost}
                  disabled={saving}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={saving}
                >
                  {saving ? t("vault.saving") : t("vault.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingCredentialRemove && pendingCredentialProfile && (
        <ConfirmDialog
          title={t("vault.credentials.remove.title", {
            name: pendingCredentialProfile.name,
          })}
          body={t("vault.credentials.remove.body", {
            target: connectionTarget(pendingCredentialProfile),
          })}
          confirmLabel={
            removingCredential
              ? t("credential.removing")
              : t("credential.remove")
          }
          cancelLabel={t("common.cancel")}
          busy={removingCredential}
          onConfirm={() => void handleRemoveCredential()}
          onCancel={() => {
            if (!removingCredential) setPendingCredentialRemove(null);
          }}
        />
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t("vault.remove.title", {
            target: hostTargetKey(pendingRemove.host, pendingRemove.port),
          })}
          body={t("vault.remove.body")}
          confirmLabel={
            removing ? t("vault.removing") : t("vault.remove.confirm")
          }
          cancelLabel={t("common.cancel")}
          busy={removing}
          onConfirm={() => void handleRemoveHost()}
          onCancel={() => {
            if (!removing) setPendingRemove(null);
          }}
        />
      )}
    </div>
  );
}
