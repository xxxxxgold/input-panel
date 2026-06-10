use anyhow::Result;

use crate::infrastructure::files::AppPaths;
use crate::infrastructure::sqlite::Database;

#[derive(Clone)]
pub struct AppContext {
    pub paths: AppPaths,
    pub db: Database,
}

impl AppContext {
    pub fn resolve() -> Result<Self> {
        let paths = AppPaths::resolve()?;
        paths.ensure()?;
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect()?;
        Ok(Self { paths, db })
    }
}
