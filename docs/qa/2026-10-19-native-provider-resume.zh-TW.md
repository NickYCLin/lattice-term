# 原生對話 provider 相容性驗證

日期：2026-10-19

## 問題與修正

先前 Codex 代理 provider 只透過程序參數注入，隨機 v2 名稱卻寫入共用
原生 thread。另一個原生介面載入同一段對話時，帳號設定沒有該 provider，
因此出現 provider not found。

改用代理 ID 與正規化端點的穩定 v3 名稱，並登記不含 key 的 provider
定義。憑證透過 LatticeTerm helper 取得，不修改預設服務、不改寫逐字稿。
v3 端點不符、v2 代理 ID 不符，或原對話不是代理對話時拒絕接管。

## 本機檢查

- `cargo test --lib -- --test-threads=4`：974 通過、29 忽略、0 失敗。
- `cargo check`：通過。
- `cargo fmt --all -- --check`：通過；最後路由檢查調整後，31 項
  `cliproxy::` 測試再次全部通過。
- `npm run typecheck`：通過。
- 對話服務識別、代理設定與交接相關 Vitest：3 個檔案、31 項通過。
- `npm run build`：通過，入口 365.32 KiB，低於 500 KiB 限制。
- Rust 測試涵蓋預設值與註解保留、重複登記、設定衝突、外部修改、
  不安全路徑、憑證路由綁定、舊 provider 相容及跨服務拒絕。
- `cargo build --bin lattice-term`：通過；Windows helper 以合成環境
  憑證執行，退出碼 0，stdout token 比對正確，沒有啟動 GUI。
- Codex CLI 0.163.0、隔離的 TEMP `CODEX_HOME`、本機 HTTP fixture
  與實際 helper：新對話及指定原 provider 的同 thread 續聊均完成。
  `/v1/models` 與 `/v1/responses` 的 Authorization 均符合合成 key，
  responses 的 model 符合 fixture 設定；沒有使用真實帳號或 API key。
- CLI 直接執行未指定 provider 的 `exec resume` 仍採用預設 openai，
  未通過續聊，並收到官方端點 401；該負向測試只有合成內容，未提供
  真實登入資料。這不能當成外部 GUI 已保留服務的證據。LatticeTerm
  續接會明確帶入原代理，外部介面是否沿用 thread provider 需另驗收。
- TEMP fixture 的 Codex helper PATH alias 警告仍存在；未影響上述
  新對話與指定原 provider 的續聊結果。

## 限制與驗收界線

- 尚未驗收 GPT／Codex 桌面 GUI、安裝版、macOS 或 Linux；本機通過
  不代表使用者目前安裝的版本已更新，也不代表已發版。
- 舊 v2 對話要先由更新後 LatticeTerm 以原代理續接，才會補相容定義；
  無法由隨機識別碼判斷該代理過去是否改過端點。
- 更早期未攜帶可核對代理 ID 的隨機 provider 無法安全辨識原連線，
  拒絕自動接管，不憑目前選取的代理猜測。
- 外部原生版本需支援官方 `auth.command`；不支援時不能宣稱可續聊。
- 僅存於加密 vault 的 key 不能由獨立 helper 取得，即使 App 已解鎖；
  LatticeTerm 自己啟動的子程序可透過綁定路由的環境變數沿用已驗證 key。
- 設定以同目錄暫存檔替換，寫入前再次比對內容；可偵測已發生的外部
  修改，但不是跨所有外部編輯器的原子 CAS。請勿同時編輯該設定檔。
- 已登記的 helper 路徑若因搬移程式而改變，視為設定衝突，不自動覆寫。
