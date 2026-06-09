mod commands;
mod models;
mod overview;
mod store;
mod sub2api;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::health,
      commands::get_overview,
      commands::create_site,
      commands::update_site,
      commands::remove_site,
      commands::create_account,
      commands::update_account,
      commands::remove_account,
      commands::login_account,
      commands::persist_account_credential,
      commands::login_account_2fa,
      commands::refresh_account,
      commands::refresh_all_accounts,
      commands::account_proxy_request
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
