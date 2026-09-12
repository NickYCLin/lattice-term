//! The sharing engine belongs to the desktop, including on abrupt Windows exit.
use tokio::process::Child;

pub(super) struct AgentLifetime {
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}
impl AgentLifetime {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::*;
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err("Cannot create the sharing process job.".into());
            }
            let job = unsafe { OwnedHandle::from_raw_handle(handle) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            let process = child
                .raw_handle()
                .ok_or("The sharing process has already exited.")?;
            if configured == 0 || unsafe { AssignProcessToJobObject(handle, process) } == 0 {
                return Err("Cannot bind the sharing process to the desktop.".into());
            }
            Ok(Self { job })
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }
    pub(super) fn stop(&self) {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.job.as_raw_handle(),
                    1,
                );
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{process::Stdio, time::Duration};
    #[tokio::test]
    async fn dropping_desktop_ownership_ends_the_windows_sharing_process() {
        // A pipe-blocked process stands in for the bundled Agent; no desktop
        // input, provider account or persistent user settings are involved.
        let mut child = tokio::process::Command::new(std::env::var("ComSpec").unwrap())
            .args(["/d", "/q", "/c", "set /p owned_fixture_wait="])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let owner = AgentLifetime::attach(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(owner);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
    }
}
