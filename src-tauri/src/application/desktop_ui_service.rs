use anyhow::Result;

use crate::contracts::{AppLaunchMode, CloseBehavior, DesktopUiPrefs, DesktopUiPrefsPatch};
use crate::infrastructure::sqlite::repositories;

use super::AppContext;

const DESKTOP_UI_PREFS_KEY: &str = "desktop_ui_prefs";

fn normalize_theme(value: String) -> String {
    match value.as_str() {
        "light" | "dark" | "deep-blue" | "cloud-mist" | "graphite-cyan" | "warm-paper-console"
        | "carbon-amber-terminal" | "spruce-server-room" | "polar-lab" | "spectral-lab"
        | "clinical-monitor-bay" | "audit-archive-room" => value,
        _ => "light".into(),
    }
}

fn normalize_prefs(mut prefs: DesktopUiPrefs) -> DesktopUiPrefs {
    prefs.version = 1;
    prefs.theme = normalize_theme(prefs.theme);
    prefs
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
    if let Some(value) = patch.close_behavior {
        prefs.close_behavior = value;
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

        assert!(!prefs.keep_floating_panel_visible);
    }

    #[test]
    fn normalize_prefs_keeps_existing_pinned_flag() {
        let prefs = normalize_prefs(DesktopUiPrefs {
            version: 99,
            launch_mode: AppLaunchMode::Main,
            open_floating_in_main_mode: true,
            keep_floating_panel_visible: true,
            close_behavior: CloseBehavior::Ask,
            theme: "invalid-theme".into(),
        });

        assert_eq!(prefs.version, 1);
        assert!(prefs.keep_floating_panel_visible);
        assert_eq!(prefs.theme, "light");
    }
}
