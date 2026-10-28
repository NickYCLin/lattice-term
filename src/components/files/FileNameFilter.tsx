import { useId } from "react";
import { useI18n } from "../../i18n/context";
import { fileSortOrders, type FileSortOrder } from "./fileSorting";

const sortLabels = {
  nameAsc: "files.sort.nameAsc",
  nameDesc: "files.sort.nameDesc",
  newest: "files.sort.newest",
  oldest: "files.sort.oldest",
  largest: "files.sort.largest",
  smallest: "files.sort.smallest",
} as const;

export function filterFileNames<Entry extends { name: string }>(entries: Entry[], query: string): Entry[] {
  const needle = query.trim().toLowerCase();
  return needle ? entries.filter(entry => entry.name.toLowerCase().includes(needle)) : entries;
}

export function FileNameFilter({ value, onChange, disabled, sortOrder, onSortChange }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  sortOrder: FileSortOrder;
  onSortChange: (order: FileSortOrder) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const sortId = useId();
  return (
    <div className="file-name-filter">
      <label htmlFor={id}>{t("files.filter.label")}</label>
      <input id={id} type="search" className="input" value={value}
        placeholder={t("files.filter.placeholder")} disabled={disabled}
        onChange={event => onChange(event.currentTarget.value)} />
      {value && <button type="button" className="button button--ghost" disabled={disabled}
        onClick={() => onChange("")}>{t("files.filter.clear")}</button>}
      <div className="file-name-filter__sort">
        <label htmlFor={sortId}>{t("files.sort.label")}</label>
        <select id={sortId} className="select" value={sortOrder} disabled={disabled}
          onChange={event => onSortChange(event.currentTarget.value as FileSortOrder)}>
          {fileSortOrders.map(order => <option key={order} value={order}>{t(sortLabels[order])}</option>)}
        </select>
      </div>
    </div>
  );
}
