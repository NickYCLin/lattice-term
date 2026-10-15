# 更新器簽章相容回歸

以同一組公開 Minisign 夾具交叉執行 0.2.5 與 0.3.0，驗證更新器
使用的 `verify(..., true)` 路徑。夾具來自兩版 minisign-verify
發行原始碼 `src/lib.rs` 的 `verify`／`verify_prehashed` 測試；
只含公開金鑰、`test` 內容及既有簽章，不產生或讀取私鑰。

```sh
cargo test --locked --manifest-path scripts/updater-signature-compat/Cargo.toml
```

合法 legacy／prehashed 簽章須在兩版通過，變更內容、trusted comment、
金鑰或損壞簽章須拒絕。另將 global signature 的 Ed25519 S 加上
群階數，明確驗證兩版皆拒絕非 canonical 簽章。不因更新器的
changelog 描述而假設舊版必定接受，也不放寬正式更新器的驗證。

預設七項測試不讀取實際發行資產。另有明確 opt-in 的
`published_release_asset_remains_compatible` 測試，須提供
`LATTICE_UPDATE_ASSET`、`LATTICE_UPDATE_SIGNATURE` 檔案路徑，及設定
檔中的 base64 `LATTICE_UPDATE_PUBLIC_KEY`；以 `-- --ignored` 執行。
它使用與更新器相同的外層 base64 解碼，核對兩版接受同一實際資產、
拒絕竄改一個位元的內容。測試本身不連網、不執行安裝；無論是否
通過，都不代表 macOS 原子安裝或裝置更新已完成驗收。
