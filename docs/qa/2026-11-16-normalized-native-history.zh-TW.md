# 任務 32：原生對話正規化與完整閱讀驗收

本次修改以 `137bc5ff` 為基底，使用獨立分支實作；不發版、不安裝 App、
不改寫 CLI 紀錄，不碰 CLIProxyAPI 或正式資料庫。所有 fixture 都是臨時
合成資料，不使用真實帳號對話、金鑰、主機或認證檔。

## 實作範圍

- `transcript/normalized.rs`：共用回合／項目模型；Codex、Claude、Gemini
  的工具配對、公開推理／不可讀簽章、紀錄 diff、圖片與子代理。
- 同模組提供有界近期快照、向前分頁、來源變動偵測、zstd 串流解碼；
  Gemini JSONL 先重播 set／patch／rewind，避免已撤回內容重新出現。
- `transcript/redact.rs` 與 `security/transcriptRedaction.json`：Rust／前端
  共用不可逆遮罩；交接先遮罩再截斷，近期尾端會檢查前綴 PEM 邊界。
  統一開檔入口拒絕認證檔，圖片與大型結果只沿用嚴格的既有安全邊界。
- `NativeRecordView.tsx`：兩種對話共用的推理、diff、圖片／燈箱、子代理
  與完整閱讀區；沿用工具摘要卡。閱讀區最多保留六頁，不接管外層捲動。
- 原生鏡像刷新、穩定項目 ID、收合保護與搜尋定位一併更新，避免圖片或
  diff 被當成一般 commentary 隱藏，也不讓新增 rich record 阻斷同步。
- `NATIVE_CONVERSATION_SYNC.zh-TW.md` 更新支援矩陣、格式版本、官方依據、
  遮罩規則與容量上限，明確區分實作與已安裝 App 驗收。

## 自動化驗證

| 檢查 | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過，0 錯誤 |
| 全部 Vitest | 2,699 通過／0 失敗／3 略過；350 個測試檔通過、1 個略過 |
| `npm run build` | 通過；入口 453.89 KiB，低於 500 KiB 上限 |
| `npm run build:sidecars` | 通過，在 Rust 測試前執行 |
| `cargo test` | 1,222 通過／0 失敗／65 ignored（含整合測試） |
| `cargo check` | 通過 |
| `cargo clippy --all-targets -- -D warnings` | 通過，0 警告 |
| `cargo fmt --all -- --check` | 通過 |
| `node scripts/connection-card-layout.mjs` | 144 通過／0 失敗 |
| `node scripts/session-folder-layout.mjs` | 144 通過／0 失敗 |

Chromium 在此環境無可用 sandbox，首次兩支量測在啟動階段失敗。
之後用腳本既有的 `CHROMIUM_NO_SANDBOX=1` 重跑通過；只載入合成 UI、
使用臨時瀏覽器設定檔，沒有連線實際主機或使用個人瀏覽器資料。
Rust 的 ignored 項目需要平台、容器或外部服務，不計入本次通過數。
構建仍有既有 ConnectFlow 同時靜態／動態匯入提示，沒有新增構建失敗。

## 新增測試涵蓋

- Claude、Codex、Gemini 合成工具呼叫／結果配對、公開推理、加密或
  簽章不可讀、圖片與 diff；來源 bytes 不變。
- Gemini JSON 與 JSONL、mutation 修補／移除／排序／回退／重設；
  不完整 mutation 拒絕，不把已回退文字送到前端。
- 725 則訊息逐頁到開頭，沒有重複 ID 或漏讀；游標來源改變時拒絕。
- 超大行、截斷行、JSON escaping 的序列化上限、zstd 解碼／損毀／
  解壓預算；超大遮罩文字不會破壞舊快照的容量計算。
- 假金鑰格式、巢狀敏感鍵、分段 PEM、丟棄前綴中的 PEM、交接檔遮罩，
  認證檔與其 symlink 不開啟。
- Claude／Gemini 子代理與父目錄核對，子代理內容不進主線；大型工具
  結果限制在固定 session 目錄，不跟隨 credentials 路徑。
- 圖片端點核對確切對話／opaque item ID，受管舊 ID 圖片與 embedded
  pixels 可預覽；未引用項目、其他對話與已刪除檔案不會錯讀。
- 前端預設收合推理、不可讀簽章不渲染、diff 可見、圖片／燈箱再次驗證、
  早期分頁順序、過期回應隔離、六頁記憶體窗口與返回最近紀錄。
- 一般對話鏡像與 PTY 共用卡片、工具結果／失敗狀態、rich record 刷新，
  圖片／diff／錯誤不被過程收合隱藏。

## 尚需實機確認

本次沒有更新安裝版。需在測試帳號以 Codex 0.169.0、Claude Code
2.1.325 驗證兩種對話的完整閱讀、子代理與圖片燈箱；Gemini 本機未安裝，
本次依文件所列固定官方版本及合成 fixtures 驗證，仍須以該版本建立實際
工具／推理／圖片對話比對。另需在安裝版確認大型真實紀錄的等待時間、
頁內閱讀位置與各主題外觀。這些實機項目不由單元測試或 Chromium 合成
量測冒充通過。
