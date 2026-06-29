use anyhow::Result;

use crate::contracts::{AppLaunchMode, CloseBehavior, DesktopUiPrefs, DesktopUiPrefsPatch};
use crate::infrastructure::sqlite::repositories;

use super::AppContext;

const DESKTOP_UI_PREFS_KEY: &str = "desktop_ui_prefs";
const MIN_AUTO_REFRESH_INTERVAL_SECONDS: i64 = 1;
const MIN_FLOATING_PANEL_OPACITY: f64 = 0.45;
const MAX_FLOATING_PANEL_OPACITY: f64 = 0.95;

fn normalize_theme(value: String) -> String {
    match value.as_str() {
        "light" | "dark" | "deep-blue" | "cloud-mist" | "graphite-cyan" | "warm-paper-console"
        | "carbon-amber-terminal" | "spruce-server-room" | "polar-lab" | "spectral-lab"
        | "clinical-monitor-bay" | "audit-archive-room" => value,
        _ => "light".into(),
    }
}

fn normalize_floating_panel_opacity(value: f64) -> f64 {
    if !value.is_finite() {
        return DesktopUiPrefs::default().floating_panel_opacity;
    }
    value.clamp(MIN_FLOATING_PANEL_OPACITY, MAX_FLOATING_PANEL_OPACITY)
}

fn normalize_prefs(mut prefs: DesktopUiPrefs) -> DesktopUiPrefs {
    prefs.version = 1;
    prefs.theme = normalize_theme(prefs.theme);
    prefs.floating_panel_opacity = normalize_floating_panel_opacity(prefs.floating_panel_opacity);
    prefs.auto_refresh_interval_seconds = normalize_auto_refresh_interval_seconds(prefs.auto_refresh_interval_seconds);
    prefs.auto_refresh_core_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_core_interval_seconds);
    prefs.auto_refresh_keys_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_keys_interval_seconds);
    prefs.auto_refresh_usage_interval_seconds =
        normalize_auto_refresh_interval_seconds(prefs.auto_refresh_usage_interval_seconds);
    prefs
}

fn normalize_auto_refresh_interval_seconds(value: i64) -> i64 {
    value.max(MIN_AUTO_REFRESH_INTERVAL_SECONDS)
}

pub fn get_desktop_ui_prefs(ctx: &AppContext) -> Result<DesktopUiPrefs> {
    let prefs = repositories::get_setting(&ctx.db, DESKTOP_UI_PREFS_KEY)?
        .and_then(|value| serde_json::from_str::<DesktopUiPrefs>(&value).ok())
        .map(normalize_prefs)
        .unwrap_or_default();
    Ok(prefs)
}

pub fn update_desktop_ui_prefs(ctx: &AppContext, patch: DesktopUiPrefsPatch) -> Result<DesktopUiPrefs> {
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
    if let Some(value) = patch.close_behavior {
        prefs.close_behavior = value;
    }
    if let Some(value) = patch.auto_refresh_enabled {
        prefs.auto_refresh_enabled = value;
    }
    if let Some(value) = patch.auto_refresh_interval_seconds {
        prefs.auto_refresh_interval_seconds = normalize_auto_refresh_interval_seconds(value);
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

pub fn set_launch_mode(ctx: &AppContext, launch_mode: AppLaunchMode) -> Result<DesktopUiPrefs> {
    update_desktop_ui_prefs(
        ctx,
        DesktopUiPrefsPatch {
            launch_mode: Some(launch_mode),
            ..DesktopUiPrefsPatch::default()
        },
    )
}

pub fn set_close_behavior(ctx: &AppContext, close_behavior: CloseBehavior) -> Result<DesktopUiPrefs> {
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

    #[test]
    fn desktop_ui_prefs_default_disables_pinned_floating_panel() {
        let prefs = DesktopUiPrefs::default();
        let default_interval = prefs.auto_refresh_interval_seconds;

        assert!(!prefs.keep_floating_panel_visible);
        assert!(prefs.auto_refresh_enabled);
        assert_eq!(prefs.auto_refresh_interval_seconds, default_interval);
        assert!(prefs.auto_refresh_core_enabled);
        assert_eq!(
            prefs.auto_refresh_core_interval_seconds,
            default_interval
        );
        assert!(prefs.auto_refresh_keys_enabled);
        assert_eq!(
            prefs.auto_refresh_keys_interval_seconds,
            default_interval
        );
        assert!(prefs.auto_refresh_usage_enabled);
        assert_eq!(
            prefs.auto_refresh_usage_interval_seconds,
            default_interval
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
            close_behavior: CloseBehavior::Ask,
            auto_refresh_enabled: true,
            auto_refresh_interval_seconds: 0,
            auto_refresh_core_enabled: false,
            auto_refresh_core_interval_seconds: 0,
            auto_refresh_keys_enabled: false,
            auto_refresh_keys_interval_seconds: 0,
            auto_refresh_usage_enabled: false,
            auto_refresh_usage_interval_seconds: 0,
            theme: "invalid-theme".into(),
        });

        assert_eq!(prefs.version, 1);
        assert!(prefs.keep_floating_panel_visible);
        assert_eq!(prefs.floating_panel_opacity, MIN_FLOATING_PANEL_OPACITY);
        assert_eq!(prefs.theme, "light");
        assert_eq!(prefs.auto_refresh_interval_seconds, MIN_AUTO_REFRESH_INTERVAL_SECONDS);
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
    }
}
