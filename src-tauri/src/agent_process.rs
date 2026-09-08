//! Keep a kill handle independent of the thread waiting for the PTY child.

use portable_pty::{Child, ChildKiller};
use std::io;

pub(crate) fn clone_killer(child: &dyn Child) -> io::Result<Box<dyn ChildKiller + Send + Sync>> {
    #[cfg(not(windows))]
    {
        Ok(child.clone_killer())
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::BorrowedHandle;
        let handle = child
            .as_raw_handle()
            .ok_or_else(|| io::Error::other("The PTY child has no process handle."))?;
        // The child owns this handle throughout the duplication. Never reopen
        // by PID: an exited child's PID could already belong to another process.
        let handle = unsafe { BorrowedHandle::borrow_raw(handle) }.try_clone_to_owned()?;
        Ok(Box::new(windows::ProcessKiller(std::sync::Arc::new(
            handle,
        ))))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::{AsRawHandle, OwnedHandle, RawHandle};
    use std::sync::Arc;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn TerminateProcess(process: RawHandle, exit_code: u32) -> i32;
        fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    }

    #[derive(Debug)]
    pub(super) struct ProcessKiller(pub Arc<OwnedHandle>);

    impl ChildKiller for ProcessKiller {
        fn kill(&mut self) -> io::Result<()> {
            // portable-pty 0.9's WinChildKiller reverses this BOOL check and
            // returns a stale GetLastError on success. Use the owned handle
            // directly so both successes and actual failures are reported.
            // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
            if unsafe { TerminateProcess(self.0.as_raw_handle(), 1) } != 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            // A child may exit between registry lookup and termination. Only
            // a signaled process handle proves there is nothing left to stop.
            if error.raw_os_error() == Some(5)
                && unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } == 0
            {
                return Ok(());
            }
            Err(error)
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self(Arc::clone(&self.0)))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetLastError(code: u32);
        }

        #[test]
        fn stopping_a_live_child_ignores_stale_last_error_and_is_repeatable() {
            let mut child = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 60",
                ])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut killer = clone_killer(&child).unwrap();
            let mut retry = killer.clone_killer();
            unsafe { SetLastError(6) };
            let result = killer.kill();
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let exited = child.try_wait().unwrap().is_some();
            if !exited {
                let _ = child.kill();
            }
            child.wait().unwrap();
            assert!(exited, "the child must actually exit");
            result.expect("a successful termination must not return stale error 6");
            drop(killer);
            retry
                .kill()
                .expect("an already exited process is safe to stop again");
        }

        #[test]
        fn an_invalid_process_handle_is_not_reported_as_success() {
            let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
            let mut killer = ProcessKiller(Arc::new(file.into()));
            assert_eq!(killer.kill().unwrap_err().raw_os_error(), Some(6));
        }
    }
}
