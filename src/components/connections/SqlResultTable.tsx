import { useI18n } from "../../i18n/context";
import { useMemo, useState } from "react";
import type { DatabaseResult } from "../../domain/database";

/** Display only: filtering never changes the SQL or issues another query. */
export function SqlResultTable({ result }: { result: DatabaseResult }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [cell, setCell] = useState<{ row: number; column: number } | null>(null);
  const rows = useMemo(() => result.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    !filter.trim() || row.some(value => (value ?? "NULL").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))), [result.rows, filter]);
  const selected = cell ? result.rows[cell.row]?.[cell.column] : undefined;
  return <div className="sql-results">
    <div className="sql-results__tools"><label>{t("database.filter")}<input type="search" aria-label={t("database.filterLabel")} placeholder={t("database.filterPlaceholder")} value={filter} onChange={event => setFilter(event.target.value)} /></label><span role="status">{t("database.filteredSummary", { visible: rows.length, total: result.rows.length, columns: result.columns.length })}</span></div>
    <p className="sql-results__hint">{t("database.filterHint")}</p>
    <div className="database-manager__result sql-results__table" tabIndex={0} role="region" aria-label={t("database.sqlResults")}><table>
      <thead><tr><th scope="col" className="sql-results__number">#</th>{result.columns.map((name, i) => <th key={i} scope="col">{name}</th>)}</tr></thead>
      <tbody>{rows.map(({ row, index }) => <tr key={index}><th scope="row" className="sql-results__number">{index + 1}</th>{row.map((value, column) => <td key={column}><button type="button" className="sql-results__cell" aria-label={t("database.cellLabel", { row: index + 1, column: result.columns[column] })} onClick={() => setCell({ row: index, column })}>{value === null ? <em>NULL</em> : value === "" ? <em>{t("database.emptyString")}</em> : value}</button></td>)}</tr>)}</tbody>
    </table>{!rows.length && <p className="sql-results__empty">{result.rows.length ? t("database.noFilteredRows") : t("database.noRows")}</p>}</div>
    {cell && <section className="sql-results__preview" aria-label={t("database.cellContent")}><header><strong>{result.columns[cell.column]} <small>{t("database.rowNumber", { row: cell.row + 1 })}</small></strong><button type="button" className="button button--secondary" onClick={() => setCell(null)}>{t("database.collapseCell")}</button></header><textarea aria-label={t("database.selectedCell")} readOnly rows={4} value={selected === null ? "NULL" : selected ?? ""} /><small>{t("database.cellHint", { limit: result.cellCharacterLimit })}</small></section>}
  </div>;
}
