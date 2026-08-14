use std::{env, fs, path::Path};

const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    let frontend_dist =
        Path::new(&env::var("CARGO_MANIFEST_DIR").expect("缺少 Cargo 清单目录")).join("../dist");
    track_frontend_dist(&frontend_dist);
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("生成 Tauri 构建资源失败");
    link_common_controls_manifest();
}

/// 让所有 Windows 可执行目标启用 Tauri 依赖的 Common Controls v6。
fn link_common_controls_manifest() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let output_dir = env::var("OUT_DIR").expect("缺少构建输出目录");
    let manifest_path = Path::new(&output_dir).join("common-controls-v6.manifest");
    let resource_lib = Path::new(&output_dir).join("resource.lib");
    fs::write(&manifest_path, WINDOWS_APP_MANIFEST).expect("写入 Common Controls v6 manifest 失败");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
    println!("cargo:rustc-link-arg-examples={}", resource_lib.display());
}

/// 让前端构建产物变化时重新生成 Tauri 的内嵌资源上下文。
fn track_frontend_dist(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());

    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            track_frontend_dist(&entry_path);
        } else {
            println!("cargo:rerun-if-changed={}", entry_path.display());
        }
    }
}
