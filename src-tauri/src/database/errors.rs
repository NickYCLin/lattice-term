//! Safe driver diagnostics. Inspect types/codes only; never format a driver
//! error, connection string, server message, or nested error source for IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    Connection,
    Authentication,
    DatabaseAccess,
    Tls,
    Other,
}

impl Failure {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Connection => "database.error.connection",
            Self::Authentication => "database.error.authentication",
            Self::DatabaseAccess => "database.error.databaseAccess",
            Self::Tls => "database.error.tls",
            Self::Other => "database.error.other",
        }
    }
}

pub(super) fn failed() -> String {
    Failure::Other.code().into()
}

fn sqlstate(code: Option<&str>) -> Failure {
    match code {
        Some("3D000" | "42501") => Failure::DatabaseAccess,
        Some("53300" | "57P03") => Failure::Connection,
        Some(value) if value.starts_with("28") => Failure::Authentication,
        Some(value) if value.starts_with("08") => Failure::Connection,
        _ => Failure::Other,
    }
}

fn mysql(number: u16, state: Option<&str>) -> Failure {
    match number {
        1045 | 1698 => Failure::Authentication,
        1044 | 1049 | 1142 | 1143 | 1227 => Failure::DatabaseAccess,
        1040 | 1042 | 1043 | 2002 | 2003 | 2005 | 2006 | 2013 => Failure::Connection,
        2026 => Failure::Tls,
        _ => sqlstate(state),
    }
}

fn sql_server(code: u32, state: u8) -> Failure {
    match code {
        // A valid login can fail because its requested database is unavailable
        // or because the login lacks access, not because its password is wrong.
        18456 if matches!(state, 11 | 12 | 38 | 46) => Failure::DatabaseAccess,
        18452 | 18456 | 18470 | 18486 | 18487 | 18488 => Failure::Authentication,
        229 | 230 | 262 | 297 | 911 | 916 | 4060 | 4064 | 15151 => Failure::DatabaseAccess,
        40613 => Failure::Connection,
        _ => Failure::Other,
    }
}

fn sqlite(code: i32) -> Failure {
    // Extended SQLite codes retain the primary error in their low byte.
    match code & 0xff {
        3 | 8 | 14 | 23 => Failure::DatabaseAccess,
        _ => Failure::Other,
    }
}

pub(super) trait SafeFailure {
    fn category(&self) -> Failure;
}

pub(super) fn driver_failed(error: impl SafeFailure) -> String {
    error.category().code().into()
}

impl SafeFailure for sqlx::Error {
    fn category(&self) -> Failure {
        match self {
            Self::Io(error) => error.category(),
            Self::PoolTimedOut => Failure::Connection,
            Self::Tls(_) => Failure::Tls,
            Self::Database(error) => {
                if let Some(error) = error.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                    return mysql(error.number(), error.code());
                }
                #[cfg(not(target_os = "ios"))]
                if let Some(error) = error.try_downcast_ref::<sqlx::sqlite::SqliteError>() {
                    use sqlx::error::DatabaseError;
                    return error
                        .code()
                        .and_then(|value| value.parse().ok())
                        .map_or(Failure::Other, sqlite);
                }
                sqlstate(error.code().as_deref())
            }
            _ => Failure::Other,
        }
    }
}

impl SafeFailure for tiberius::error::Error {
    fn category(&self) -> Failure {
        match self {
            Self::Io { .. } => Failure::Connection,
            Self::Tls(_) => Failure::Tls,
            Self::Server(error) => sql_server(error.code(), error.state()),
            _ => Failure::Other,
        }
    }
}

impl SafeFailure for std::io::Error {
    fn category(&self) -> Failure {
        // SQLx rustls handshakes can surface as Io(InvalidData), retaining the
        // typed rustls error. Inspect types only; never parse Display strings.
        let mut source = self.get_ref().map(|error| error as &dyn std::error::Error);
        for _ in 0..8 {
            let Some(error) = source else { break };
            if error.is::<rustls::Error>() {
                return Failure::Tls;
            }
            source = if let Some(io) = error.downcast_ref::<std::io::Error>() {
                io.get_ref().map(|inner| inner as &dyn std::error::Error)
            } else {
                error.source()
            };
        }
        Failure::Connection
    }
}
impl SafeFailure for std::string::FromUtf8Error {
    fn category(&self) -> Failure {
        Failure::Other
    }
}

