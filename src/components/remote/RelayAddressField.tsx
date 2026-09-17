import { useState } from "react";
import { useI18n } from "../../i18n/context";
import { CheckIcon, EditIcon } from "../icons";

/**
 * The relay address behaves like AnyDesk's implicit server: once one is
 * remembered, day-to-day sharing and connecting only involve the device ID
 * and pairing code. The field therefore collapses to a "saved" summary and
 * reveals the wss:// input only on request — or when nothing is saved yet.
 */
export function RelayAddressField({
  id,
  value,
  hasSaved,
  reveal = false,
  busy,
  required = false,
  hint,
  onChange,
}: {
  id: string;
  value: string;
  hasSaved: boolean;
  /** A failed lookup needs the saved address visible for correction. */
  reveal?: boolean;
  busy: boolean;
  required?: boolean;
  hint: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(!hasSaved);

  if (!editing && !reveal) {
    return (
      <div className="field">
        <span className="field__label">{t("remote.host.relayAddress")}</span>
        <div className="relay-address-saved">
          <CheckIcon size={14} />
          <span>{t("remote.relay.saved")}</span>
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={busy}
            onClick={() => setEditing(true)}
            aria-expanded={false}
            aria-controls={id}
          >
            <EditIcon size={12} />
            {t("remote.relay.change")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("remote.host.relayAddress")}
      </label>
      <input
        id={id}
        className="input mono"
        value={value}
        disabled={busy}
        required={required}
        placeholder={t("remote.host.relayPlaceholder")}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <small className="field__optional">{hint}</small>
    </div>
  );
}
