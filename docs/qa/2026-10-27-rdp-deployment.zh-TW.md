# RDP 部署檔案通道驗證

## 修改範圍

Windows 客戶端新增 `rdp_stage_file`，逐檔核准後將完整快照放入該連線專用的唯讀 RDPDR 分享，並回傳 SHA-256 與 tsclient 路徑。實際複製與部署仍透過獨立授權的遠端桌面操作完成。原有 JPEG RGB 修正另行提交。

## 已通過

- RDP engine：`cargo test --manifest-path crates/lattice-rdp/Cargo.toml --locked`，9 項通過。包含真實 Windows 原生開檔、讀取部署內容、目錄查詢、拒絕寫入與跳脫路徑，以及 JPEG 編解碼。
- 桌面後端：`cargo test --manifest-path src-tauri/Cargo.toml --lib --locked rdp -- --test-threads=2`，19 項通過。包含暫存快照、不覆寫、取消前驗證、清理、大小／檔案數限制、世代與連線存活檢查，以及 RDP 核准不受 SSH 信任或 Remote 自動核准設定影響。
- MCP：`without_a_daemon_the_tools_answer_honestly` 與 `every_operation_kind_is_announced_and_matches_its_wire_tag` 各 1 項通過。
- 核准視窗：`npm test -- --run src/components/overlays/RemoteCommandApproval.test.tsx`，4 項通過。
- 兩個 Rust crate 的格式檢查與 `cargo check --locked` 通過。
- `npm run build` 通過，含型別檢查、正式前端建置與入口大小限制。
- Windows 桌面開發版已以 Tauri 建置，直接啟動產物的 MCP stdio，確認 32 個工具中包含 `rdp_stage_file` 及其必要參數。
- 新 adapter 對既有舊背景服務執行唯讀能力查詢，確認 `rdp_stage_file` 被列入需重啟服務的工具，避免將未知操作送給舊服務。

## 驗證邊界

本機桌面產物使用開發模式與已建置的前端資產。RDP engine 由本次原始碼編譯；未變更的 VNC、Agent 與 Remote sidecar 使用本機既有安裝版的打包資源，未在本次重新驗收其來源建置。

既有桌面程式、背景服務與工作階段未被停止或替換。尚未在實際遠端 Windows 主機驗證磁碟重新導向原則、檔案複製與部署結果，也未執行正式發布。不能將上述本機檢查描述為安裝版或遠端部署已完成。
