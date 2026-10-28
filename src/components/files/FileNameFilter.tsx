import { useId } from "react";
import { useI18n } from "../../i18n/context";

export function filterFileNames<Entry extends { name: string }>(entries: Entry[], query: string): Entry[] {
  const needle = query.trim().toLowerCase();
  return needle ? entries.filter(entry => entry.name.toLowerCase().includes(needle)) : entries;
}

export function FileNameFilter({ value, onChange, disabled }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="file-name-filter">
      <label htmlFor={id}>{t("files.filter.label")}</label>
      <input id={id} type="search" className="input" value={value}
        placeholder={t("files.filter.placeholder")} disabled={disabled}
        onChange={event => onChange(event.currentTarget.value)} />
      {value && <button type="button" className="button button--ghost" disabled={disabled}
        onClick={() => onChange("")}>{t("files.filter.clear")}</button>}
    </div>
  );
}
