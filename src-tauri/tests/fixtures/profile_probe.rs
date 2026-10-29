//! Standalone, account-free stand-in for `codex debug prompt-input`.
//! Compile before the timed probe so shell/module startup is not under test.

use std::path::Path;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetConsoleWindow"]
    fn get_console_window() -> *mut std::ffi::c_void;
}

fn main() {
    #[cfg(windows)]
    // SAFETY: GetConsoleWindow has no arguments or memory preconditions.
    if !unsafe { get_console_window() }.is_null() {
        std::process::exit(41);
    }

    assert_eq!(
        std::env::args().skip(1).collect::<Vec<_>>(),
        ["--profile", "capability", "debug", "prompt-input", "probe"]
    );
    let root = std::env::current_dir().unwrap();
    for name in [
        "CODEX_HOME",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
    ] {
        assert_eq!(Path::new(&std::env::var_os(name).unwrap()), root);
    }
    assert_eq!(
        std::fs::read_to_string(root.join("capability.config.toml")).unwrap(),
        "developer_instructions = \"latticeterm-profile-capability-probe\"\n"
    );
    println!(
        r#"[{{"role":"developer","content":[{{"type":"input_text","text":"latticeterm-profile-capability-probe"}}]}}]"#
    );
}
