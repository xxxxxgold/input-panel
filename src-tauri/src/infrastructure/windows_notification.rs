use std::path::{Component, Path, PathBuf, Prefix};

use anyhow::{bail, Context, Result};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tauri_winrt_notification::{IconCrop, Toast};
use windows_registry::CURRENT_USER;

const NOTIFICATION_ICON_RESOURCE: &str = "icons/128x128.png";
// 旧应用 identifier 已被 Windows 通知平台缓存为无显示名 handler，Toast 使用独立稳定身份。
const NOTIFICATION_APP_ID_SUFFIX: &str = ".notifications";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeNotificationNavigation {
    ServiceStatus,
    Subscriptions,
}

impl NativeNotificationNavigation {
    fn target(self) -> &'static str {
        match self {
            Self::ServiceStatus => "serviceStatus",
            Self::Subscriptions => "subscriptions",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsNotificationIdentity {
    app_id: String,
    display_name: String,
    icon_path: PathBuf,
}

/// 发送使用统一应用身份并可导航到指定业务页面的 Windows 通知。
pub(crate) fn show_windows_notification(
    app: &AppHandle,
    title: &str,
    body: &str,
    navigation: NativeNotificationNavigation,
) -> Result<()> {
    let identity = resolve_notification_identity(app)?;
    register_notification_identity(&identity)?;

    let activation_app = app.clone();
    // Toast 本身保持静音，避免 Windows 系统音与应用配置的声音叠加。
    // 应用层只会在 show() 成功后再异步播放配置的提示音。
    Toast::new(&identity.app_id)
        .sound(None)
        .title(title)
        .text1(body)
        .icon(
            &identity.icon_path,
            IconCrop::Square,
            &identity.display_name,
        )
        .on_activated(move |_| {
            let dispatcher = activation_app.clone();
            let app_for_main_thread = activation_app.clone();
            if let Err(error) = dispatcher.run_on_main_thread(move || {
                crate::open_main_window_from_native(&app_for_main_thread, navigation.target());
            }) {
                log::warn!("[windows-notification] 调度通知点击导航失败: {error}");
            }
            Ok(())
        })
        .show()
        .context("显示 Windows WinRT 通知失败")
}

fn resolve_notification_identity(app: &AppHandle) -> Result<WindowsNotificationIdentity> {
    let resolved_icon_path = app
        .path()
        .resolve(NOTIFICATION_ICON_RESOURCE, BaseDirectory::Resource)
        .context("解析 Windows 通知图标资源路径失败")?;
    if !resolved_icon_path.is_file() {
        bail!(
            "Windows 通知图标资源不存在: {}",
            resolved_icon_path.display()
        );
    }
    let icon_path = normalize_windows_resource_path(&resolved_icon_path);

    build_notification_identity(
        &app.config().identifier,
        app.config().product_name.as_deref(),
        icon_path,
    )
}

/// 将 Windows verbatim 路径转换为 WinRT Toast 可识别的普通绝对路径。
fn normalize_windows_resource_path(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };

    let mut normalized = match prefix.kind() {
        Prefix::VerbatimDisk(disk) => PathBuf::from(format!("{}:", char::from(disk))),
        Prefix::VerbatimUNC(server, share) => {
            let mut unc_path = PathBuf::from(r"\\");
            unc_path.push(server);
            unc_path.push(share);
            unc_path
        }
        _ => return path.to_path_buf(),
    };

    for component in components {
        normalized.push(component.as_os_str());
    }
    normalized
}

fn build_notification_identity(
    app_identifier: &str,
    product_name: Option<&str>,
    icon_path: PathBuf,
) -> Result<WindowsNotificationIdentity> {
    let app_identifier = app_identifier.trim();
    if app_identifier.is_empty() {
        bail!("Tauri identifier 为空，无法注册 Windows 通知身份");
    }
    let display_name = product_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("Tauri productName 为空，无法注册 Windows 通知身份")?;

    Ok(WindowsNotificationIdentity {
        app_id: format!("{app_identifier}{NOTIFICATION_APP_ID_SUFFIX}"),
        display_name: display_name.to_string(),
        icon_path,
    })
}

fn register_notification_identity(identity: &WindowsNotificationIdentity) -> Result<()> {
    let key = CURRENT_USER
        .create(notification_registry_key(&identity.app_id))
        .context("创建 Windows AppUserModelID 注册表项失败")?;
    key.set_string("DisplayName", &identity.display_name)
        .context("写入 Windows 通知显示名称失败")?;
    key.set_string("IconBackgroundColor", "0")
        .context("写入 Windows 通知图标背景色失败")?;
    key.set_hstring("IconUri", &identity.icon_path.as_path().into())
        .context("写入 Windows 通知图标路径失败")?;
    Ok(())
}

fn notification_registry_key(app_id: &str) -> String {
    format!(r"SOFTWARE\Classes\AppUserModelId\{app_id}")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        build_notification_identity, normalize_windows_resource_path, notification_registry_key,
        NativeNotificationNavigation, NOTIFICATION_APP_ID_SUFFIX, NOTIFICATION_ICON_RESOURCE,
    };

    #[test]
    fn notification_identity_uses_tauri_branding_and_resource_path() {
        let icon_path = PathBuf::from(r"C:\app\resources\icons\128x128.png");
        let identity = build_notification_identity(
            "im.input.sub2api.monitor",
            Some("Input面板"),
            icon_path.clone(),
        )
        .expect("build notification identity");

        assert_eq!(identity.app_id, "im.input.sub2api.monitor.notifications");
        assert_eq!(identity.display_name, "Input面板");
        assert_eq!(identity.icon_path, icon_path);
        assert_eq!(NOTIFICATION_APP_ID_SUFFIX, ".notifications");
        assert_eq!(NOTIFICATION_ICON_RESOURCE, "icons/128x128.png");
        assert_eq!(
            notification_registry_key(&identity.app_id),
            r"SOFTWARE\Classes\AppUserModelId\im.input.sub2api.monitor.notifications"
        );
    }

    #[test]
    fn notification_identity_rejects_missing_branding() {
        let icon_path = PathBuf::from(r"C:\app\icon.png");

        assert!(build_notification_identity("", Some("Input面板"), icon_path.clone()).is_err());
        assert!(build_notification_identity("im.input.sub2api.monitor", None, icon_path).is_err());
    }

    #[test]
    fn notification_navigation_maps_to_existing_frontend_routes() {
        assert_eq!(
            NativeNotificationNavigation::ServiceStatus.target(),
            "serviceStatus"
        );
        assert_eq!(
            NativeNotificationNavigation::Subscriptions.target(),
            "subscriptions"
        );
    }

    #[test]
    fn notification_icon_path_removes_verbatim_disk_prefix() {
        assert_eq!(
            normalize_windows_resource_path(PathBuf::from(r"\\?\D:\app\icons\icon.png").as_path()),
            PathBuf::from(r"D:\app\icons\icon.png")
        );
    }

    #[test]
    fn notification_icon_path_converts_verbatim_unc_prefix() {
        assert_eq!(
            normalize_windows_resource_path(
                PathBuf::from(r"\\?\UNC\server\share\icons\icon.png").as_path()
            ),
            PathBuf::from(r"\\server\share\icons\icon.png")
        );
    }

    #[test]
    fn notification_icon_path_keeps_regular_paths_unchanged() {
        let path = PathBuf::from(r"C:\app\icons\icon.png");
        assert_eq!(normalize_windows_resource_path(&path), path);
    }
}
