// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The background daemon is this same binary; it must not start a window.
    if let Some(code) = latticeterm_lib::agent_daemon::server::run_cli(std::env::args_os().skip(1))
    {
        std::process::exit(code);
    }
    if let Some(code) = latticeterm_lib::agent_daemon::mcp::run_cli(std::env::args_os().skip(1)) {
        std::process::exit(code);
    }
    if let Some(code) = latticeterm_lib::agent::run_reporter_cli(std::env::args_os().skip(1)) {
        std::process::exit(code);
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = latticeterm_lib::linux_webkit::restart_if_needed() {
        eprintln!("Could not restart with Linux WebKit compatibility settings: {error}");
    }
    latticeterm_lib::run()
}
