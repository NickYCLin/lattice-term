//! A read-only view of one session's staging directory. Never redirect a
//! user's whole volume: every path-bearing request is prefixed before the
//! native backend performs handle-relative, reparse-point-safe opens.
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::efs::*;
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::{
    RdpdrBackend, RdpdrBackendFactory, RdpdrBackendFactoryResult, RdpdrBackendProduct,
};
use ironrdp::svc::SvcMessage;
use ironrdp_rdpdr_native::{RedirectedDrive, WindowsRdpdrBackend, WindowsRdpdrBackendFactory};
use std::path::Path;

pub struct StagingFactory {
    native: WindowsRdpdrBackendFactory,
    prefix: String,
}

impl StagingFactory {
    pub fn new(path: &str) -> Result<Self, String> {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        let path = path.to_str().ok_or("Invalid staging directory")?;
        let path = path.strip_prefix(r"\\?\").unwrap_or(path);
        let bytes = path.as_bytes();
        if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
            return Err("Staging requires a local Windows drive".into());
        }
        let prefix = path[3..].to_string();
        // Validate before passing the prefix into any native path operation.
        confined_path("", &prefix, false).ok_or("Invalid staging directory")?;
        let drive = RedirectedDrive::new(1, "LatticeDeploy", Path::new(&path[..3]), true)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            native: WindowsRdpdrBackendFactory::new(drive),
            prefix,
        })
    }
}

impl RdpdrBackendFactory for StagingFactory {
    fn build_rdpdr_backend(&self) -> RdpdrBackendFactoryResult<RdpdrBackendProduct> {
        Ok(RdpdrBackendProduct::new(
            Box::new(StagingBackend {
                native: self.native.build(),
                prefix: self.prefix.clone(),
            }),
            vec![ironrdp::rdpdr::RdpdrDrive::new(1, "LatticeDeploy".into())],
        ))
    }
}

fn confined_path(prefix: &str, path: &str, pattern: bool) -> Option<String> {
    if path.starts_with(r"\\")
        || path.contains(['/', ':', '\0'])
        || path.chars().any(char::is_control)
    {
        return None;
    }
    let tail = path.strip_prefix('\\').unwrap_or(path);
    let components: Vec<_> = tail.split('\\').collect();
    for (index, part) in components.iter().enumerate() {
        if tail.is_empty() {
            break;
        }
        let wildcard = pattern && index + 1 == components.len();
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with(['.', ' '])
            || part.contains(['"', '<', '>', '|'])
            || (!wildcard && part.contains(['*', '?']))
        {
            return None;
        }
    }
    Some(if tail.is_empty() {
        if pattern {
            format!("\\{prefix}\\*")
        } else {
            format!("\\{prefix}")
        }
    } else {
        format!("\\{prefix}\\{tail}")
    })
}

