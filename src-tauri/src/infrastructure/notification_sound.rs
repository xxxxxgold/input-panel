use std::{
    fs::{self, File, OpenOptions},
    io::{copy, BufReader},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use uuid::Uuid;

use crate::infrastructure::files::AppPaths;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::BOOL,
    System::Diagnostics::Debug::MessageBeep,
    UI::WindowsAndMessaging::{MB_ICONINFORMATION, MESSAGEBOX_STYLE},
};

pub(crate) const DEFAULT_NOTIFICATION_SOUND_RESOURCE: &str = "resources/sounds/manbo.mp3";
const CUSTOM_NOTIFICATION_SOUND_DIRECTORY: &str = "notification-sounds";
const CUSTOM_NOTIFICATION_SOUND_PREFIX: &str = "notification-sound-";

/// 已导入自定义提示音的安全展示和存储标识，不包含用户原始路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportedNotificationSound {
    pub display_name: String,
    pub storage_key: String,
}

/// 已启动的播放会话必须持有输出流和 Sink，直到声音播放完成。
pub(crate) struct ActiveNotificationSound {
    _stream: OutputStream,
    sink: Sink,
}

impl ActiveNotificationSound {
    pub(crate) fn wait_until_end(self) {
        self.sink.sleep_until_end();
    }
}

/// 请求 Windows 当前声音方案中的中性提示音，不由应用改写系统混音器音量。
#[cfg(target_os = "windows")]
fn request_windows_system_notification_sound_with(
    request: impl FnOnce(MESSAGEBOX_STYLE) -> BOOL,
) -> Result<()> {
    if request(MB_ICONINFORMATION) == 0 {
        return Err(std::io::Error::last_os_error()).context("请求 Windows 系统提示音失败");
    }
    Ok(())
}

/// Windows 系统提示音由 API 异步排队，调用方无需持有 Rodio 播放会话。
#[cfg(target_os = "windows")]
pub(crate) fn request_windows_system_notification_sound() -> Result<()> {
    request_windows_system_notification_sound_with(|style| unsafe { MessageBeep(style) })
}

/// 解析随应用打包的默认提示音，运行时不依赖开发机文件路径。
pub(crate) fn default_notification_sound_path(app: &AppHandle) -> Result<PathBuf> {
    let path = app
        .path()
        .resolve(DEFAULT_NOTIFICATION_SOUND_RESOURCE, BaseDirectory::Resource)
        .context("无法解析内置提示音资源")?;
    if !path.is_file() {
        bail!("内置提示音资源不存在");
    }
    Ok(path)
}

/// 仅接受当前版本生成的文件名，阻止偏好损坏时越出应用受控目录。
pub(crate) fn is_valid_custom_notification_sound_storage_key(value: &str) -> bool {
    let Some(file_name) = Path::new(value).file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name != value || !file_name.starts_with(CUSTOM_NOTIFICATION_SOUND_PREFIX) {
        return false;
    }

    let Some((uuid_value, extension)) = file_name
        .strip_prefix(CUSTOM_NOTIFICATION_SOUND_PREFIX)
        .and_then(|value| value.rsplit_once('.'))
    else {
        return false;
    };
    Uuid::parse_str(uuid_value).is_ok() && matches!(extension, "mp3" | "wav")
}

/// 将受控存储标识映射到应用配置目录中的单个文件。
pub(crate) fn custom_notification_sound_path(
    paths: &AppPaths,
    storage_key: &str,
) -> Result<PathBuf> {
    if !is_valid_custom_notification_sound_storage_key(storage_key) {
        bail!("自定义提示音配置无效");
    }
    Ok(paths
        .config_dir
        .join(CUSTOM_NOTIFICATION_SOUND_DIRECTORY)
        .join(storage_key))
}

