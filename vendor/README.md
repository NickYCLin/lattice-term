# Vendored third-party sources

## glib 0.18.5 security patch

`glib-0.18.5` is the unmodified crates.io source except for the upstream
`VariantStrIter::impl_get` fix from gtk-rs commit `05dff0e`. GTK3 and current
Tauri releases still require the 0.18 API line, while RUSTSEC-2024-0429 marks
only 0.20 and newer as patched.

The local patch changes the C out-argument from `&p` to `&mut p`, exactly as
upstream. Retire this vendored crate when the Linux Tauri stack can depend on
`glib >= 0.20`. The original crate license and copyright files remain beside
the source.

## OpenAI Codex fallback prompt

`openai-codex-prompt/prompt.md` is copied unmodified from
`codex-rs/models-manager/prompt.md` in openai/codex at commit
`30fc6864cc1318121eca1843c217fe00ce1212f1`, with that repository's Apache-2.0
`LICENSE` and `NOTICE` beside it. Codex sends this prompt to any model missing
from its catalog. LatticeTerm embeds it in the catalog it writes for
CLIProxyAPI sessions (`src-tauri/src/cliproxy/catalog.rs`) so that listing the
proxy's models in `/model` does not change what those models receive. Refresh
it from the same path when a newer Codex changes its fallback prompt.