#[derive(Debug)]
struct StagingBackend {
    native: WindowsRdpdrBackend,
    prefix: String,
}
impl ironrdp::core::AsAny for StagingBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
impl RdpdrBackend for StagingBackend {
    fn reset(&mut self) -> PduResult<()> {
        self.native.reset()
    }
    fn restore_drive(&mut self, id: u32) -> PduResult<()> {
        self.native.restore_drive(id)
    }
    fn handle_server_device_announce_response(
        &mut self,
        pdu: ServerDeviceAnnounceResponse,
    ) -> PduResult<()> {
        self.native.handle_server_device_announce_response(pdu)
    }
    fn handle_scard_call(
        &mut self,
        req: DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<Vec<SvcMessage>> {
        Ok(vec![SvcMessage::from(RdpdrPdu::DeviceControlResponse(
            DeviceControlResponse {
                device_io_reply: DeviceIoResponse::new(req.header, NtStatus::NOT_SUPPORTED),
                output_buffer: None,
            },
        ))])
    }
    fn poll_deferred_messages(&mut self) -> PduResult<Vec<SvcMessage>> {
        self.native.poll_deferred_messages()
    }
    fn handle_drive_io_request(
        &mut self,
        mut req: ServerDriveIoRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        match &mut req {
            ServerDriveIoRequest::ServerCreateDriveRequest(create) => {
                match confined_path(&self.prefix, &create.path, false) {
                    Some(path) => create.path = path,
                    None => {
                        return Ok(vec![SvcMessage::from(RdpdrPdu::DeviceCreateResponse(
                            DeviceCreateResponse {
                                device_io_reply: DeviceIoResponse::new(
                                    create.device_io_request.clone(),
                                    NtStatus::ACCESS_DENIED,
                                ),
                                file_id: 0,
                                information: Information::empty(),
                            },
                        ))])
                    }
                }
            }
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(query)
                if query.initial_query != 0 =>
            {
                match confined_path(&self.prefix, &query.path, true) {
                    Some(path) => query.path = path,
                    None => {
                        return Ok(vec![SvcMessage::from(
                            RdpdrPdu::ClientDriveQueryDirectoryResponse(
                                ClientDriveQueryDirectoryResponse {
                                    device_io_reply: DeviceIoResponse::new(
                                        query.device_io_request.clone(),
                                        NtStatus::ACCESS_DENIED,
                                    ),
                                    buffer: None,
                                },
                            ),
                        )])
                    }
                }
            }
            // No control operation, including object-ID creation, is needed
            // to copy a deployment archive from a read-only staging drive.
            ServerDriveIoRequest::DeviceControlRequest(control) => {
                return Ok(vec![SvcMessage::from(RdpdrPdu::DeviceControlResponse(
                    DeviceControlResponse {
                        device_io_reply: DeviceIoResponse::new(
                            control.header.clone(),
                            NtStatus::NOT_SUPPORTED,
                        ),
                        output_buffer: None,
                    },
                ))])
            }
            _ => {}
        }
        self.native.handle_drive_io_request(req)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(file_id: u32, major_function: MajorFunction) -> DeviceIoRequest {
        DeviceIoRequest {
            device_id: 1,
            file_id,
            completion_id: 1,
            major_function,
            minor_function: MinorFunction::from(0),
        }
    }
    fn open(backend: &mut StagingBackend, path: &str, access: u32) -> Vec<u8> {
        backend
            .handle_drive_io_request(ServerDriveIoRequest::ServerCreateDriveRequest(
                DeviceCreateRequest {
                    device_io_request: request(0, MajorFunction::Create),
                    desired_access: DesiredAccess::from_bits_retain(access),
                    allocation_size: 0,
                    file_attributes: FileAttributes::empty(),
                    shared_access: SharedAccess::from_bits_retain(7),
                    create_disposition: CreateDisposition::FILE_OPEN,
                    create_options: CreateOptions::empty(),
                    path: path.into(),
                },
            ))
            .unwrap()[0]
            .encode_unframed_pdu()
            .unwrap()
    }
    fn status(bytes: &[u8]) -> u32 {
        u32::from_le_bytes(bytes[12..16].try_into().unwrap())
    }
    #[test]
    fn native_backend_reads_staged_bytes_and_refuses_writes_and_escape() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp.path().join("stage");
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join("site.zip"), b"deployment snapshot").unwrap();
        std::fs::write(temp.path().join("outside.txt"), b"private").unwrap();
        let factory = StagingFactory::new(stage.to_str().unwrap()).unwrap();
        let mut backend = StagingBackend {
            native: factory.native.build(),
            prefix: factory.prefix,
        };
        backend.restore_drive(1).unwrap();
        let opened = open(&mut backend, r"\site.zip", 0x0010_0081);
        assert_eq!(status(&opened), u32::from(NtStatus::SUCCESS));
        let file_id = u32::from_le_bytes(opened[16..20].try_into().unwrap());
        let read = backend
            .handle_drive_io_request(ServerDriveIoRequest::DeviceReadRequest(DeviceReadRequest {
                device_io_request: request(file_id, MajorFunction::Read),
                length: 1024,
                offset: 0,
            }))
            .unwrap()[0]
            .encode_unframed_pdu()
            .unwrap();
        assert_eq!(status(&read), u32::from(NtStatus::SUCCESS));
        assert_eq!(&read[20..], b"deployment snapshot");
        assert_ne!(
            status(&open(&mut backend, r"\site.zip", 2)),
            u32::from(NtStatus::SUCCESS)
        );
        assert_ne!(
            status(&open(&mut backend, r"\..\outside.txt", 1)),
            u32::from(NtStatus::SUCCESS)
        );
        assert_ne!(
            status(&open(&mut backend, r"\outside.txt", 1)),
            u32::from(NtStatus::SUCCESS)
        );
        let root = open(&mut backend, r"\", 0x0010_0081);
        assert_eq!(status(&root), u32::from(NtStatus::SUCCESS));
        let root_id = u32::from_le_bytes(root[16..20].try_into().unwrap());
        let query = |path: &str| {
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(
                ServerDriveQueryDirectoryRequest {
                    device_io_request: request(root_id, MajorFunction::DirectoryControl),
                    file_info_class_lvl: FileInformationClassLevel::FILE_NAMES_INFORMATION,
                    initial_query: 1,
                    path: path.into(),
                },
            )
        };
        let listed = backend
            .handle_drive_io_request(query(r"\site.zip"))
            .unwrap()[0]
            .encode_unframed_pdu()
            .unwrap();
        assert_eq!(status(&listed), u32::from(NtStatus::SUCCESS));
        let outside = backend
            .handle_drive_io_request(query(r"\..\outside.txt"))
            .unwrap()[0]
            .encode_unframed_pdu()
            .unwrap();
        assert_eq!(status(&outside), u32::from(NtStatus::ACCESS_DENIED));
        assert_eq!(
            std::fs::read(stage.join("site.zip")).unwrap(),
            b"deployment snapshot"
        );
    }
    #[test]
    fn confines_opens_and_directory_queries() {
        assert_eq!(
            confined_path("Temp\\stage", r"\bundle.zip", false).unwrap(),
            r"\Temp\stage\bundle.zip"
        );
        assert_eq!(
            confined_path("Temp\\stage", r"\*", true).unwrap(),
            r"\Temp\stage\*"
        );
        assert_eq!(
            confined_path("Temp\\stage", "", true).unwrap(),
            r"\Temp\stage\*"
        );
        for path in [
            r"\..\secret",
            r"\\server\share",
            "C:\\secret",
            "/secret",
            "a\\..\\b",
            "a:stream",
            "a\\",
            "a.",
            "a ",
            "a\nb",
        ] {
            assert!(
                confined_path("Temp\\stage", path, true).is_none(),
                "{path:?}"
            );
        }
    }
}
