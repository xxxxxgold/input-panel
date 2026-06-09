use crate::models::{
    AccountRecord, AccountSnapshot, SiteRecord, StoredCredentialMeta, StoredSession, StoredState,
};
use crate::sub2api::merge_request_history;
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use core::ffi::c_void;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DISABLED_BALANCE_WARNING: f64 = -1.0;

fn normalize_balance_warning(value: f64) -> f64 {
    if !value.is_finite() {
        DISABLED_BALANCE_WARNING
    } else if value < 0.0 {
        DISABLED_BALANCE_WARNING
    } else {
        value
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .context("无法解析应用数据目录")?;
    fs::create_dir_all(dir.join("sessions"))?;
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("state.json"))
}

fn session_path(app: &AppHandle, account_id: &str) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("sessions").join(format!("{account_id}.json")))
}

fn credential_meta_path(app: &AppHandle, account_id: &str) -> Result<PathBuf> {
    Ok(data_dir(app)?
        .join("sessions")
        .join(format!("{account_id}.credential.json")))
}

pub fn read_state(app: &AppHandle) -> Result<StoredState> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(StoredState::default());
    }
    let raw = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn write_state(app: &AppHandle, state: &StoredState) -> Result<()> {
    let path = state_path(app)?;
    fs::write(path, serde_json::to_string_pretty(state)?)?;
    Ok(())
}

pub fn save_session(app: &AppHandle, account_id: &str, session: &StoredSession) -> Result<()> {
    let path = session_path(app, account_id)?;
    fs::write(path, serde_json::to_string_pretty(session)?)?;
    Ok(())
}

