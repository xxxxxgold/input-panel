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
            adapters::desktop::commands::get_available_groups,
            adapters::desktop::commands::list_managed_keys,
            adapters::desktop::commands::get_managed_key,
            adapters::desktop::commands::create_managed_key,
            adapters::desktop::commands::update_managed_key,
            adapters::desktop::commands::delete_managed_key,
            adapters::desktop::commands::list_usage_records,
            adapters::desktop::commands::get_usage_stats,
            adapters::desktop::commands::get_dashboard_models,
            adapters::desktop::commands::get_dashboard_trend,
            adapters::desktop::commands::get_key_daily_usage,
            adapters::desktop::commands::get_profile_record,
            adapters::desktop::commands::update_profile_record,
            adapters::desktop::commands::change_profile_password,
            adapters::desktop::commands::get_platform_quotas,
            adapters::desktop::commands::get_subscription_summary,
            adapters::desktop::commands::get_payment_config,
            adapters::desktop::commands::list_orders,
            adapters::desktop::commands::send_notify_email_code,
            adapters::desktop::commands::verify_notify_email,
            adapters::desktop::commands::remove_notify_email,
            adapters::desktop::commands::toggle_notify_email,
            adapters::desktop::commands::send_email_binding_code,
            adapters::desktop::commands::bind_email_identity,
            adapters::desktop::commands::unbind_auth_identity,
            adapters::desktop::commands::account_proxy_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
