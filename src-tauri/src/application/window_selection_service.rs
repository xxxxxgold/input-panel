use crate::infrastructure::sqlite::repositories;
use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::AppContext;

const WINDOW_SELECTION_KEY: &str = "window_selection";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSelectionState {
    pub selected_site_id: Option<String>,
    pub selected_account_id: Option<String>,
}

pub fn get_window_selection(ctx: &AppContext) -> Result<WindowSelectionState> {
    let selection = repositories::get_setting(&ctx.db, WINDOW_SELECTION_KEY)?
        .and_then(|value| serde_json::from_str::<WindowSelectionState>(&value).ok())
        .map(normalize_window_selection)
        .unwrap_or_default();
    Ok(selection)
}

pub fn update_window_selection(
    ctx: &AppContext,
    selection: WindowSelectionState,
) -> Result<WindowSelectionState> {
    let normalized = normalize_window_selection(selection);
    repositories::set_setting(
        &ctx.db,
        WINDOW_SELECTION_KEY,
        &serde_json::to_string(&normalized)?,
    )?;
    Ok(normalized)
}

fn normalize_window_selection(mut selection: WindowSelectionState) -> WindowSelectionState {
    selection.selected_site_id = normalize_selection_id(selection.selected_site_id);
    selection.selected_account_id = normalize_selection_id(selection.selected_account_id);
    selection
}

fn normalize_selection_id(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use super::{get_window_selection, update_window_selection, WindowSelectionState};
    use tokio::sync::Mutex;

    use crate::application::{context::SyncTaskHandle, AppContext};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::Database;

    fn temp_app_context(label: &str) -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "api-token-window-selection-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure temp app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("connect sqlite db");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(
            ),
            native_notifications_enabled: false,
        }
    }

    #[test]
    fn round_trips_window_selection_through_app_settings() {
        let ctx = temp_app_context("roundtrip");

        let saved = update_window_selection(
            &ctx,
            WindowSelectionState {
                selected_site_id: Some("site-1".into()),
                selected_account_id: Some("account-2".into()),
            },
        )
        .expect("save window selection");

        assert_eq!(
            saved,
            WindowSelectionState {
                selected_site_id: Some("site-1".into()),
                selected_account_id: Some("account-2".into()),
            }
        );

        let loaded = get_window_selection(&ctx).expect("load window selection");

        assert_eq!(loaded, saved);
    }

    #[test]
    fn normalizes_blank_selection_ids_to_null() {
        let ctx = temp_app_context("normalize");

        let saved = update_window_selection(
            &ctx,
            WindowSelectionState {
                selected_site_id: Some("  ".into()),
                selected_account_id: Some(" account-2 ".into()),
            },
        )
        .expect("save normalized selection");

        assert_eq!(
            saved,
            WindowSelectionState {
                selected_site_id: None,
                selected_account_id: Some("account-2".into()),
            }
        );
    }
}
