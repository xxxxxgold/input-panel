use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub config_dir: PathBuf,
    pub db_path: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> Result<Self> {
        if let Ok(root) = env::var("SUB2API_APP_ROOT") {
            return Ok(Self::from_root(PathBuf::from(root)));
        }

        if cfg!(debug_assertions) {
            let cwd = env::current_dir().context("无法解析当前工作目录")?;
            return Ok(Self::from_root(cwd));
        }

        let exe = env::current_exe().context("无法解析当前可执行文件路径")?;
        let root = exe
            .parent()
            .map(Path::to_path_buf)
            .context("无法解析应用根目录")?;
        Ok(Self::from_root(root))
    }

    pub fn from_root(root: PathBuf) -> Self {
        let config_dir = root.join("config");
        let db_path = config_dir.join("config.db");
        Self {
            root,
            config_dir,
            db_path,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("无法创建配置目录 {}", self.config_dir.display()))?;
        Ok(())
    }
}