#[cfg(any(target_os = "ios", test))]
impl SafeFailure for rusqlite::Error {
    fn category(&self) -> Failure {
        match self {
            Self::SqliteFailure(error, _) => sqlite(error.extended_code),
            _ => Failure::Other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{borrow::Cow, error::Error, fmt};

    #[derive(Debug)]
    struct FakeDatabaseError(&'static str);
    impl fmt::Display for FakeDatabaseError {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("must never format server errors")
        }
    }
    impl Error for FakeDatabaseError {}
    impl sqlx::error::DatabaseError for FakeDatabaseError {
        fn message(&self) -> &str {
            panic!("must never inspect server messages")
        }
        fn code(&self) -> Option<Cow<'_, str>> {
            Some(self.0.into())
        }
        fn as_error(&self) -> &(dyn Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    #[test]
    fn sqlx_states_use_codes_without_touching_server_text() {
        for (code, category) in [
            ("28P01", Failure::Authentication),
            ("28000", Failure::Authentication),
            ("3D000", Failure::DatabaseAccess),
            ("42501", Failure::DatabaseAccess),
            ("08001", Failure::Connection),
            ("08006", Failure::Connection),
            ("53300", Failure::Connection),
            ("57P03", Failure::Connection),
            ("42601", Failure::Other),
            ("42000", Failure::Other),
            ("HY000", Failure::Other),
        ] {
            assert_eq!(
                driver_failed(sqlx::Error::Database(Box::new(FakeDatabaseError(code)))),
                category.code()
            );
        }
    }

    #[test]
    fn vendor_codes_distinguish_authentication_from_database_permissions() {
        for number in [1045, 1698] {
            assert_eq!(mysql(number, None), Failure::Authentication);
        }
        for number in [1044, 1049, 1142, 1143, 1227] {
            assert_eq!(mysql(number, Some("42000")), Failure::DatabaseAccess);
        }
        for number in [1040, 2002, 2003, 2005, 2006, 2013] {
            assert_eq!(mysql(number, None), Failure::Connection);
        }
        assert_eq!(mysql(2026, None), Failure::Tls);
        assert_eq!(mysql(1064, Some("42000")), Failure::Other);
        assert_eq!(sql_server(18456, 8), Failure::Authentication);
        for state in [11, 12, 38, 46] {
            assert_eq!(sql_server(18456, state), Failure::DatabaseAccess);
        }
        for code in [229, 911, 916, 4060, 4064] {
            assert_eq!(sql_server(code, 1), Failure::DatabaseAccess);
        }
        assert_eq!(sql_server(40613, 1), Failure::Connection);
        assert_eq!(sql_server(102, 1), Failure::Other);
        for code in [3, 8, 14, 23, 14 | (2 << 8)] {
            assert_eq!(sqlite(code), Failure::DatabaseAccess);
        }
        assert_eq!(sqlite(1), Failure::Other);
    }

    #[test]
    fn transport_tls_and_unknown_failures_never_return_sensitive_payloads() {
        const SENTINEL: &str = "REDACTION_SENTINEL host=example.invalid password=NOT_A_REAL_SECRET";
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::ConnectionRefused,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::NotFound,
            std::io::ErrorKind::Other,
        ] {
            assert_eq!(
                driver_failed(sqlx::Error::Io(std::io::Error::new(kind, SENTINEL))),
                Failure::Connection.code()
            );
            assert_eq!(
                driver_failed(tiberius::error::Error::Io {
                    kind,
                    message: SENTINEL.into()
                }),
                Failure::Connection.code()
            );
        }
        assert_eq!(
            driver_failed(sqlx::Error::PoolTimedOut),
            Failure::Connection.code()
        );
        assert_eq!(
            driver_failed(sqlx::Error::Tls(SENTINEL.into())),
            Failure::Tls.code()
        );
        assert_eq!(
            driver_failed(tiberius::error::Error::Tls(SENTINEL.into())),
            Failure::Tls.code()
        );
        assert_eq!(
            driver_failed(sqlx::Error::Protocol(SENTINEL.into())),
            Failure::Other.code()
        );
        assert_eq!(
            driver_failed(tiberius::error::Error::Protocol(SENTINEL.into())),
            Failure::Other.code()
        );
        assert_eq!(failed(), Failure::Other.code());
    }

    #[test]
    fn rustls_certificate_errors_wrapped_in_io_still_report_tls() {
        let io = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
        );
        assert_eq!(driver_failed(sqlx::Error::Io(io)), Failure::Tls.code());
    }

    #[cfg(not(target_os = "ios"))]
    #[tokio::test]
    async fn missing_sqlite_file_is_access_failure_without_exposing_its_path() {
        use sqlx::{ConnectOptions, Connection};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("REDACTION_SENTINEL.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true)
            .create_if_missing(false)
            .disable_statement_logging();
        let error = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap_err();
        assert_eq!(driver_failed(error), Failure::DatabaseAccess.code());
        assert!(!path.exists());
        let error = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap_err();
        assert_eq!(driver_failed(error), Failure::DatabaseAccess.code());
    }
}
