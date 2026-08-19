use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

use anyhow::Result;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::contracts::{
    AppLaunchMode, CloseBehavior, DesktopUiPrefs, DesktopUiPrefsPatch, FloatingNotificationDensity,
    FloatingNotificationSoundSource, DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME,
};
use crate::infrastructure::{notification_sound, sqlite::repositories};

use super::AppContext;

const DESKTOP_UI_PREFS_KEY: &str = "desktop_ui_prefs";
const MIN_AUTO_REFRESH_INTERVAL_SECONDS: i64 = 1;
const MIN_FLOATING_PANEL_OPACITY: f64 = 0.45;
const MAX_FLOATING_PANEL_OPACITY: f64 = 0.95;
pub(crate) const MIN_FLOATING_NOTIFICATION_DURATION_MS: i64 = 3_000;
pub(crate) const MAX_FLOATING_NOTIFICATION_DURATION_MS: i64 = 30_000;
pub(crate) const MIN_FLOATING_NOTIFICATION_SOUND_VOLUME: i64 = 0;
pub(crate) const MAX_FLOATING_NOTIFICATION_SOUND_VOLUME: i64 = 100;
pub(crate) const DEFAULT_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS: i64 = 4_500;
pub(crate) const MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS: i64 = 1_000;
pub(crate) const MAX_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS: i64 = 30_000;

fn desktop_ui_prefs_update_lock() -> &'static Mutex<()> {
    static UPDATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    UPDATE_LOCK.get_or_init(|| Mutex::new(()))
}

fn normalize_theme(value: String) -> String {
    match value.as_str() {
        "titan-noir" | "arctic-relay" | "ember-circuit" | "verdant-core" | "sakura-signal" => value,
        _ => "sakura-signal".into(),
    }
}

fn normalize_floating_panel_opacity(value: f64) -> f64 {
    if !value.is_finite() {
        return DesktopUiPrefs::default().floating_panel_opacity;
    }
    value.clamp(MIN_FLOATING_PANEL_OPACITY, MAX_FLOATING_PANEL_OPACITY)
}

fn normalize_overview_account_runtime_timeout_ms(value: i64) -> i64 {
    value.clamp(
        MIN_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS,
        MAX_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS,
    )
}

fn normalize_floating_notification_duration_ms(value: i64) -> i64 {
    value.clamp(
        MIN_FLOATING_NOTIFICATION_DURATION_MS,
        MAX_FLOATING_NOTIFICATION_DURATION_MS,
    )
}

fn normalize_floating_notification_density(
    value: FloatingNotificationDensity,
) -> FloatingNotificationDensity {
    value
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FloatingNotificationDensityLayout {
    pub compact_height: i32,
    pub usage_height: i32,
    pub gap: i32,
    pub vertical_padding: i32,
}

#[derive(Debug, Deserialize)]
struct FloatingNotificationVisibleRange {
    min: i64,
    max: i64,
}

#[derive(Debug, Deserialize)]
struct FloatingNotificationDensityLayouts {
    compact: FloatingNotificationDensityLayout,
    standard: FloatingNotificationDensityLayout,
    relaxed: FloatingNotificationDensityLayout,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FloatingNotificationLayoutConfig {
    max_visible: FloatingNotificationVisibleRange,
    densities: FloatingNotificationDensityLayouts,
}

fn floating_notification_layout_config() -> &'static FloatingNotificationLayoutConfig {
    static CONFIG: OnceLock<FloatingNotificationLayoutConfig> = OnceLock::new();
    CONFIG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/shared/lib/floating-notification-layout.json"
        ))
        .expect("floating notification layout config must be valid JSON")
    })
}

pub(crate) fn floating_notification_density_layout(
    density: &FloatingNotificationDensity,
) -> FloatingNotificationDensityLayout {
    let densities = &floating_notification_layout_config().densities;
    match density {
        FloatingNotificationDensity::Compact => densities.compact,
        FloatingNotificationDensity::Standard => densities.standard,
        FloatingNotificationDensity::Relaxed => densities.relaxed,
    }
}

pub(crate) fn normalize_floating_notification_max_visible(value: i64) -> i64 {
    let range = &floating_notification_layout_config().max_visible;
    value.clamp(range.min, range.max)
}

pub(crate) fn normalize_floating_notification_sound_volume(value: i64) -> i64 {
    value.clamp(
        MIN_FLOATING_NOTIFICATION_SOUND_VOLUME,
        MAX_FLOATING_NOTIFICATION_SOUND_VOLUME,
    )
}

