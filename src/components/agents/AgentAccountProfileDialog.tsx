import { useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import { AgentIcon, CloseIcon } from "../icons";
import { useModalFocus } from "../overlays/modalFocus";

export function AgentAccountProfileDialog({
  agentLabel,
  onSave,
  onCancel,
}: {
  agentLabel: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  useModalFocus({
    dialogRef,
    getInitialFocus: () => nameRef.current,
    onEscape: onCancel,
    escapeDisabled: saving,
  });

  async function save() {
    if (!trimmedName || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmedName);
    } catch (reason) {
      setError(t("agents.account.profileFailed", {
        detail: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div
      className="scrim scrim--center"
      role="presentation"
      onMouseDown={() => {
        if (!savingRef.current) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--wide agent-account-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-account-profile-title"
        aria-describedby="agent-account-profile-body"
        aria-busy={saving || undefined}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <span className="dialog__icon dialog__icon--inline" aria-hidden="true">
            <AgentIcon size={18} />
          </span>
          <div>
            <h2 className="dialog__title" id="agent-account-profile-title">
              {t("agents.account.dialogTitle", { name: agentLabel })}
            </h2>
            <p className="dialog__body" id="agent-account-profile-body">
              {t("agents.account.dialogBody", { name: agentLabel })}
            </p>
          </div>
          <button
            type="button"
            className="icon-button icon-button--sm"
            disabled={saving}
            onClick={onCancel}
            aria-label={t("common.close")}
            style={{ marginLeft: "auto" }}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <form onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <div className="dialog__stack">
            <label className="field" htmlFor="agent-account-profile-name">
              <span className="field__label">{t("agents.account.profileName")}</span>
              <input
                ref={nameRef}
                id="agent-account-profile-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
                }}
                placeholder={t("agents.account.profileNamePlaceholder")}
                maxLength={64}
                disabled={saving}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            <p className="field__hint">{t("agents.account.profileHint")}</p>

            {error && <p className="field__error" role="alert">{error}</p>}
          </div>

          <div className="dialog__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={saving}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={saving || !trimmedName}
            >
              {t(saving ? "agents.account.addingProfile" : "agents.account.saveProfile")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
