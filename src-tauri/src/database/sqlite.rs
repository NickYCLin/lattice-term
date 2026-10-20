use super::drivers::failed;
use rusqlite::{params_from_iter, Connection, OpenFlags};

pub(super) struct ReadOnlyConnection(Option<Connection>);

impl ReadOnlyConnection {
    pub(super) async fn open(path: String) -> Result<Self, String> {
        tokio::task::spawn_blocking(move || {
            let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| failed())?;
            connection
                .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
                .map_err(|_| failed())?;
            Ok(Self(Some(connection)))
        })
        .await
        .map_err(|_| failed())?
    }

    pub(super) async fn query(
        &mut self,
        statement: &str,
        parameters: &[&str],
    ) -> Result<Vec<Vec<Option<String>>>, String> {
        let connection = self.0.take().ok_or_else(failed)?;
        let statement = statement.to_owned();
        let parameters: Vec<String> = parameters.iter().map(|value| (*value).to_owned()).collect();
        let (connection, result) = tokio::task::spawn_blocking(move || {
            let result = (|| {
                let mut prepared = connection.prepare(&statement)?;
                let column_count = prepared.column_count();
                let rows = prepared.query_map(params_from_iter(&parameters), |row| {
                    (0..column_count).map(|index| row.get(index)).collect()
                })?;
                rows.collect::<rusqlite::Result<Vec<Vec<Option<String>>>>>()
            })();
            (connection, result)
        })
        .await
        .map_err(|_| failed())?;
        self.0 = Some(connection);
        result.map_err(|_| failed())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_bound_unicode_and_nulls_but_rejects_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("readonly.sqlite");
        let writable = Connection::open(&path).unwrap();
        writable
            .execute_batch("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES (NULL);")
            .unwrap();
        drop(writable);
        let mut reader = ReadOnlyConnection::open(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(
            reader
                .query("SELECT value, ? FROM sample", &["繁體中文🙂' OR 1=1"])
                .await
                .unwrap(),
            vec![vec![None, Some("繁體中文🙂' OR 1=1".into())]]
        );
        assert!(reader
            .query("INSERT INTO sample VALUES ('unexpected')", &[])
            .await
            .is_err());
        assert!(reader.query("PRAGMA query_only = OFF", &[]).await.is_ok());
        assert!(reader.query("DELETE FROM sample", &[]).await.is_err());
        assert_eq!(
            reader
                .query("SELECT CAST(count(*) AS TEXT) FROM sample", &[])
                .await
                .unwrap(),
            vec![vec![Some("1".into())]]
        );
        assert_eq!(
            reader
                .query(
                    "SELECT CAST(trusted_schema AS TEXT) FROM pragma_trusted_schema",
                    &[]
                )
                .await
                .unwrap(),
            vec![vec![Some("0".into())]]
        );
        assert_eq!(reader.query("SELECT name, type FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid LIMIT 65", &["sample"]).await.unwrap(), vec![vec![Some("value".into()), Some("TEXT".into())]]);
        assert!(reader
            .query("SELECT load_extension(?)", &["not-an-extension"])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn missing_database_is_not_created() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.sqlite");
        assert!(
            ReadOnlyConnection::open(path.to_string_lossy().into_owned())
                .await
                .is_err()
        );
        assert!(!path.exists());
    }
}
