# PR #319 更新器簽章相容檢查

本次將主線 `d558904` 整合至原 Dependabot 分支，保留其他依賴與
工作流更新。更新器鎖定 2.13.3、minisign-verify 0.3.0，沒有搬用
其他分支的 lockfile，也沒有改公開金鑰或簽章驗證規則。

## 簽章回歸

`scripts/updater-signature-compat` 同時鎖定 minisign-verify 0.2.5
與 0.3.0。七項固定夾具測試通過：合法 legacy／prehashed、竄改
內容、trusted comment、錯誤金鑰、損壞簽章、非 canonical global S。
後五者均須拒絕。新測試曾假設舊版接受 S 加群階數，但實測兩版
均拒絕；核對符合 Cargo.lock checksum 的原始 crate archive，
兩版都已包含 `check_s_lt_l`，因此不沿用 changelog 推論舊版行為。

另下載已公開的 `v2026.10.15` macOS aarch64 更新資產及 `.sig`，
以專案設定的公開金鑰及更新器相同的 base64 解碼與 verify 路徑
執行 opt-in 測試：一項通過、零失敗、零 ignored；兩版均接受
同一資產，均拒絕改動一個位元後的內容。未執行安裝或發布。

- `LatticeTerm_2026.10.15_aarch64.app.tar.gz` SHA256：
  `80ada623a766357a5d4093c86a5797c039023a7af2ba0984c8f0215fffaa42eb`
- 對應 `.sig` SHA256：
  `0fdf3e598d5ec6de57d6ddc6a1416d344a08ce7fcd03098d547cdd4fe1f50bad`

## 邊界

Linux 整合版 Rust fmt 與 locked all-targets check 通過；檢查時
用 `TAURI_CONFIG` 排除未打包 sidecar，不是安裝包驗收。
相容測試只驗證指定公開資產與固定夾具，不涵蓋所有歷史版本、
macOS 2.13.2 新增的原子替換／回復行為或 Windows 安裝流程。
不以舊 head CI 取代新整合 head 門檻；未派送任何 CI，待 coordinator
依精確 SHA 安排必要驗證後才可合併。
