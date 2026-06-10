use tauri::Manager;

pub mod adapters;
pub mod application;
pub mod contracts;
pub mod domain;
pub mod infrastructure;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let ctx = application::AppContext::resolve()?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(ctx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            adapters::desktop::commands::health,
            adapters::desktop::commands::get_overview,
            adapters::desktop::commands::create_site,
            adapters::desktop::commands::update_site,
            adapters::desktop::commands::remove_site,
            adapters::desktop::commands::create_account,
            adapters::desktop::commands::update_account,
            adapters::desktop::commands::remove_account,
            adapters::desktop::commands::login_account,
            adapters::desktop::commands::persist_account_credential,
            adapters::desktop::commands::login_account_2fa,
            adapters::desktop::commands::refresh_account,
            adapters::desktop::commands::refresh_all_accounts,
            adapters::desktop::commands::account_proxy_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