fn normalize_floating_notification_sound_config(prefs: &mut DesktopUiPrefs) {
    prefs.floating_notification_sound_volume =
        normalize_floating_notification_sound_volume(prefs.floating_notification_sound_volume);
    let storage_key = prefs
        .floating_notification_sound_storage_key
        .as_deref()
        .filter(|value| notification_sound::is_valid_custom_notification_sound_storage_key(value))
        .map(str::to_owned);
    let display_name = prefs
        .floating_notification_sound_file_name
        .as_deref()
        .and_then(|value| Path::new(value.trim()).file_name())
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    match (
        prefs.floating_notification_sound_source.clone(),
        storage_key.zip(display_name),
    ) {
        (FloatingNotificationSoundSource::Custom, Some((storage_key, display_name))) => {
            prefs.floating_notification_sound_storage_key = Some(storage_key);
            prefs.floating_notification_sound_file_name = Some(display_name);
        }
        (FloatingNotificationSoundSource::Custom, None) => {
            prefs.floating_notification_sound_source = FloatingNotificationSoundSource::Default;
            prefs.floating_notification_sound_file_name = None;
            prefs.floating_notification_sound_storage_key = None;
        }
        (_, Some((storage_key, display_name))) => {
            // 切换系统提示音或静音时保留已导入副本，方便随后继续使用自定义音。
            prefs.floating_notification_sound_storage_key = Some(storage_key);
            prefs.floating_notification_sound_file_name = Some(display_name);
        }
        (_, None) => {
            prefs.floating_notification_sound_file_name = None;
            prefs.floating_notification_sound_storage_key = None;
        }
    }
}

fn normalize_prefs(mut prefs: DesktopUiPrefs) -> DesktopUiPrefs {
    prefs.version = 1;
    prefs.theme = normalize_theme(prefs.theme);
    prefs.floating_panel_opacity = normalize_floating_panel_opacity(prefs.floating_panel_opacity);
    prefs.floating_notification_duration_ms =
        normalize_floating_notification_duration_ms(prefs.floating_notification_duration_ms);
    prefs.floating_notification_density =
        normalize_floating_notification_density(prefs.floating_notification_density);
    prefs.floating_notification_max_visible =
        normalize_floating_notification_max_visible(prefs.floating_notification_max_visible);
    normalize_floating_notification_sound_config(&mut prefs);
    prefs.auto_refresh_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_interval_seconds);
    prefs.auto_refresh_core_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_core_interval_seconds);
    prefs.auto_refresh_keys_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_keys_interval_seconds);
    prefs.auto_refresh_usage_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_usage_interval_seconds);
    prefs.overview_account_runtime_timeout_ms =
        normalize_overview_account_runtime_timeout_ms(prefs.overview_account_runtime_timeout_ms);
    prefs
}

fn normalize_auto_refresh_interval_seconds(value: i64) -> i64 {
    value.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS)
}

/// 旧版本或异常写入的声音字段不能让整份桌面偏好回退默认值。
fn parse_persisted_desktop_ui_prefs(value: &str) -> Option<DesktopUiPrefs> {
    let mut value = serde_json::from_str::<serde_json::Value>(value).ok()?;
    let object = value.as_object_mut()?;
    const SOURCE_KEY: &str = "floatingNotificationSoundSource";
    const FILE_NAME_KEY: &str = "floatingNotificationSoundFileName";
    const STORAGE_KEY: &str = "floatingNotificationSoundStorageKey";
    const VOLUME_KEY: &str = "floatingNotificationSoundVolume";

    let source_is_invalid = object.contains_key(SOURCE_KEY)
        && !matches!(
            object.get(SOURCE_KEY).and_then(serde_json::Value::as_str),
            Some("default" | "custom" | "system" | "muted")
        );
    if source_is_invalid {
        object.insert(
            SOURCE_KEY.to_string(),
            serde_json::Value::String("default".to_string()),
        );
    }

    for key in [FILE_NAME_KEY, STORAGE_KEY] {
        let value_is_invalid = object
            .get(key)
            .is_some_and(|field| !field.is_null() && !field.is_string());
        if value_is_invalid {
            object.insert(key.to_string(), serde_json::Value::Null);
        }
    }

    let volume_is_invalid = object
        .get(VOLUME_KEY)
        .is_some_and(|field| field.as_i64().is_none());
    if volume_is_invalid {
        object.insert(
            VOLUME_KEY.to_string(),
            serde_json::Value::from(DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME),
        );
    }

    serde_json::from_value(value).ok()
}

pub fn get_desktop_ui_prefs(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    let prefs = repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)?
        .and_then(|value| parse_persisted_desktop_ui_prefs(&value))
        .map(normalize_prefs)
        .unwrap_or_default();
    Ok(prefs)
}