pub fn load_session(app: &AppHandle, account_id: &str) -> Result<Option<StoredSession>> {
    let path = session_path(app, account_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

pub fn remove_session(app: &AppHandle, account_id: &str) -> Result<()> {
    let path = session_path(app, account_id)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn save_credential(app: &AppHandle, account_id: &str, email: &str, password: &str) -> Result<()> {
    let path = credential_meta_path(app, account_id)?;
    let protected = protect_password(password)?;
    let payload = StoredCredentialMeta {
        saved_at: Utc::now().to_rfc3339(),
        email: email.trim().to_string(),
        has_password: true,
    };
    fs::write(path.with_extension("secret"), protected)?;
    fs::write(path, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

pub fn load_credential(app: &AppHandle, account_id: &str) -> Result<Option<(StoredCredentialMeta, String)>> {
    let meta_path = credential_meta_path(app, account_id)?;
    if !meta_path.exists() {
        return Ok(None);
    }
    let secret_path = meta_path.with_extension("secret");
    if !secret_path.exists() {
        return Ok(None);
    }
    let meta_raw = fs::read_to_string(meta_path)?;
    let meta: StoredCredentialMeta = serde_json::from_str(&meta_raw)?;
    let secret_raw = fs::read_to_string(secret_path)?;
    let password = unprotect_password(&secret_raw)?;
    Ok(Some((meta, password)))
}

pub fn remove_credential(app: &AppHandle, account_id: &str) -> Result<()> {
    let meta_path = credential_meta_path(app, account_id)?;
    if meta_path.exists() {
        fs::remove_file(&meta_path)?;
    }
    let secret_path = meta_path.with_extension("secret");
    if secret_path.exists() {
        fs::remove_file(secret_path)?;
    }
    Ok(())
}

pub fn add_site(app: &AppHandle, input: crate::models::SiteInput) -> Result<SiteRecord> {
    let mut state = read_state(app)?;
    let now = Utc::now().to_rfc3339();
    let site = SiteRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name.trim().to_string(),
        base_url: input.base_url.trim().to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    state.sites.push(site.clone());
    write_state(app, &state)?;
    Ok(site)
}

pub fn update_site(
    app: &AppHandle,
    site_id: &str,
    patch_name: Option<String>,
    patch_base_url: Option<String>,
) -> Result<SiteRecord> {
    let mut state = read_state(app)?;
    let site = state
        .sites
        .iter_mut()
        .find(|item| item.id == site_id)
        .context("站点不存在")?;
    if let Some(name) = patch_name {
        site.name = name.trim().to_string();
    }
    if let Some(base_url) = patch_base_url {
        site.base_url = base_url.trim().to_string();
    }
    site.updated_at = Utc::now().to_rfc3339();
    let site_clone = site.clone();
    write_state(app, &state)?;
    Ok(site_clone)
}

pub fn remove_site(app: &AppHandle, site_id: &str) -> Result<()> {
    let mut state = read_state(app)?;
    let account_ids: Vec<String> = state
        .accounts
        .iter()
        .filter(|item| item.site_id == site_id)
        .map(|item| item.id.clone())
        .collect();
    state.sites.retain(|item| item.id != site_id);
    state.accounts.retain(|item| item.site_id != site_id);
    for account_id in account_ids {
        state.snapshots.remove(&account_id);
        state.errors.remove(&account_id);
        remove_session(app, &account_id)?;
        remove_credential(app, &account_id)?;
    }
    write_state(app, &state)?;
    Ok(())
}

pub fn add_account(app: &AppHandle, input: crate::models::AccountInput) -> Result<AccountRecord> {
    let mut state = read_state(app)?;
    let now = Utc::now().to_rfc3339();
    let account = AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        site_id: input.site_id,
        label: input.label.trim().to_string(),
        email: input.email.trim().to_string(),
        balance_warning: normalize_balance_warning(input.balance_warning),
        last_login_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    state.accounts.push(account.clone());
    write_state(app, &state)?;
    Ok(account)
}

pub fn update_account(
    app: &AppHandle,
    account_id: &str,
    label: Option<String>,
    email: Option<String>,
    balance_warning: Option<f64>,
    last_login_at: Option<String>,
) -> Result<AccountRecord> {
    let mut state = read_state(app)?;
    let account = state
        .accounts
        .iter_mut()
        .find(|item| item.id == account_id)
        .context("账号不存在")?;
    if let Some(label) = label {
        account.label = label.trim().to_string();
    }
    if let Some(email) = email {
        account.email = email.trim().to_string();
    }
    if let Some(balance_warning) = balance_warning {
        account.balance_warning = normalize_balance_warning(balance_warning);
    }
    if let Some(last_login_at) = last_login_at {
        account.last_login_at = Some(last_login_at);
    }
    account.updated_at = Utc::now().to_rfc3339();
    let account_clone = account.clone();
    write_state(app, &state)?;
    Ok(account_clone)
}

pub fn remove_account(app: &AppHandle, account_id: &str) -> Result<()> {
    let mut state = read_state(app)?;
    state.accounts.retain(|item| item.id != account_id);
    state.snapshots.remove(account_id);
    state.errors.remove(account_id);
    remove_session(app, account_id)?;
    remove_credential(app, account_id)?;
    write_state(app, &state)?;
    Ok(())
}

pub fn save_snapshot(app: &AppHandle, account_id: &str, snapshot: AccountSnapshot) -> Result<()> {
    let mut state = read_state(app)?;
    let previous_history = state
        .snapshots
        .get(account_id)
        .map(|item| item.request_history.clone())
        .unwrap_or_default();
    let merged_snapshot = AccountSnapshot {
        request_history: merge_request_history(
            &previous_history,
            &snapshot.recent_usage,
            &snapshot.fetched_at,
        ),
        ..snapshot
    };
    state.snapshots.insert(account_id.to_string(), merged_snapshot);
    state.errors.insert(account_id.to_string(), None);
    write_state(app, &state)
}

pub fn save_error(app: &AppHandle, account_id: &str, message: String) -> Result<()> {
    let mut state = read_state(app)?;
    state.errors.insert(account_id.to_string(), Some(message));
    write_state(app, &state)
}

#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        p_data_in: *const DataBlob,
        sz_data_descr: *const u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *const c_void,
        p_prompt_struct: *const c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;

    fn CryptUnprotectData(
        p_data_in: *const DataBlob,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *const DataBlob,
        pv_reserved: *const c_void,
        p_prompt_struct: *const c_void,
        dw_flags: u32,
        p_data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
}

fn protect_password(password: &str) -> Result<String> {
    let mut input_bytes = password.as_bytes().to_vec();
    let input = DataBlob {
        cb_data: input_bytes.len() as u32,
        pb_data: input_bytes.as_mut_ptr(),
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: core::ptr::null_mut(),
    };
    unsafe {
        let ok = CryptProtectData(
            &input,
            core::ptr::null(),
            core::ptr::null(),
            core::ptr::null(),
            core::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        != 0;
        if !ok {
            anyhow::bail!("本地加密账号密码失败");
        }
        let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        let _ = LocalFree(output.pb_data.cast::<c_void>());
        Ok(STANDARD.encode(bytes))
    }
}

fn unprotect_password(cipher_text: &str) -> Result<String> {
    let mut cipher = STANDARD
        .decode(cipher_text.trim())
        .context("本地凭据内容损坏，无法解码")?;
    let input = DataBlob {
        cb_data: cipher.len() as u32,
        pb_data: cipher.as_mut_ptr(),
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: core::ptr::null_mut(),
    };
    let mut description_ptr: *mut u16 = core::ptr::null_mut();
    unsafe {
        let ok = CryptUnprotectData(
            &input,
            &mut description_ptr,
            core::ptr::null(),
            core::ptr::null(),
            core::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        != 0;
        if !ok {
            anyhow::bail!("本地解密账号密码失败");
        }
        let bytes = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        if !description_ptr.is_null() {
            let _ = LocalFree(description_ptr.cast::<c_void>());
        }
        let _ = LocalFree(output.pb_data.cast::<c_void>());
        String::from_utf8(bytes).context("本地解密后的账号密码不是合法 UTF-8")
    }
}

#[cfg(test)]
mod tests {
    use super::{protect_password, unprotect_password};

    #[test]
    fn dpapi_round_trip_password() {
        let cipher = protect_password("Secr3t!@#").expect("should encrypt");
        let plain = unprotect_password(&cipher).expect("should decrypt");
        assert_eq!(plain, "Secr3t!@#");
    }
}