/// 校验并复制用户选择的文件。新文件在偏好成功写入前不会替换旧文件。
pub(crate) fn import_custom_notification_sound(
    paths: &AppPaths,
    source_path: &Path,
) -> Result<ImportedNotificationSound> {
    let metadata = fs::metadata(source_path).context("无法读取选择的提示音文件")?;
    if !metadata.is_file() {
        bail!("请选择一个 MP3 或 WAV 音频文件");
    }

    let extension = supported_audio_extension(source_path)?;
    let display_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .context("提示音文件名无效")?
        .to_string();
    let storage_key = format!(
        "{CUSTOM_NOTIFICATION_SOUND_PREFIX}{}.{}",
        Uuid::new_v4(),
        extension
    );
    let storage_dir = paths.config_dir.join(CUSTOM_NOTIFICATION_SOUND_DIRECTORY);
    fs::create_dir_all(&storage_dir).context("无法创建提示音存储目录")?;
    let destination_path = custom_notification_sound_path(paths, &storage_key)?;
    let staging_path = storage_dir.join(format!(".{storage_key}.{}.part", Uuid::new_v4()));

    let result = (|| -> Result<ImportedNotificationSound> {
        let source = File::open(source_path).context("无法读取选择的提示音文件")?;
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .context("无法创建提示音受控副本")?;
        copy(&mut BufReader::new(source), &mut destination).context("无法复制提示音文件")?;
        destination.sync_all().context("无法完成提示音文件写入")?;
        drop(destination);

        validate_audio_file(&staging_path)?;
        fs::rename(&staging_path, &destination_path).context("无法完成提示音文件导入")?;

        Ok(ImportedNotificationSound {
            display_name,
            storage_key,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_file(&staging_path);
    }
    result
}

/// 删除旧的应用受控副本；丢失文件视为已清理完成。
pub(crate) fn remove_custom_notification_sound(paths: &AppPaths, storage_key: &str) -> Result<()> {
    let path = custom_notification_sound_path(paths, storage_key)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("无法清理旧提示音副本"),
    }
}

/// 启动一条提示音。自定义文件不可用时自动回退到内置默认音。
pub(crate) fn start_notification_sound(
    default_path: PathBuf,
    custom_path: Option<PathBuf>,
    volume_percent: i64,
) -> Result<Option<ActiveNotificationSound>> {
    let volume_percent = volume_percent.clamp(0, 100);
    if volume_percent == 0 {
        return Ok(None);
    }
    if !default_path.is_file() {
        bail!("内置提示音资源不存在");
    }

    let volume = volume_percent as f32 / 100.0;
    if let Some(custom_path) = custom_path {
        match start_audio_file(&custom_path, volume) {
            Ok(playback) => return Ok(Some(playback)),
            Err(error) => {
                log::warn!("[notification-sound] 自定义提示音不可用，已回退内置提示音: {error}");
            }
        }
    }

    start_audio_file(&default_path, volume)
        .map(Some)
        .context("内置提示音播放失败")
}

fn supported_audio_extension(path: &Path) -> Result<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .context("提示音文件缺少扩展名")?;
    match extension.as_str() {
        "mp3" => Ok("mp3"),
        "wav" => Ok("wav"),
        _ => bail!("提示音仅支持 MP3 或 WAV 文件"),
    }
}

fn validate_audio_file(path: &Path) -> Result<()> {
    let file = File::open(path).context("无法读取提示音副本")?;
    let _decoder = Decoder::try_from(file).context("提示音格式或内容无效")?;
    Ok(())
}

fn start_audio_file(path: &Path, volume: f32) -> Result<ActiveNotificationSound> {
    let file = File::open(path).context("无法读取提示音文件")?;
    let decoder = Decoder::try_from(file).context("提示音格式或内容无效")?;
    let stream = OutputStreamBuilder::open_default_stream().context("默认音频设备不可用")?;
    let sink = Sink::connect_new(stream.mixer());
    sink.set_volume(volume);
    sink.append(decoder);
    Ok(ActiveNotificationSound {
        _stream: stream,
        sink,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        custom_notification_sound_path, import_custom_notification_sound,
        is_valid_custom_notification_sound_storage_key, DEFAULT_NOTIFICATION_SOUND_RESOURCE,
    };
    use crate::infrastructure::files::AppPaths;

    #[cfg(target_os = "windows")]
    use super::{request_windows_system_notification_sound_with, MB_ICONINFORMATION};

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "input-panel-notification-sound-tests-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn storage_key_accepts_only_generated_audio_file_names() {
        let valid = "notification-sound-550e8400-e29b-41d4-a716-446655440000.mp3";
        assert!(is_valid_custom_notification_sound_storage_key(valid));
        assert!(is_valid_custom_notification_sound_storage_key(
            "notification-sound-550e8400-e29b-41d4-a716-446655440000.wav"
        ));
        assert!(!is_valid_custom_notification_sound_storage_key(
            "../manbo.mp3"
        ));
        assert!(!is_valid_custom_notification_sound_storage_key(
            "notification-sound-not-a-uuid.mp3"
        ));
        assert!(!is_valid_custom_notification_sound_storage_key(
            "notification-sound-550e8400-e29b-41d4-a716-446655440000.ogg"
        ));
    }

    #[test]
    fn default_sound_path_preserves_the_bundled_resource_prefix() {
        assert_eq!(
            DEFAULT_NOTIFICATION_SOUND_RESOURCE,
            "resources/sounds/manbo.mp3"
        );
    }

    #[test]
    fn imported_sound_is_copied_into_the_controlled_directory() {
        let root = test_root();
        let source_path = root.join("picked-tone.MP3");
        fs::create_dir_all(&root).expect("create source directory");
        fs::write(
            &source_path,
            include_bytes!("../../resources/sounds/manbo.mp3"),
        )
        .expect("write source audio");
        let paths = AppPaths::from_root(root.join("app"));
        paths.ensure().expect("create app paths");

        let imported = import_custom_notification_sound(&paths, &source_path)
            .expect("import valid audio file");
        let copied_path = custom_notification_sound_path(&paths, &imported.storage_key)
            .expect("resolve controlled path");

        assert_eq!(imported.display_name, "picked-tone.MP3");
        assert!(copied_path.is_file());
        assert_ne!(copied_path, source_path);
        assert!(copied_path.starts_with(paths.config_dir.join("notification-sounds")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_audio_never_leaves_a_controlled_copy() {
        let root = test_root();
        let source_path = root.join("invalid.wav");
        fs::create_dir_all(&root).expect("create source directory");
        fs::write(&source_path, b"not an audio stream").expect("write invalid source");
        let paths = AppPaths::from_root(root.join("app"));
        paths.ensure().expect("create app paths");

        assert!(import_custom_notification_sound(&paths, &source_path).is_err());
        let sound_directory = paths.config_dir.join("notification-sounds");
        assert!(fs::read_dir(sound_directory)
            .expect("read controlled sound directory")
            .next()
            .is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_system_sound_uses_the_information_notification_style() {
        let mut requested_style = 0;
        request_windows_system_notification_sound_with(|style| {
            requested_style = style;
            1
        })
        .expect("request system sound");

        assert_eq!(requested_style, MB_ICONINFORMATION);
        assert!(request_windows_system_notification_sound_with(|_| 0).is_err());
    }
}