pub fn update_desktop_ui_prefs(
    ctx: &AppContext,
    patch: DesktopUiPrefsPatch,
) -> Result<DesktopUiPrefs> {
    let _update_guard = desktop_ui_prefs_update_lock()
        .lock()
        .map_err(|_| anyhow::anyhow!("桌面偏好更新锁不可用"))?;
    let mut prefs = get_desktop_ui_prefs(ctx)?;
    if let Some(value) = patch.launch_mode {
        prefs.launch_mode = value;
    }
    if let Some(value) = patch.open_floating_in_main_mode {
        prefs.open_floating_in_main_mode = value;
    }
    if let Some(value) = patch.keep_floating_panel_visible {
        prefs.keep_floating_panel_visible = value;
    }
    if let Some(value) = patch.floating_panel_opacity {
        prefs.floating_panel_opacity = normalize_floating_panel_opacity(value);
    }
    if let Some(value) = patch.floating_notification_duration_ms {
        prefs.floating_notification_duration_ms =
            normalize_floating_notification_duration_ms(value);
    }
    if let Some(value) = patch.floating_notification_density {
        prefs.floating_notification_density = normalize_floating_notification_density(value);
    }
    if let Some(value) = patch.floating_notification_max_visible {
        prefs.floating_notification_max_visible =
            normalize_floating_notification_max_visible(value);
    }
    if let Some(value) = patch.floating_notification_sound_volume {
        prefs.floating_notification_sound_volume =
            normalize_floating_notification_sound_volume(value);
    }
    if let Some(value) = patch.close_behavior {
        prefs.close_behavior = value;
    }
    if let Some(value) = patch.auto_refresh_enabled {
        prefs.auto_refresh_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_interval_seconds {
        prefs.auto_refresh_interval_seconds = normalize_auto_refresh_interval_seconds(value);
    }
    if let Some(value) = patch.auto_refresh_service_status_enabled {
        prefs.auto_refresh_service_status_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_core_enabled {
        prefs.auto_refresh_core_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_core_interval_seconds {
        prefs.auto_refresh_core_interval_seconds = normalize_auto_refresh_interval_seconds(value);
    }
    if let Some(value) = patch.auto_refresh_keys_enabled {
        prefs.auto_refresh_keys_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_keys_interval_seconds {
        prefs.auto_refresh_keys_interval_seconds = normalize_auto_refresh_interval_seconds(value);
    }
    if let Some(value) = patch.auto_refresh_usage_enabled {
        prefs.auto_refresh_usage_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_usage_interval_seconds {
        prefs.auto_refresh_usage_interval_seconds = normalize_auto_refresh_interval_seconds(value);
    }
    if let Some(value) = patch.overview_account_runtime_timeout_ms {
        prefs.overview_account_runtime_timeout_ms =
            normalize_overview_account_runtime_timeout_ms(value);
    }
    if let Some(value) = patch.theme {
        prefs.theme = normalize_theme(value);
    }
    prefs = normalize_prefs(prefs);
    repositories::set_setting(
        &ctx.db,
        DESKTOP_UI_PREFS_KEY,
        &serde_json::to_string(&prefs)?,
    )?;
    Ok(prefs)
}

/// 导入自定义提示音，并在同一偏好锁中切换来源，避免与音量自动保存发生竞态。
pub fn import_floating_notification_custom_sound(
    ctx: &AppContext,
    source_path: &Path,
) -> Result<DesktopUiPrefs> {
    let imported = notification_sound::import_custom_notification_sound(&ctx.paths, source_path)?;
    let imported_storage_key = imported.storage_key.clone();
    let updated = (|| -> Result<(DesktopUiPrefs, Option<String>)> {
        let _update_guard = desktop_ui_prefs_update_lock()
            .lock()
            .map_err(|_| anyhow::anyhow!("桌面偏好更新锁不可用"))?;
        let mut prefs = get_desktop_ui_prefs(ctx)?;
        let previous_storage_key = prefs.floating_notification_sound_storage_key.clone();
        prefs.floating_notification_sound_source = FloatingNotificationSoundSource::Custom;
        prefs.floating_notification_sound_file_name = Some(imported.display_name);
        prefs.floating_notification_sound_storage_key = Some(imported.storage_key);
        prefs = normalize_prefs(prefs);
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            &serde_json::to_string(&prefs)?,
        )?;
        Ok((prefs, previous_storage_key))
    })();

    match updated {
        Ok((prefs, previous_storage_key)) => {
            if let Some(previous_storage_key) = previous_storage_key {
                if previous_storage_key != imported_storage_key {
                    if let Err(error) = notification_sound::remove_custom_notification_sound(
                        &ctx.paths,
                        &previous_storage_key,
                    ) {
                        log::warn!("[notification-sound] 清理旧提示音副本失败: {error}");
                    }
                }
            }
            Ok(prefs)
        }
        Err(error) => {
            if let Err(cleanup_error) = notification_sound::remove_custom_notification_sound(
                &ctx.paths,
                &imported_storage_key,
            ) {
                log::warn!("[notification-sound] 回滚新提示音副本失败: {cleanup_error}");
            }
            Err(error)
        }
    }
}

/// 恢复内置提示音，并在偏好持久化成功后清理旧的自定义副本。
pub fn restore_default_floating_notification_sound(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    let (prefs, previous_storage_key) = {
        let _update_guard = desktop_ui_prefs_update_lock()
            .lock()
            .map_err(|_| anyhow::anyhow!("桌面偏好更新锁不可用"))?;
        let mut prefs = get_desktop_ui_prefs(ctx)?;
        let previous_storage_key = prefs.floating_notification_sound_storage_key.clone();
        prefs.floating_notification_sound_source = FloatingNotificationSoundSource::Default;
        prefs.floating_notification_sound_file_name = None;
        prefs.floating_notification_sound_storage_key = None;
        prefs = normalize_prefs(prefs);
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            &serde_json::to_string(&prefs)?,
        )?;
        (prefs, previous_storage_key)
    };

    if let Some(previous_storage_key) = previous_storage_key {
        if let Err(error) =
            notification_sound::remove_custom_notification_sound(&ctx.paths, &previous_storage_key)
        {
            log::warn!("[notification-sound] 清理旧提示音副本失败: {error}");
        }
    }
    Ok(prefs)
}

/// 当前声音启动结果。系统提示音由 Windows 异步排队，无需持有 Rodio 会话。
pub(crate) enum FloatingNotificationSoundStart {
    Audio(notification_sound::ActiveNotificationSound),
    System,
    Muted,
}

/// 仅切换不依赖文件路径的来源，保留受控自定义副本供用户之后继续使用。
fn set_floating_notification_non_custom_sound_source(
    ctx: &AppContext,
    source: FloatingNotificationSoundSource,
) -> Result<DesktopUiPrefs> {
    debug_assert!(matches!(
        source,
        FloatingNotificationSoundSource::System | FloatingNotificationSoundSource::Muted
    ));
    let _update_guard = desktop_ui_prefs_update_lock()
        .lock()
        .map_err(|_| anyhow::anyhow!("桌面偏好更新锁不可用"))?;
    let mut prefs = get_desktop_ui_prefs(ctx)?;
    prefs.floating_notification_sound_source = source;
    prefs = normalize_prefs(prefs);
    repositories::set_setting(
        &ctx.db,
        DESKTOP_UI_PREFS_KEY,
        &serde_json::to_string(&prefs)?,
    )?;
    Ok(prefs)
}

pub fn use_system_floating_notification_sound(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    set_floating_notification_non_custom_sound_source(ctx, FloatingNotificationSoundSource::System)
}

pub fn mute_floating_notification_sound(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    set_floating_notification_non_custom_sound_source(ctx, FloatingNotificationSoundSource::Muted)
}

/// 恢复仍保存在应用受控目录中的自定义提示音，不依赖原始选择文件。
pub fn use_saved_floating_notification_custom_sound(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    let _update_guard = desktop_ui_prefs_update_lock()
        .lock()
        .map_err(|_| anyhow::anyhow!("桌面偏好更新锁不可用"))?;
    let mut prefs = get_desktop_ui_prefs(ctx)?;
    let storage_key = prefs
        .floating_notification_sound_storage_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("没有已保存的自定义提示音"))?;
    let custom_path = notification_sound::custom_notification_sound_path(&ctx.paths, storage_key)?;
    if !custom_path.is_file() {
        anyhow::bail!("已保存的自定义提示音不可用");
    }

    prefs.floating_notification_sound_source = FloatingNotificationSoundSource::Custom;
    prefs = normalize_prefs(prefs);
    repositories::set_setting(
        &ctx.db,
        DESKTOP_UI_PREFS_KEY,
        &serde_json::to_string(&prefs)?,
    )?;
    Ok(prefs)
}

/// 启动当前来源和音量的提示音，并把文件音播放会话交给调用方持续持有。
pub(crate) fn start_floating_notification_sound(
    app: &AppHandle,
) -> Result<FloatingNotificationSoundStart> {
    let ctx = app.state::<AppContext>();
    let prefs = get_desktop_ui_prefs(&ctx)?;
    let source = prefs.floating_notification_sound_source.clone();
    let volume_percent =
        normalize_floating_notification_sound_volume(prefs.floating_notification_sound_volume);
    if volume_percent == 0 || source == FloatingNotificationSoundSource::Muted {
        return Ok(FloatingNotificationSoundStart::Muted);
    }
    if source == FloatingNotificationSoundSource::System {
        notification_sound::request_windows_system_notification_sound()?;
        return Ok(FloatingNotificationSoundStart::System);
    }

    let default_path = notification_sound::default_notification_sound_path(app)?;
    let custom_path = if source == FloatingNotificationSoundSource::Custom {
        prefs
            .floating_notification_sound_storage_key
            .as_deref()
            .map(|storage_key| {
                notification_sound::custom_notification_sound_path(&ctx.paths, storage_key)
            })
            .transpose()?
    } else {
        None
    };
    match notification_sound::start_notification_sound(default_path, custom_path, volume_percent)? {
        Some(playback) => Ok(FloatingNotificationSoundStart::Audio(playback)),
        None => Ok(FloatingNotificationSoundStart::Muted),
    }
}

fn play_floating_notification_sound(app: &AppHandle) -> Result<()> {
    match start_floating_notification_sound(app)? {
        FloatingNotificationSoundStart::Audio(playback) => playback.wait_until_end(),
        FloatingNotificationSoundStart::System | FloatingNotificationSoundStart::Muted => {}
    }
    Ok(())
}

/// 将新消息的声音准备与播放完全转入后台，不能阻塞 mailbox 或通知窗口同步。
pub fn schedule_floating_notification_sound(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = play_floating_notification_sound(&app) {
            log::warn!("[notification-sound] 新悬浮消息提示音播放失败: {error}");
        }
    });
}

