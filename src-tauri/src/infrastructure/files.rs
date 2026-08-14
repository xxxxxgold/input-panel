use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const DATABASE_FILE_NAME: &str = "config.sqlite";
pub const LEGACY_DATABASE_FILE_NAME: &str = "config.db";
pub const STORAGE_BOOTSTRAP_FILE_NAME: &str = "storage.json";
pub const RUNTIME_COORDINATION_DATABASE_FILE_NAME: &str = "runtime-coordination.sqlite";
const STORAGE_BOOTSTRAP_VERSION: u32 = 1;

/// 当前后端实例使用的持久化目录范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeScope {
    Web,
    Desktop,
    Isolated,
}

impl RuntimeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Desktop => "desktop",
            Self::Isolated => "isolated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageBootstrap {
    version: u32,
    database_directory: PathBuf,
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub coordination_root: PathBuf,
    pub coordination_db_path: PathBuf,
    pub config_dir: PathBuf,
    pub db_path: PathBuf,
    pub storage_config_path: PathBuf,
    pub runtime_scope: RuntimeScope,
    pub user_directory: PathBuf,
    pub program_directory: PathBuf,
    pub override_active: bool,
    pub storage_configured: bool,
}

impl AppPaths {
    /// 解析浏览器调试后端的固定用户目录配置。
    pub fn resolve_web() -> Result<Self> {
        let program_directory = env::current_dir().context("无法解析后端启动目录")?;
        Self::resolve_for_runtime_scope(RuntimeScope::Web, program_directory)
    }

    /// 解析桌面应用的固定用户目录配置。
    pub fn resolve_desktop() -> Result<Self> {
        let exe = env::current_exe().context("无法解析当前可执行文件路径")?;
        let program_directory = exe
            .parent()
            .map(Path::to_path_buf)
            .context("无法解析程序目录")?;
        Self::resolve_for_runtime_scope(RuntimeScope::Desktop, program_directory)
    }

    pub fn resolve() -> Result<Self> {
        if let Ok(root) = env::var("SUB2API_APP_ROOT") {
            return Self::from_root(PathBuf::from(root)).with_coordination_override();
        }

        if cfg!(debug_assertions) {
            let cwd = env::current_dir().context("无法解析当前工作目录")?;
            return Self::from_root(cwd).with_coordination_override();
        }

        let exe = env::current_exe().context("无法解析当前可执行文件路径")?;
        let root = exe
            .parent()
            .map(Path::to_path_buf)
            .context("无法解析应用根目录")?;
        Self::from_root(root).with_coordination_override()
    }

    fn resolve_for_runtime_scope(
        runtime_scope: RuntimeScope,
        program_directory: PathBuf,
    ) -> Result<Self> {
        if let Ok(root) = env::var("SUB2API_APP_ROOT") {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                bail!("SUB2API_APP_ROOT 必须是绝对路径。");
            }
            return Self::from_isolated_root(root, program_directory).with_coordination_override();
        }

