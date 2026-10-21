# Codex 模型清單停在舊版本

## 原因與修正

曾經使用診斷用的 `models-astra-direct.json` 模型檔時，
Codex 的使用者設定可能留下 `model_catalog_json` 覆寫。
這會讓模型選單持續使用靜態檔案；只更新 CLI 不會解除這個設定。

LatticeTerm 現在會在查詢 Codex 模型、啟動原生對話或工作階段前，
檢查實際使用的帳號設定目錄，包括具名帳號及 CODEX_HOME。
只處理路徑結尾符合
`LatticeTerm/diagnostics/codex-direct-tools-YYYYMMDD/models-astra-direct.json`
的舊診斷項目，不加入寫死的模型名稱，也不把 API 發布視為帳號可用證明。

修復前在同一目錄保留完整的私有備份，檔名為
`.latticeterm-codex-model-catalog-*.bak`。
確認設定沒有被外部修改後，以原子替換移除該項目；其他文字、換行、
登入檔與對話紀錄保持不變。成功後不會再次備份。

一般自訂模型清單、第三方供應商，以及 CLIProxyAPI 的程序專屬模型清單
不會移除。格式無法安全辨識時保持原樣；無法備份或偵測到外部修改時，
停止修復並回報錯誤，不覆寫其他工具剛儲存的內容。
設定檔是連結、超過讀取上限或無法安全讀取時，略過自動修復，
讓 CLI 維持原本的設定處理方式，不因這項遷移額外阻擋啟動。

## 驗證範圍

回歸測試涵蓋 Windows 與 Unix 形式的目錄、CRLF 保留、重複執行、
私人備份、帳號檔保留、自訂與代理清單、巢狀設定、錯誤 TOML、
不安全路徑，以及修復中途的外部修改。
Unix 的符號連結與檔案權限檢查另由 Unix 平台執行。

此修正不需要呼叫模型生成。其他電腦若是同一種舊設定，安裝含此修正的
版本並重新開啟模型選單即可觸發檢查；若仍缺少模型，須再查該帳號與
供應商實際回傳內容，不應直接刪除其自訂清單。

本機測試、CI、正式安裝檔與其他電腦的實機畫面是不同驗證邊界。

## 本機檢查結果

- Windows 的 cargo fmt --all -- --check、cargo check 與
  cargo check --tests 通過。
- 以暫存 rustc --test 入口直接引用 codex_config、local_files 與
  durable_file 原始模組，12 項測試全部通過，沒有替換或模擬檔案寫入工具。
- 完整 cargo test --lib 在整個桌面套件編譯階段耗時過久，已主動停止，
  不將獨立模組測試當成完整測試套件通過。
- Unix 專屬測試、CI、正式安裝檔與其他電腦尚未驗收。
