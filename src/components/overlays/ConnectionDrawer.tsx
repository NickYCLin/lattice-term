/**
 * Add and edit connection drawer.
 *
 * Keeps the primary task compact: choose a protocol, enter its actual target
 * fields, then save or save-and-connect. Organisation metadata is optional and
 * stays collapsed until requested. Secrets use the secure credential backend,
 * never the exported connection profile.
 */

import { useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { canConnectProtocol } from "../../app/platformCapabilities";
import {
  connectionTarget,
  createConnectionProfile,
  draftFromProfile,
  emptyDraft,
  environmentCatalog,
  environmentHintKey,
  environmentLabelKey,
  findDuplicateTarget,
  findProtocol,
  isRelayProfile,
  limits,
  parseTags,
  protocolCatalog,
  protocolLabelKey,
  protocolSummaryKey,
  protocolUsesUsername,
  validateConnectionDraft,
  type ConnectionDraft,
  type ConnectionProfile,
  type Environment,
  type Protocol,
  type ValidationErrors,
} from "../../domain/connection";
import { formatDeviceId } from "../../app/remoteRelay";
import { useI18n, type MessageKey } from "../../i18n/context";
import { ProtocolTile } from "../common/Badge";
import { Callout } from "../common/Callout";
import { AlertIcon, CheckIcon, CloseIcon } from "../icons";
import { clearValidationError } from "./connectionValidation";
import { moveRadioGroupFocus } from "./radioNavigation";
import { useModalFocus } from "./modalFocus";
import { useConnectionCredentialDraft } from "../../app/useConnectionCredentialDraft";
import { newRouteDraft } from "../../app/connectionRoutes";
import {
  sameCredentialTarget,
  supportsCredentialRecord,
  type ConnectionCredentialDraft,
} from "../../app/connectionCredentialRecord";

function sameDraft(a: ConnectionDraft, b: ConnectionDraft): boolean {
  return (
    a.name === b.name &&
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.username === b.username &&
    a.port === b.port &&
    (a.environment ?? "unassigned") === (b.environment ?? "unassigned") &&
    (a.group ?? "") === (b.group ?? "") &&
    (a.favorite ?? false) === (b.favorite ?? false) &&
    (a.tags ?? []).join(",") === (b.tags ?? []).join(",") &&
    (a.deviceId ?? "") === (b.deviceId ?? "") &&
    (a.relayAddress ?? "") === (b.relayAddress ?? "")
  );
}

function protocolDraft(draft: ConnectionDraft): ConnectionDraft {
  return protocolUsesUsername(draft.protocol)
    ? draft
    : { ...draft, username: "" };
}

const hostnamePlaceholderKeys: Record<Protocol, MessageKey> = {
  ssh: "form.hostnamePlaceholder.ssh",
  sftp: "form.hostnamePlaceholder.sftp",
  rdp: "form.hostnamePlaceholder.rdp",
  vnc: "form.hostnamePlaceholder.vnc",
  lattice: "form.hostnamePlaceholder.lattice",
};

export function ConnectionDrawer({
  profile,
  routeSource = null,
  onOpenRoute,
  onAddRoute,
  profiles,
  supportedProtocols,
  mobile,
  onSave,
  onClose,
}: {
  /** `null` opens an empty draft; a profile opens it for editing. */
  profile: ConnectionProfile | null;
  routeSource?: ConnectionProfile | null;
  onOpenRoute?: (id: string) => void;
  onAddRoute?: (id: string) => void;
  profiles: ConnectionProfile[];
  /** Native session engines registered by this package. */
  supportedProtocols: readonly string[];
  /** Mobile packages show only usable protocols when creating a profile. */
  mobile: boolean;
  onSave: (
    draft: ConnectionDraft,
    connectAfterSave: boolean,
    id: string,
    credential?: ConnectionCredentialDraft,
  ) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const initial = useMemo(
    () => (profile ? draftFromProfile(profile) : routeSource ? newRouteDraft(routeSource, profiles) : emptyDraft()),
    [profile, routeSource, profiles],
  );

  const [draft, setDraft] = useState<ConnectionDraft>(initial);
  const [tagInput, setTagInput] = useState((initial.tags ?? []).join(", "));
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const navigation = useRef<(() => void) | null>(null);
  const [recordId] = useState(() => profile?.id ?? createConnectionProfile(emptyDraft()).id);
  const credential = useConnectionCredentialDraft(profile);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      (initial.environment ?? "unassigned") !== "unassigned" ||
      Boolean(initial.group) ||
      (initial.tags?.length ?? 0) > 0 ||
      Boolean(initial.favorite),
  );

  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const dirty =
    credential.dirty || !sameDraft(draft, initial) ||
    parseTags(tagInput).join(",") !== (initial.tags ?? []).join(",");
  const protocolOptions = useMemo(
    () =>
      mobile
        ? protocolCatalog.filter(
            (entry) =>
              canConnectProtocol(entry.id, supportedProtocols) ||
              entry.id === profile?.protocol,
          )
        : protocolCatalog,
    [mobile, profile?.protocol, supportedProtocols],
  );
  const connectSupported = canConnectProtocol(
    draft.protocol,
    supportedProtocols,
  );
  // A device remembered from "connect by ID" is addressed by identity, so the
  // address and port fields below have nothing to edit.
  const relayEntry = isRelayProfile(draft);

  function requestClose() {
    navigation.current = null;
    if (savingRef.current) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function navigate(action: () => void) {
    if (savingRef.current) return;
    if (dirty) { navigation.current = action; setConfirmDiscard(true); }
    else action();
  }

  useModalFocus({
    dialogRef: panelRef,
    getInitialFocus: () => nameRef.current,
    onEscape: requestClose,
  });

  function patch(
    next: Partial<ConnectionDraft>,
    changedField?: keyof ValidationErrors,
  ) {
    if (["hostname", "username", "port", "deviceId", "relayAddress"].some(field => Object.prototype.hasOwnProperty.call(next, field))) {
      credential.setAllowMcpRead(false);
    }
    setDraft((current) => ({ ...current, ...next }));
    if (changedField) {
      setErrors((current) => clearValidationError(current, changedField));
    }
  }

  function selectProtocol(protocol: Protocol) {
    if (protocol === draft.protocol) return;
    credential.setSecret("");
    credential.setAllowMcpRead(false);
    setShowSecret(false);
    const previousDefault = findProtocol(draft.protocol).defaultPort;
    const nextDefault = findProtocol(protocol).defaultPort;
    // Keep a port the user chose deliberately; move the untouched default.
    patch({
      protocol,
      port: draft.port === previousDefault ? nextDefault : draft.port,
      ...(!protocolUsesUsername(protocol) ? { username: "" } : {}),
    });
  }

  const candidate = useMemo(
    () =>
      createConnectionProfile(
        protocolDraft({ ...draft, tags: parseTags(tagInput) }),
        recordId,
      ),
    [draft, tagInput, recordId],
  );

  const duplicate = useMemo(
    () => findDuplicateTarget(profiles, candidate),
    [profiles, candidate],
  );
  const savedCredentialTarget = sameCredentialTarget(profile, candidate);

  /** Validates and opens optional fields when one of them needs attention. */
  function validateNow(): ValidationErrors {
    const next = protocolDraft({ ...draft, tags: parseTags(tagInput) });
    const found = validateConnectionDraft(next);
    setErrors(found);

    const firstField = Object.keys(found)[0];
    if (firstField) {
      const focus = () =>
        panelRef.current
          ?.querySelector<HTMLElement>(`[data-field="${firstField}"]`)
          ?.focus();
      if (firstField === "group" || firstField === "tags") {
        setAdvancedOpen(true);
        window.setTimeout(focus, 0);
      } else {
        focus();
      }
    }

    return found;
  }

  async function save(connectAfterSave: boolean) {
    if (savingRef.current || credential.loading) return;
    if (Object.keys(validateNow()).length > 0) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(
        protocolDraft({ ...draft, tags: parseTags(tagInput) }),
        connectAfterSave,
        recordId,
        supportsCredentialRecord(candidate) ? credential.credential : undefined,
      );
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(false);
  }

  async function toggleSecret() {
    if (!showSecret && credential.saved && savedCredentialTarget && !credential.secret) {
      await credential.reveal();
    }
    setShowSecret(current => !current);
  }

  const title = profile ? t("form.editTitle") : t("form.addTitle");
  const error = (field: keyof ValidationErrors) => {
    const issue = errors[field];
    return issue ? t(issue.key, issue.values) : undefined;
  };

  return (
    <div className="scrim" role="presentation" onMouseDown={requestClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer__head">
          <div>
            <p className="eyebrow">
              {profile ? t("form.editEyebrow") : t("form.addEyebrow")}
            </p>
            <h2 className="drawer__title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={requestClose}
            aria-label={t("common.close")}
          >
            <CloseIcon />
          </button>
        </header>

        <form className="drawer__body" id={formId} onSubmit={submit} noValidate inert={saving}>
          {(profile || routeSource) && <section className="form-section">
            <h3 className="form-section__title">{t("form.route.title")}</h3>
            <p>{t("form.route.hint")}</p>
            <div className="connection-drawer__routes">
              {profiles.filter(entry => entry.id === (profile ?? routeSource)!.id ||
                ((profile ?? routeSource)!.machineId && entry.machineId === (profile ?? routeSource)!.machineId)).map(entry =>
                <button type="button" className="button button--secondary button--sm" key={entry.id}
                  aria-pressed={entry.id === profile?.id} disabled={entry.id === profile?.id || saving}
                  title={connectionTarget(entry)} onClick={() => onOpenRoute && navigate(() => onOpenRoute(entry.id))}>
                  {findProtocol(entry.protocol).acronym} · {entry.name}</button>)}
              {profile && onAddRoute && <button type="button" className="button button--primary button--sm"
                onClick={() => navigate(() => onAddRoute(profile.id))}>{t("form.route.add")}</button>}
            </div>
          </section>}
          <section className="form-section">
            <div className="form-section__heading">
              <h3 className="form-section__title">
                {t("form.step.protocol")}
              </h3>
              <span className="form-section__hint">
                {t(protocolSummaryKey(draft.protocol))} · {t("form.defaultPort", {
                  port: findProtocol(draft.protocol).defaultPort,
                })}
              </span>
            </div>
            <div
              className="protocol-picker protocol-picker--compact"
              role="radiogroup"
              aria-label={t("form.step.protocol")}
            >
              {protocolOptions.map((entry, index) => {
                const active = draft.protocol === entry.id;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    className={`protocol-option${active ? " is-selected" : ""}`}
                    onClick={() => selectProtocol(entry.id)}
                    onKeyDown={(event) =>
                      moveRadioGroupFocus(
                        event,
                        index,
                        (nextIndex) =>
                          selectProtocol(protocolOptions[nextIndex].id),
                      )
                    }
                  >
                    <ProtocolTile protocol={entry.id} />
                    <strong className="protocol-option__acronym">
                      {entry.acronym}
                    </strong>
                    <span className="protocol-option__label">
                      {t(protocolLabelKey(entry.id))}
                    </span>
                  </button>
                );
              })}
            </div>
            {!connectSupported && (
              <Callout
                tone="info"
                title={t("form.protocolUnavailable.title")}
              >
                {t(
                  mobile
                    ? "form.protocolUnavailable.mobileBody"
                    : "form.protocolUnavailable.backendBody",
                )}
              </Callout>
            )}
          </section>

          <section className="form-section">
            <h3 className="form-section__title">{t("form.step.target")}</h3>
            <div className="field-grid field-grid--even">
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-name`}>
                  {t("form.name")}
                </label>
                <input
                  id={`${formId}-name`}
                  data-field="name"
                  ref={nameRef}
                  className={`input${errors.name ? " is-invalid" : ""}`}
                  value={draft.name}
                  maxLength={limits.nameLength}
                  onChange={(event) =>
                    patch({ name: event.currentTarget.value }, "name")
                  }
                  placeholder={t("form.namePlaceholder")}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={
                    errors.name ? `${formId}-name-error` : undefined
                  }
                />
                {error("name") && (
                  <p className="field__error" id={`${formId}-name-error`}>
                    <AlertIcon size={12} />
                    {error("name")}
                  </p>
                )}
              </div>

              {relayEntry ? (
                /* A remembered device is found by identity, so there is no
                   address to edit. The relay that resolves it can still move,
                   which is the one part worth keeping editable here. */
                <div className="field">
                  <span className="field__label">{t("form.relayDevice")}</span>
                  <p className="input mono input--readonly">
                    {formatDeviceId(draft.deviceId ?? "")}
                  </p>
                </div>
              ) : (
                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-host`}>
                    {t(
                      draft.protocol === "lattice"
                        ? "form.remoteAddress"
                        : "form.hostname",
                    )}
                  </label>
                  <input
                    id={`${formId}-host`}
                    data-field="hostname"
                    className={`input mono${errors.hostname ? " is-invalid" : ""}`}
                    value={draft.hostname}
                    onChange={(event) =>
                      patch({ hostname: event.currentTarget.value }, "hostname")
                    }
                    placeholder={t(hostnamePlaceholderKeys[draft.protocol])}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.hostname)}
                  />
                  {error("hostname") && (
                    <p className="field__error">
                      <AlertIcon size={12} />
                      {error("hostname")}
                    </p>
                  )}
                </div>
              )}
            </div>

            {relayEntry && (
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-relay`}>
                  {t("remote.host.relayAddress")}
                </label>
                <input
                  id={`${formId}-relay`}
                  data-field="relayAddress"
                  className={`input mono${errors.hostname ? " is-invalid" : ""}`}
                  value={draft.relayAddress ?? ""}
                  onChange={(event) =>
                    patch(
                      { relayAddress: event.currentTarget.value },
                      "hostname",
                    )
                  }
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.hostname)}
                />
                {error("hostname") ? (
                  <p className="field__error">
                    <AlertIcon size={12} />
                    {error("hostname")}
                  </p>
                ) : (
                  <p className="field__hint">{t("remote.host.relayHint")}</p>
                )}
              </div>
            )}

            <div
              className={`field-grid${
                !protocolUsesUsername(draft.protocol)
                  ? " field-grid--port-only"
                  : ""
              }`}
            >
              {protocolUsesUsername(draft.protocol) && (
                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-user`}>
                    {t("form.username")}
                  </label>
                  <input
                    id={`${formId}-user`}
                    data-field="username"
                    className={`input mono${errors.username ? " is-invalid" : ""}`}
                    value={draft.username}
                    onChange={(event) =>
                      patch({ username: event.currentTarget.value }, "username")
                    }
                    placeholder={t("form.usernamePlaceholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.username)}
                  />
                  {error("username") && (
                    <p className="field__error">
                      <AlertIcon size={12} />
                      {error("username")}
                    </p>
                  )}
                </div>
              )}

              {/* A relay entry has no port of its own; the relay carries
                  the session. */}
              {!relayEntry && (
              <div className="field field--port">
                <label className="field__label" htmlFor={`${formId}-port`}>
                  {t("form.port")}
                </label>
                <input
                  id={`${formId}-port`}
                  data-field="port"
                  type="number"
                  inputMode="numeric"
                  min={limits.minPort}
                  max={limits.maxPort}
                  className={`input mono${errors.port ? " is-invalid" : ""}`}
                  value={Number.isFinite(draft.port) ? draft.port : ""}
                  onChange={(event) =>
                    patch({ port: Number(event.currentTarget.value) }, "port")
                  }
                  aria-invalid={Boolean(errors.port)}
                />
                {error("port") && (
                  <p className="field__error">
                    <AlertIcon size={12} />
                    {error("port")}
                  </p>
                )}
              </div>
              )}
            </div>

            {draft.protocol === "lattice" && !relayEntry && (
              <Callout tone="info" title={t("form.remoteDirect.title")}>
                {t("form.remoteDirect.body")}
              </Callout>
            )}

            <p className="connection-form__credential-note">
              {t("form.credentialsHint")}
            </p>

            {supportsCredentialRecord(candidate) && (
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-secret`}>
                  {t(draft.protocol === "lattice" ? "form.credential.pairingCode" : "form.credential.password")}
                  <span className="field__optional">{t("common.optional")}</span>
                </label>
                <input
                  id={`${formId}-secret`}
                  className="input"
                  type={showSecret ? "text" : "password"}
                  autoComplete="new-password"
                  value={credential.secret}
                  maxLength={4096}
                  disabled={!credential.native || credential.loading || saving}
                  onChange={event => credential.setSecret(event.currentTarget.value)}
                  placeholder={t(credential.saved && savedCredentialTarget ? "form.credential.keepSaved" : "form.credential.placeholder")}
                />
                <div className="drawer__foot-actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={saving || credential.revealing || !credential.native || credential.loading}
                    onClick={() => void toggleSecret()}
                  >
                    {t(showSecret ? "form.credential.hide" : "form.credential.show")}
                  </button>
                  {credential.saved && savedCredentialTarget && <span className="text-faint">{t("form.credential.saved")}</span>}
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={credential.allowMcpRead} disabled={!credential.native || credential.loading || saving} onChange={event => credential.setAllowMcpRead(event.currentTarget.checked)} />
                  <span className="checkbox__box" aria-hidden="true"><CheckIcon size={11} /></span>
                  {t("form.credential.mcpRead")}
                </label>
                <p className="connection-form__credential-note">{t("form.credential.mcpWarning")}</p>
                {draft.protocol === "rdp" && <p className="connection-form__credential-note">{t("form.credential.rdpHint")}</p>}
                {credential.error && <Callout tone="warn" title={t("form.credential.error")}>{credential.error}</Callout>}
              </div>
            )}

            {saveError && <Callout tone="warn" title={t("form.credential.saveFailed")}>{saveError}</Callout>}

            {duplicate && (
              <Callout tone="warn" title={t("form.duplicate.title")}>
                {t("form.duplicate.body", {
                  name: duplicate.name,
                  target: connectionTarget(duplicate),
                  protocol: findProtocol(duplicate.protocol).acronym,
                })}
              </Callout>
            )}
          </section>

          <details
            className="connection-advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="connection-advanced__summary">
              <span>
                <strong>{t("form.advanced")}</strong>
                <small>{t("form.advancedHint")}</small>
              </span>
            </summary>
            <div className="connection-advanced__body">
              <div className="field">
                <span className="field__label" id={`${formId}-env-label`}>
                  {t("form.environment")}
                </span>
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-labelledby={`${formId}-env-label`}
                >
                  {environmentCatalog.map((entry, index) => {
                    const active =
                      (draft.environment ?? "unassigned") === entry;
                    return (
                      <button
                        type="button"
                        key={entry}
                        role="radio"
                        aria-checked={active}
                        tabIndex={active ? 0 : -1}
                        title={t(environmentHintKey(entry))}
                        className={`segmented__option env-${entry}${
                          active ? " is-selected" : ""
                        }`}
                        onClick={() =>
                          patch({ environment: entry as Environment })
                        }
                        onKeyDown={(event) =>
                          moveRadioGroupFocus(
                            event,
                            index,
                            (nextIndex) =>
                              patch({
                                environment: environmentCatalog[
                                  nextIndex
                                ] as Environment,
                              }),
                          )
                        }
                      >
                        <span className="badge__dot" aria-hidden="true" />
                        {t(environmentLabelKey(entry))}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field-grid field-grid--even">
                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-group`}>
                    {t("form.group")}
                    <span className="field__optional">
                      {t("common.optional")}
                    </span>
                  </label>
                  <input
                    id={`${formId}-group`}
                    data-field="group"
                    className={`input${errors.group ? " is-invalid" : ""}`}
                    value={draft.group ?? ""}
                    maxLength={limits.groupLength}
                    onChange={(event) =>
                      patch({ group: event.currentTarget.value }, "group")
                    }
                    placeholder={t("form.groupPlaceholder")}
                    list={`${formId}-groups`}
                    aria-invalid={Boolean(errors.group)}
                  />
                  <datalist id={`${formId}-groups`}>
                    {[...new Set(profiles.map((entry) => entry.group))].map(
                      (group) => (
                        <option key={group} value={group} />
                      ),
                    )}
                  </datalist>
                  {error("group") && (
                    <p className="field__error">
                      <AlertIcon size={12} />
                      {error("group")}
                    </p>
                  )}
                </div>

                <div className="field">
                  <label className="field__label" htmlFor={`${formId}-tags`}>
                    {t("form.tags")}
                    <span className="field__optional">
                      {t("form.tagsHint")}
                    </span>
                  </label>
                  <input
                    id={`${formId}-tags`}
                    data-field="tags"
                    className={`input${errors.tags ? " is-invalid" : ""}`}
                    value={tagInput}
                    onChange={(event) => {
                      setTagInput(event.currentTarget.value);
                      setErrors((current) =>
                        clearValidationError(current, "tags"),
                      );
                    }}
                    placeholder={t("form.tagsPlaceholder")}
                    aria-invalid={Boolean(errors.tags)}
                  />
                  {error("tags") && (
                    <p className="field__error">
                      <AlertIcon size={12} />
                      {error("tags")}
                    </p>
                  )}
                </div>
              </div>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.favorite ?? false}
                  onChange={(event) =>
                    patch({ favorite: event.currentTarget.checked })
                  }
                />
                <span className="checkbox__box" aria-hidden="true">
                  <CheckIcon size={11} />
                </span>
                {t("form.favorite")}
              </label>
            </div>
          </details>
        </form>

        {confirmDiscard ? (
          <div className="drawer__foot drawer__foot--confirm">
            <p className="drawer__confirm-text">
              <AlertIcon size={14} />
              {t("form.discard.question")}
            </p>
            <div className="drawer__foot-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setConfirmDiscard(false)}
              >
                {t("form.discard.keep")}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => { const action = navigation.current; navigation.current = null; if (action) action(); else onClose(); }}
              >
                {t("form.discard.confirm")}
              </button>
            </div>
          </div>
        ) : (
          <div className="drawer__foot">
            <span className="drawer__foot-note">
              {dirty ? t("form.unsaved") : t("form.noChanges")}
            </span>
            <div className="drawer__foot-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={requestClose}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                form={formId}
                className={`button ${
                  connectSupported ? "button--secondary" : "button--primary"
                }`}
                disabled={saving || credential.loading}
              >
                {t("form.submit.saveOnly")}
              </button>
              {connectSupported && (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={saving || credential.loading}
                  onClick={() => void save(true)}
                >
                  {t("form.submit.saveAndConnect")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