        let user_home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .context("无法解析当前用户目录")?;
        Self::from_user_scope(user_home, runtime_scope, program_directory)?
            .with_coordination_override()
    }

    fn from_user_scope(
        user_home: PathBuf,
        runtime_scope: RuntimeScope,
        program_directory: PathBuf,
    ) -> Result<Self> {
        let root = user_home.join("input_panel");
        let coordination_root = root.join("coordination");
        let scope_directory = match runtime_scope {
            RuntimeScope::Web => "web",
            RuntimeScope::Desktop => "exe",
            RuntimeScope::Isolated => "config",
        };
        let config_dir = root.join(scope_directory);
        let storage_config_path = config_dir.join(STORAGE_BOOTSTRAP_FILE_NAME);
        let (database_directory, storage_configured) =
            read_storage_directory(&storage_config_path, &config_dir)?;
        Ok(Self {
            root,
            coordination_db_path: coordination_root.join(RUNTIME_COORDINATION_DATABASE_FILE_NAME),
            coordination_root,
            config_dir,
            db_path: database_directory.join(DATABASE_FILE_NAME),
            storage_config_path,
            runtime_scope,
            user_directory: database_directory_for_scope(&user_home, runtime_scope),
            program_directory,
            override_active: false,
            storage_configured,
        })
    }

    pub fn from_root(root: PathBuf) -> Self {
        Self::from_isolated_root(root.clone(), root)
    }

    fn from_isolated_root(root: PathBuf, program_directory: PathBuf) -> Self {
        let config_dir = root.join("config");
        let coordination_root = root.join("coordination");
        let db_path = config_dir.join(DATABASE_FILE_NAME);
        Self {
            root,
            coordination_db_path: coordination_root.join(RUNTIME_COORDINATION_DATABASE_FILE_NAME),
            coordination_root,
            storage_config_path: config_dir.join(STORAGE_BOOTSTRAP_FILE_NAME),
            user_directory: config_dir.clone(),
            config_dir,
            db_path,
            runtime_scope: RuntimeScope::Isolated,
            program_directory,
            override_active: true,
            storage_configured: false,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("无法创建配置目录 {}", self.config_dir.display()))?;
        let database_directory = self.db_path.parent().context("数据库路径缺少父目录")?;
        fs::create_dir_all(database_directory)
            .with_context(|| format!("无法创建数据库存储目录 {}", database_directory.display()))?;
        fs::create_dir_all(&self.coordination_root).with_context(|| {
            format!("无法创建共享协调目录 {}", self.coordination_root.display())
        })?;
        Ok(())
    }

    fn with_coordination_override(mut self) -> Result<Self> {
        let override_root = env::var_os("SUB2API_COORDINATION_ROOT").map(PathBuf::from);
        self.coordination_root = select_coordination_root(self.coordination_root, override_root)?;
        self.coordination_db_path = self
            .coordination_root
            .join(RUNTIME_COORDINATION_DATABASE_FILE_NAME);
        Ok(self)
    }

    /// 旧扩展数据库仅在默认目录升级，避免误迁移其他 runtime 的文件。
    pub fn legacy_db_path(&self) -> Option<PathBuf> {
        if self.storage_configured {
            return None;
        }
        Some(self.config_dir.join(LEGACY_DATABASE_FILE_NAME))
    }

    pub fn current_directory(&self) -> Result<&Path> {
        self.db_path.parent().context("数据库路径缺少父目录")
    }

    /// 校验用户输入的迁移目录并返回规范化绝对路径。
    pub fn validate_target_directory(&self, target_directory: &Path) -> Result<PathBuf> {
        if self.override_active {
            bail!("SUB2API_APP_ROOT 已生效，当前运行实例不允许修改数据库目录。");
        }
        if !target_directory.is_absolute() {
            bail!("数据库存储目录必须是绝对路径。");
        }

        fs::create_dir_all(target_directory)
            .with_context(|| format!("无法创建数据库存储目录 {}", target_directory.display()))?;
        let normalized = fs::canonicalize(target_directory)
            .with_context(|| format!("无法解析数据库存储目录 {}", target_directory.display()))?;
        let current_directory = self.current_directory()?;
        let current = fs::canonicalize(current_directory)
            .with_context(|| format!("无法解析当前数据库目录 {}", current_directory.display()))?;
        if normalized == current {
            bail!("目标目录与当前数据库目录相同，无需迁移。");
        }

        ensure_no_database_artifact_conflicts(&normalized, None)?;

        let probe_path = normalized.join(format!(
            ".input-panel-storage-probe-{}",
            uuid::Uuid::new_v4()
        ));
        let mut probe = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe_path)
            .with_context(|| format!("数据库存储目录不可写 {}", normalized.display()))?;
        probe.write_all(b"input-panel-storage-probe")?;
        probe.sync_all()?;
        drop(probe);
        fs::remove_file(&probe_path)
            .with_context(|| format!("无法清理数据库目录写入探针 {}", probe_path.display()))?;
        Ok(normalized)
    }

    /// 迁移验证完成后原子更新外置引导配置。
    pub fn write_storage_directory(&self, database_directory: &Path) -> Result<()> {
        if self.override_active {
            bail!("环境覆盖生效时不能更新 storage.json。");
        }
        let bootstrap = StorageBootstrap {
            version: STORAGE_BOOTSTRAP_VERSION,
            database_directory: database_directory.to_path_buf(),
        };
        let bytes = serde_json::to_vec_pretty(&bootstrap).context("无法序列化 storage.json")?;
        write_atomic(&self.storage_config_path, &bytes)
    }
}

