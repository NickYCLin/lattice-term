import { useMemo, useState } from "react";
import type { DatabaseResult } from "../../domain/database";

/** Display only: filtering never changes the SQL or issues another query. */
export function SqlResultTable({ result }: { result: DatabaseResult }) {
  const [filter, setFilter] = useState("");
  const [cell, setCell] = useState<{ row: number; column: number } | null>(null);
  const rows = useMemo(() => result.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
    !filter.trim() || row.some(value => (value ?? "NULL").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))), [result.rows, filter]);
  const selected = cell ? result.rows[cell.row]?.[cell.column] : undefined;
  return <div className="sql-results">
    <div className="sql-results__tools"><label>篩選結果<input type="search" aria-label="篩選查詢結果" placeholder="在目前結果中搜尋…" value={filter} onChange={event => setFilter(event.target.value)} /></label><span role="status">顯示 {rows.length} / {result.rows.length} 筆 · {result.columns.length} 欄</span></div>
    <p className="sql-results__hint">點選儲存格可檢視並複製內容；篩選只影響目前的結果。</p>
    <div className="database-manager__result sql-results__table" tabIndex={0} role="region" aria-label="SQL 查詢結果"><table>
      <thead><tr><th scope="col" className="sql-results__number">#</th>{result.columns.map((name, i) => <th key={i} scope="col">{name}</th>)}</tr></thead>
      <tbody>{rows.map(({ row, index }) => <tr key={index}><th scope="row" className="sql-results__number">{index + 1}</th>{row.map((value, column) => <td key={column}><button type="button" className="sql-results__cell" aria-label={`第 ${index + 1} 筆，${result.columns[column]}，檢視內容`} onClick={() => setCell({ row: index, column })}>{value === null ? <em>NULL</em> : value === "" ? <em>空字串</em> : value}</button></td>)}</tr>)}</tbody>
    </table>{!rows.length && <p className="sql-results__empty">{result.rows.length ? "沒有符合篩選的資料" : "查詢成功，沒有符合條件的資料"}</p>}</div>
    {cell && <section className="sql-results__preview" aria-label="儲存格內容"><header><strong>{result.columns[cell.column]} <small>第 {cell.row + 1} 筆</small></strong><button type="button" className="button button--secondary" onClick={() => setCell(null)}>收起內容</button></header><textarea aria-label="選取的儲存格內容" readOnly rows={4} value={selected === null ? "NULL" : selected ?? ""} /><small>顯示伺服器回傳的預覽內容，可選取複製。每格最多 {result.cellCharacterLimit} 字元。</small></section>}
  </div>;
}
