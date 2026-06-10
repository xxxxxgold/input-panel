pub mod repositories;
pub mod schema;

use std::path::PathBuf;

use anyhow::Result;
use rusqlite::Connection;

#[derive(Debug, Clone)]
pub struct Database {
    db_path: PathBuf,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        schema::apply(&conn)?;
        Ok(conn)
    }

    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }
}