/// 拒绝会与迁移目标或 SQLite sidecar 混淆的数据库文件。
pub(crate) fn ensure_no_database_artifact_conflicts(
    directory: &Path,
    allowed_staging: Option<&Path>,
) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("无法检查数据库存储目录 {}", directory.display()))?
    {
        let entry = entry?;
        let entry_path = entry.path();
        if allowed_staging.is_some_and(|allowed| entry_path == allowed) {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let is_protected = is_database_artifact(&entry_path, &file_name)?;
        if is_protected {
            bail!(
                "目标目录存在数据库冲突文件 {}，请改用不含数据库文件的目录。",
                entry_path.display()
            );
        }
    }
    Ok(())
}

/// 识别固定库名、常见 SQLite 扩展、sidecar 以及无扩展名的真实 SQLite 文件。
fn is_database_artifact(path: &Path, file_name: &str) -> Result<bool> {
    let normalized_name = file_name.to_ascii_lowercase();
    let is_fixed_artifact = matches!(
        normalized_name.as_str(),
        DATABASE_FILE_NAME
            | LEGACY_DATABASE_FILE_NAME
            | "config.sqlite-wal"
            | "config.sqlite-shm"
            | "config.sqlite-journal"
            | "config.db-wal"
            | "config.db-shm"
            | "config.db-journal"
    ) || normalized_name.starts_with("config.sqlite.migrating-");
    if is_fixed_artifact {
        return Ok(true);
    }
    if !path.is_file() {
        return Ok(false);
    }

    let has_database_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "db" | "db3" | "sqlite" | "sqlite3"
            )
        });
    let is_sidecar = ["-wal", "-shm", "-journal"]
        .iter()
        .any(|suffix| normalized_name.ends_with(suffix));
    if has_database_extension || is_sidecar {
        return Ok(true);
    }

    const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
    let mut file = File::open(path)
        .with_context(|| format!("无法读取目标目录文件以检查数据库冲突 {}", path.display()))?;
    let mut header = [0_u8; SQLITE_HEADER.len()];
    let bytes_read = file
        .read(&mut header)
        .with_context(|| format!("无法检查目标目录文件 {}", path.display()))?;
    Ok(bytes_read == SQLITE_HEADER.len() && header == *SQLITE_HEADER)
}

fn database_directory_for_scope(user_home: &Path, runtime_scope: RuntimeScope) -> PathBuf {
    let scope = match runtime_scope {
        RuntimeScope::Web => "web",
        RuntimeScope::Desktop => "exe",
        RuntimeScope::Isolated => "config",
    };
    user_home.join("input_panel").join(scope)
}

fn select_coordination_root(
    default_root: PathBuf,
    override_root: Option<PathBuf>,
) -> Result<PathBuf> {
    let Some(override_root) = override_root else {
        return Ok(default_root);
    };
    if !override_root.is_absolute() {
        bail!("SUB2API_COORDINATION_ROOT 必须是绝对路径。");
    }
    Ok(override_root)
}