pub fn set_launch_mode(ctx: &AppContext, launch_mode: AppLaunchMode) -> Result<DesktopUiPrefs> {
    update_desktop_ui_prefs(
        ctx,
        DesktopUiPrefsPatch {
            launch_mode: Some(launch_mode),
            ..DesktopUiPrefsPatch::default()
        },
    )
}

pub fn set_close_behavior(
    ctx: &AppContext,
    close_behavior: CloseBehavior,
) -> Result<DesktopUiPrefs> {
    update_desktop_ui_prefs(
        ctx,
        DesktopUiPrefsPatch {
            close_behavior: Some(close_behavior),
            ..DesktopUiPrefsPatch::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Barrier},
        thread,
    };

    use crate::{
        application::{resource_coordinator::ResourceCoordinator, AppContext},
        contracts::DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME,
        infrastructure::{
            files::AppPaths,
            sqlite::{repositories, Database},
        },
    };

    fn build_test_context() -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "input-panel-desktop-ui-prefs-tests-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure test app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize test sqlite");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            live_resources: ResourceCoordinator::default(),
            native_notifications_enabled: false,
        }
    }

    #[test]
    fn desktop_ui_prefs_default_disables_pinned_floating_panel() {
        let prefs = DesktopUiPrefs::default();
        let default_interval = prefs.auto_refresh_interval_seconds;

        assert_eq!(prefs.theme, "sakura-signal");
        assert!(!prefs.keep_floating_panel_visible);
        assert_eq!(prefs.floating_notification_duration_ms, 7_000);
        assert_eq!(
            prefs.floating_notification_density,
            FloatingNotificationDensity::Standard
        );
        assert_eq!(prefs.floating_notification_max_visible, 3);
        assert_eq!(
            prefs.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );
        assert_eq!(prefs.floating_notification_sound_file_name, None);
        assert_eq!(prefs.floating_notification_sound_storage_key, None);
        assert_eq!(
            prefs.floating_notification_sound_volume,
            DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME
        );
        assert!(prefs.auto_refresh_enabled);
        assert_eq!(prefs.auto_refresh_interval_seconds, default_interval);
        assert!(prefs.auto_refresh_service_status_enabled);
        assert!(prefs.auto_refresh_core_enabled);
        assert_eq!(prefs.auto_refresh_core_interval_seconds, default_interval);
        assert!(prefs.auto_refresh_keys_enabled);
        assert_eq!(prefs.auto_refresh_keys_interval_seconds, default_interval);
        assert!(prefs.auto_refresh_usage_enabled);
        assert_eq!(prefs.auto_refresh_usage_interval_seconds, default_interval);
        assert_eq!(
            prefs.overview_account_runtime_timeout_ms,
            DEFAULT_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS
        );
    }

    #[test]
    fn normalize_prefs_keeps_existing_pinned_flag() {
        let prefs = normalize_prefs(DesktopUiPrefs {
            version: 99,
            launch_mode: AppLaunchMode::Main,
            open_floating_in_main_mode: true,
            keep_floating_panel_visible: true,
            floating_panel_opacity: 0.2,
            floating_notification_duration_ms: 99_999,
            floating_notification_density: FloatingNotificationDensity::Relaxed,
            floating_notification_max_visible: 99,
            floating_notification_sound_source: FloatingNotificationSoundSource::Custom,
            floating_notification_sound_file_name: Some(r"C:\\Users\\demo\\tone.mp3".into()),
            floating_notification_sound_storage_key: Some("invalid-storage-key".into()),
            floating_notification_sound_volume: 999,
            close_behavior: CloseBehavior::Ask,
            auto_refresh_enabled: true,
            auto_refresh_interval_seconds: 0,
            auto_refresh_service_status_enabled: false,
            auto_refresh_core_enabled: false,
            auto_refresh_core_interval_seconds: 0,
            auto_refresh_keys_enabled: false,
            auto_refresh_keys_interval_seconds: 0,
            auto_refresh_usage_enabled: false,
            auto_refresh_usage_interval_seconds: 0,
            overview_account_runtime_timeout_ms: 99_999,
            theme: "invalid-theme".into(),
        });

        assert_eq!(prefs.version, 1);
        assert!(prefs.keep_floating_panel_visible);
        assert_eq!(prefs.floating_panel_opacity, MIN_FLOATING_PANEL_OPACITY);
        assert_eq!(
            prefs.floating_notification_duration_ms,
            MAX_FLOATING_NOTIFICATION_DURATION_MS
        );
        assert_eq!(
            prefs.floating_notification_density,
            FloatingNotificationDensity::Relaxed
        );
        assert_eq!(prefs.floating_notification_max_visible, 5);
        assert_eq!(
            prefs.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );
        assert_eq!(prefs.floating_notification_sound_file_name, None);
        assert_eq!(prefs.floating_notification_sound_storage_key, None);
        assert_eq!(
            prefs.floating_notification_sound_volume,
            MAX_FLOATING_NOTIFICATION_SOUND_VOLUME
        );
        assert_eq!(prefs.theme, "sakura-signal");
        assert_eq!(
            prefs.auto_refresh_interval_seconds,
            MIN_AUTO_REFRESH_INTERVAL_SECONDS
        );
        assert!(!prefs.auto_refresh_service_status_enabled);
        assert!(!prefs.auto_refresh_core_enabled);
        assert_eq!(
            prefs.auto_refresh_core_interval_seconds,
            MIN_AUTO_REFRESH_INTERVAL_SECONDS
        );
        assert!(!prefs.auto_refresh_keys_enabled);
        assert_eq!(
            prefs.auto_refresh_keys_interval_seconds,
            MIN_AUTO_REFRESH_INTERVAL_SECONDS
        );
        assert!(!prefs.auto_refresh_usage_enabled);
        assert_eq!(
            prefs.auto_refresh_usage_interval_seconds,
            MIN_AUTO_REFRESH_INTERVAL_SECONDS
        );
        assert_eq!(
            prefs.overview_account_runtime_timeout_ms,
            MAX_OVERVIEW_ACCOUNT_RUNTIME_TIMEOUT_MS
        );
    }

    #[test]
    fn legacy_desktop_ui_prefs_backfill_notification_defaults() {
        let legacy = serde_json::json!({
            "version": 1,
            "launchMode": "main",
            "openFloatingInMainMode": true,
            "keepFloatingPanelVisible": false,
            "floatingPanelOpacity": 0.82,
            "floatingNotificationDurationMs": 7000,
            "closeBehavior": "ask",
            "autoRefreshEnabled": true,
            "autoRefreshIntervalSeconds": 9,
            "theme": "titan-noir"
        });
        let prefs =
            normalize_prefs(serde_json::from_value(legacy).expect("legacy prefs deserialize"));

        assert_eq!(
            prefs.floating_notification_density,
            FloatingNotificationDensity::Standard
        );
        assert_eq!(prefs.floating_notification_max_visible, 3);
        assert_eq!(
            prefs.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );
        assert_eq!(
            prefs.floating_notification_sound_volume,
            DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME
        );
        assert_eq!(prefs.theme, "titan-noir");
    }

    #[test]
    fn invalid_persisted_sound_fields_do_not_reset_unrelated_preferences() {
        let ctx = build_test_context();
        let persisted = DesktopUiPrefs {
            launch_mode: AppLaunchMode::Floating,
            keep_floating_panel_visible: true,
            auto_refresh_enabled: false,
            auto_refresh_usage_interval_seconds: 27,
            theme: "ember-circuit".into(),
            ..DesktopUiPrefs::default()
        };
        let mut raw = serde_json::to_value(persisted).expect("serialize preferences");
        raw["floatingNotificationSoundSource"] = serde_json::json!("future-source");
        raw["floatingNotificationSoundFileName"] = serde_json::json!({ "invalid": true });
        raw["floatingNotificationSoundStorageKey"] = serde_json::json!(42);
        raw["floatingNotificationSoundVolume"] = serde_json::Value::Null;
        repositories::set_setting(&ctx.db, DESKTOP_UI_PREFS_KEY, &raw.to_string())
            .expect("store invalid sound preferences");

        let prefs = get_desktop_ui_prefs(&ctx).expect("read compatible preferences");

        assert_eq!(prefs.launch_mode, AppLaunchMode::Floating);
        assert!(prefs.keep_floating_panel_visible);
        assert!(!prefs.auto_refresh_enabled);
        assert_eq!(prefs.auto_refresh_usage_interval_seconds, 27);
        assert_eq!(prefs.theme, "ember-circuit");
        assert_eq!(
            prefs.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );
        assert_eq!(prefs.floating_notification_sound_file_name, None);
        assert_eq!(prefs.floating_notification_sound_storage_key, None);
        assert_eq!(
            prefs.floating_notification_sound_volume,
            DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME
        );
    }

    #[test]
    fn legacy_notification_prefs_are_backfilled_and_rewritten_as_normalized_json() {
        let ctx = build_test_context();
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            r#"{
                "version": 1,
                "launchMode": "main",
                "openFloatingInMainMode": true,
                "keepFloatingPanelVisible": false,
                "floatingPanelOpacity": 0.82,
                "floatingNotificationDurationMs": 7000,
                "closeBehavior": "ask",
                "autoRefreshEnabled": true,
                "autoRefreshIntervalSeconds": 9,
                "theme": "titan-noir"
            }"#,
        )
        .expect("store legacy preferences");

        let hydrated = get_desktop_ui_prefs(&ctx).expect("hydrate legacy preferences");
        assert_eq!(
            hydrated.floating_notification_density,
            FloatingNotificationDensity::Standard
        );
        assert_eq!(hydrated.floating_notification_max_visible, 3);
        assert_eq!(
            hydrated.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );
        assert_eq!(
            hydrated.floating_notification_sound_volume,
            DEFAULT_FLOATING_NOTIFICATION_SOUND_VOLUME
        );
        assert!(hydrated.auto_refresh_service_status_enabled);

        let updated = update_desktop_ui_prefs(
            &ctx,
            DesktopUiPrefsPatch {
                floating_notification_max_visible: Some(99),
                ..DesktopUiPrefsPatch::default()
            },
        )
        .expect("update preferences");
        assert_eq!(
            updated.floating_notification_density,
            FloatingNotificationDensity::Standard
        );
        assert_eq!(updated.floating_notification_max_visible, 5);

        let stored = repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)
            .expect("read rewritten preferences")
            .expect("stored preferences");
        let persisted: serde_json::Value =
            serde_json::from_str(&stored).expect("parse stored preferences");
        assert_eq!(persisted["floatingNotificationDensity"], "standard");
        assert_eq!(persisted["floatingNotificationMaxVisible"], 5);
        assert_eq!(persisted["floatingNotificationSoundSource"], "default");
        assert_eq!(persisted["floatingNotificationSoundVolume"], 100);
        assert_eq!(persisted["autoRefreshServiceStatusEnabled"], true);
    }

    #[test]
    fn concurrent_field_updates_preserve_both_last_writes() {
        let ctx = build_test_context();
        let barrier = Arc::new(Barrier::new(3));
        let service_ctx = ctx.clone();
        let service_barrier = Arc::clone(&barrier);
        let service_update = thread::spawn(move || {
            service_barrier.wait();
            update_desktop_ui_prefs(
                &service_ctx,
                DesktopUiPrefsPatch {
                    auto_refresh_service_status_enabled: Some(false),
                    ..DesktopUiPrefsPatch::default()
                },
            )
            .expect("persist service status preference");
        });
        let usage_ctx = ctx.clone();
        let usage_barrier = Arc::clone(&barrier);
        let usage_update = thread::spawn(move || {
            usage_barrier.wait();
            update_desktop_ui_prefs(
                &usage_ctx,
                DesktopUiPrefsPatch {
                    auto_refresh_usage_interval_seconds: Some(17),
                    ..DesktopUiPrefsPatch::default()
                },
            )
            .expect("persist usage interval");
        });

        barrier.wait();
        service_update
            .join()
            .expect("join service preference update");
        usage_update.join().expect("join usage preference update");

        let persisted = get_desktop_ui_prefs(&ctx).expect("read concurrent preferences");
        assert!(!persisted.auto_refresh_service_status_enabled);
        assert_eq!(persisted.auto_refresh_usage_interval_seconds, 17);
    }

    #[test]
    fn notification_visible_count_is_normalized_to_the_supported_range() {
        assert_eq!(normalize_floating_notification_max_visible(-1), 1);
        assert_eq!(normalize_floating_notification_max_visible(3), 3);
        assert_eq!(normalize_floating_notification_max_visible(9), 5);
    }

    #[test]
    fn notification_sound_volume_is_clamped_without_changing_the_selected_source() {
        let ctx = build_test_context();
        let updated = update_desktop_ui_prefs(
            &ctx,
            DesktopUiPrefsPatch {
                floating_notification_sound_volume: Some(-10),
                ..DesktopUiPrefsPatch::default()
            },
        )
        .expect("persist muted notification sound");
        assert_eq!(updated.floating_notification_sound_volume, 0);
        assert_eq!(
            updated.floating_notification_sound_source,
            FloatingNotificationSoundSource::Default
        );

        let updated = update_desktop_ui_prefs(
            &ctx,
            DesktopUiPrefsPatch {
                floating_notification_sound_volume: Some(120),
                ..DesktopUiPrefsPatch::default()
            },
        )
        .expect("persist maximum notification sound");
        assert_eq!(updated.floating_notification_sound_volume, 100);
    }

    #[test]
    fn system_and_muted_sound_sources_preserve_a_valid_custom_selection() {
        let ctx = build_test_context();
        let storage_key = "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3";
        let custom_prefs = DesktopUiPrefs {
            floating_notification_sound_source: FloatingNotificationSoundSource::Custom,
            floating_notification_sound_file_name: Some("custom-tone.mp3".into()),
            floating_notification_sound_storage_key: Some(storage_key.into()),
            ..DesktopUiPrefs::default()
        };
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            &serde_json::to_string(&custom_prefs).expect("serialize custom preferences"),
        )
        .expect("store custom preferences");

        let system = use_system_floating_notification_sound(&ctx)
            .expect("switch to system notification sound");
        assert_eq!(
            system.floating_notification_sound_source,
            FloatingNotificationSoundSource::System
        );
        assert_eq!(
            system.floating_notification_sound_storage_key.as_deref(),
            Some(storage_key)
        );

        let muted = mute_floating_notification_sound(&ctx).expect("mute notification sound");
        assert_eq!(
            muted.floating_notification_sound_source,
            FloatingNotificationSoundSource::Muted
        );
        assert_eq!(
            muted.floating_notification_sound_file_name.as_deref(),
            Some("custom-tone.mp3")
        );

        let volume_updated = update_desktop_ui_prefs(
            &ctx,
            DesktopUiPrefsPatch {
                floating_notification_sound_volume: Some(67),
                ..DesktopUiPrefsPatch::default()
            },
        )
        .expect("update muted notification volume");
        assert_eq!(
            volume_updated.floating_notification_sound_source,
            FloatingNotificationSoundSource::Muted
        );
        assert_eq!(volume_updated.floating_notification_sound_volume, 67);
    }

    #[test]
    fn saved_custom_sound_can_be_restored_after_system_and_muted() {
        let ctx = build_test_context();
        let storage_key = "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3";
        let controlled_path =
            notification_sound::custom_notification_sound_path(&ctx.paths, storage_key)
                .expect("resolve controlled custom sound path");
        fs::create_dir_all(controlled_path.parent().expect("controlled sound parent"))
            .expect("create controlled sound directory");
        fs::write(
            &controlled_path,
            include_bytes!("../../resources/sounds/manbo.mp3"),
        )
        .expect("retain controlled custom sound copy");
        let custom_prefs = DesktopUiPrefs {
            floating_notification_sound_source: FloatingNotificationSoundSource::Custom,
            floating_notification_sound_file_name: Some("custom-tone.mp3".into()),
            floating_notification_sound_storage_key: Some(storage_key.into()),
            ..DesktopUiPrefs::default()
        };
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            &serde_json::to_string(&custom_prefs).expect("serialize custom preferences"),
        )
        .expect("store custom preferences");

        use_system_floating_notification_sound(&ctx).expect("switch to system sound");
        mute_floating_notification_sound(&ctx).expect("mute notification sound");
        let restored = use_saved_floating_notification_custom_sound(&ctx)
            .expect("restore retained custom sound without the original file");

        assert_eq!(
            restored.floating_notification_sound_source,
            FloatingNotificationSoundSource::Custom
        );
        assert_eq!(
            restored.floating_notification_sound_file_name.as_deref(),
            Some("custom-tone.mp3")
        );
        assert_eq!(
            restored.floating_notification_sound_storage_key.as_deref(),
            Some(storage_key)
        );
        assert!(controlled_path.is_file());
    }

    #[test]
    fn missing_saved_custom_sound_keeps_the_current_non_custom_source() {
        let ctx = build_test_context();
        let storage_key = "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3";
        let custom_prefs = DesktopUiPrefs {
            floating_notification_sound_source: FloatingNotificationSoundSource::Custom,
            floating_notification_sound_file_name: Some("missing-tone.mp3".into()),
            floating_notification_sound_storage_key: Some(storage_key.into()),
            ..DesktopUiPrefs::default()
        };
        repositories::set_setting(
            &ctx.db,
            DESKTOP_UI_PREFS_KEY,
            &serde_json::to_string(&custom_prefs).expect("serialize custom preferences"),
        )
        .expect("store custom preferences");
        mute_floating_notification_sound(&ctx).expect("mute notification sound");

        let error = use_saved_floating_notification_custom_sound(&ctx)
            .expect_err("missing controlled custom sound must not switch source");
        let persisted = get_desktop_ui_prefs(&ctx).expect("read retained muted preference");

        assert!(error.to_string().contains("不可用"));
        assert_eq!(
            persisted.floating_notification_sound_source,
            FloatingNotificationSoundSource::Muted
        );
        assert_eq!(
            persisted.floating_notification_sound_storage_key.as_deref(),
            Some(storage_key)
        );
    }
}