fn read_storage_directory(path: &Path, default_directory: &Path) -> Result<(PathBuf, bool)> {
    if !path.exists() {
        return Ok((default_directory.to_path_buf(), false));
    }
    let bytes =
        fs::read(path).with_context(|| format!("无法读取数据库引导配置 {}", path.display()))?;
    let bootstrap: StorageBootstrap = serde_json::from_slice(&bytes)
        .with_context(|| format!("数据库引导配置损坏 {}", path.display()))?;
    if bootstrap.version != STORAGE_BOOTSTRAP_VERSION {
        bail!("不支持的数据库引导配置版本 {}。", bootstrap.version);
    }
    if !bootstrap.database_directory.is_absolute() {
        bail!("storage.json 中的 databaseDirectory 必须是绝对路径。");
    }
    let database_path = bootstrap.database_directory.join(DATABASE_FILE_NAME);
    let metadata = fs::metadata(&database_path).with_context(|| {
        format!(
            "storage.json 指向的数据库文件不存在 {}",
            database_path.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        bail!(
            "storage.json 指向的数据库文件无效 {}",
            database_path.display()
        );
    }
    Ok((bootstrap.database_directory, true))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("storage.json 缺少父目录")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("无法创建引导配置目录 {}", parent.display()))?;
    let temporary = parent.join(format!(
        "{}.tmp-{}",
        STORAGE_BOOTSTRAP_FILE_NAME,
        uuid::Uuid::new_v4()
    ));
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("无法创建临时引导配置 {}", temporary.display()))?;
        file.write_all(bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if write_result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        return Err(anyhow!(
            "无法原子更新 {}: {}",
            target.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target).with_context(|| format!("无法原子更新 {}", target.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "input-panel-storage-path-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn user_runtime_scopes_use_separate_fixed_database_paths() {
        let user_home = PathBuf::from(r"C:\Users\input-panel-test");

        let web = AppPaths::from_user_scope(
            user_home.clone(),
            RuntimeScope::Web,
            PathBuf::from(r"D:\web-runtime"),
        )
        .expect("resolve web scope");
        let desktop = AppPaths::from_user_scope(
            user_home,
            RuntimeScope::Desktop,
            PathBuf::from(r"D:\desktop-runtime"),
        )
        .expect("resolve desktop scope");

        assert_eq!(
            web.db_path,
            PathBuf::from(r"C:\Users\input-panel-test\input_panel\web\config.sqlite")
        );
        assert_eq!(
            desktop.db_path,
            PathBuf::from(r"C:\Users\input-panel-test\input_panel\exe\config.sqlite")
        );
        assert_ne!(web.db_path, desktop.db_path);
    }

    #[test]
    fn user_runtime_scopes_share_one_coordination_database() {
        let user_home = PathBuf::from(r"C:\Users\input-panel-test");
        let web = AppPaths::from_user_scope(
            user_home.clone(),
            RuntimeScope::Web,
            PathBuf::from(r"D:\web-runtime"),
        )
        .expect("resolve web scope");
        let desktop = AppPaths::from_user_scope(
            user_home,
            RuntimeScope::Desktop,
            PathBuf::from(r"D:\desktop-runtime"),
        )
        .expect("resolve desktop scope");

        assert_eq!(web.coordination_root, desktop.coordination_root);
        assert_eq!(web.coordination_db_path, desktop.coordination_db_path);
        assert_eq!(
            web.coordination_db_path,
            PathBuf::from(
                r"C:\Users\input-panel-test\input_panel\coordination\runtime-coordination.sqlite"
            )
        );
        assert_ne!(web.db_path, desktop.db_path);
    }

    #[test]
    fn isolated_root_keeps_coordination_inside_its_own_root() {
        let paths = AppPaths::from_root(PathBuf::from(r"D:\isolated-runtime"));

        assert_eq!(
            paths.coordination_db_path,
            PathBuf::from(r"D:\isolated-runtime\coordination\runtime-coordination.sqlite")
        );
    }

    #[test]
    fn coordination_override_must_be_absolute() {
        let error = select_coordination_root(
            PathBuf::from(r"D:\default-coordination"),
            Some(PathBuf::from("relative-coordination")),
        )
        .expect_err("relative coordination override must fail");

        assert!(error
            .to_string()
            .contains("SUB2API_COORDINATION_ROOT 必须是绝对路径"));
    }

    #[test]
    fn ensure_creates_coordination_directory() {
        let root = storage_test_root("coordination-directory");
        let paths = AppPaths::from_root(root.clone());

        paths.ensure().expect("ensure app paths");

        assert!(paths.coordination_root.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_root_keeps_legacy_isolated_layout() {
        let paths = AppPaths::from_root(PathBuf::from(r"D:\isolated-runtime"));

        assert_eq!(
            paths.db_path,
            PathBuf::from(r"D:\isolated-runtime\config\config.sqlite")
        );
        assert!(paths.override_active);
        assert_eq!(paths.runtime_scope, RuntimeScope::Isolated);
    }

    #[test]
    fn configured_storage_rejects_missing_database_file() {
        let user_home = storage_test_root("missing-target");
        let bootstrap_directory = user_home.join("input_panel").join("web");
        let target_directory = user_home.join("migrated-data");
        fs::create_dir_all(&bootstrap_directory).expect("create bootstrap directory");
        fs::create_dir_all(&target_directory).expect("create target directory");
        let bootstrap = StorageBootstrap {
            version: STORAGE_BOOTSTRAP_VERSION,
            database_directory: target_directory.clone(),
        };
        write_atomic(
            &bootstrap_directory.join(STORAGE_BOOTSTRAP_FILE_NAME),
            &serde_json::to_vec_pretty(&bootstrap).expect("serialize bootstrap"),
        )
        .expect("write bootstrap");

        let error = AppPaths::from_user_scope(
            user_home.clone(),
            RuntimeScope::Web,
            PathBuf::from(r"D:\web-runtime"),
        )
        .expect_err("missing configured database should fail closed");

        assert!(error.to_string().contains("数据库文件不存在"));
        let _ = fs::remove_dir_all(user_home);
    }

    #[test]
    fn configured_storage_resolves_existing_database_file() {
        let user_home = storage_test_root("existing-target");
        let bootstrap_directory = user_home.join("input_panel").join("exe");
        let target_directory = user_home.join("migrated-data");
        fs::create_dir_all(&bootstrap_directory).expect("create bootstrap directory");
        fs::create_dir_all(&target_directory).expect("create target directory");
        fs::write(
            target_directory.join(DATABASE_FILE_NAME),
            b"sqlite-placeholder",
        )
        .expect("seed configured database file");
        let bootstrap = StorageBootstrap {
            version: STORAGE_BOOTSTRAP_VERSION,
            database_directory: target_directory.clone(),
        };
        write_atomic(
            &bootstrap_directory.join(STORAGE_BOOTSTRAP_FILE_NAME),
            &serde_json::to_vec_pretty(&bootstrap).expect("serialize bootstrap"),
        )
        .expect("write bootstrap");

        let paths = AppPaths::from_user_scope(
            user_home.clone(),
            RuntimeScope::Desktop,
            PathBuf::from(r"D:\desktop-runtime"),
        )
        .expect("resolve configured storage");

        assert_eq!(paths.db_path, target_directory.join(DATABASE_FILE_NAME));
        assert!(paths.storage_configured);
        let _ = fs::remove_dir_all(user_home);
    }

    #[test]
    fn target_directory_rejects_database_artifacts() {
        for file_name in [
            LEGACY_DATABASE_FILE_NAME,
            "config.sqlite-wal",
            "config.sqlite-shm",
            "config.sqlite.migrating-stale",
            "other.sqlite",
            "customer.db",
            "other.sqlite-wal",
        ] {
            let directory = storage_test_root("artifact-conflict");
            fs::create_dir_all(&directory).expect("create target directory");
            fs::write(directory.join(file_name), b"conflict").expect("seed conflict artifact");

            let error = ensure_no_database_artifact_conflicts(&directory, None)
                .expect_err("database artifact should reject migration target");

            assert!(error.to_string().contains("数据库冲突文件"));
            let _ = fs::remove_dir_all(directory);
        }
    }

    #[test]
    fn target_directory_detects_sqlite_header_without_a_database_extension() {
        let directory = storage_test_root("header-conflict");
        fs::create_dir_all(&directory).expect("create target directory");
        fs::write(directory.join("opaque.data"), b"SQLite format 3\0payload")
            .expect("seed sqlite header");

        let error = ensure_no_database_artifact_conflicts(&directory, None)
            .expect_err("sqlite header should reject migration target");

        assert!(error.to_string().contains("数据库冲突文件"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn target_directory_allows_unrelated_regular_files() {
        let directory = storage_test_root("unrelated-file");
        fs::create_dir_all(&directory).expect("create target directory");
        fs::write(directory.join("readme.txt"), b"keep this file").expect("seed unrelated file");

        ensure_no_database_artifact_conflicts(&directory, None)
            .expect("unrelated file should not block migration");

        let _ = fs::remove_dir_all(directory);
    }
}
