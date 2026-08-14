use anyhow::{bail, Context, Result};
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::{Asia::Shanghai, Tz};

pub const STORAGE_TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S";
pub const STORAGE_DATE_FORMAT: &str = "%Y-%m-%d";

/// 生成上海时区、秒精度的数据库时间戳。
pub fn now_storage_timestamp() -> String {
    format_storage_timestamp(Utc::now())
}

pub fn format_storage_timestamp(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Shanghai)
        .format(STORAGE_TIMESTAMP_FORMAT)
        .to_string()
}

/// 将 canonical 或旧 RFC3339 时间转换为上海时区固定格式。
pub fn normalize_storage_timestamp(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if let Ok(canonical) = NaiveDateTime::parse_from_str(trimmed, STORAGE_TIMESTAMP_FORMAT) {
        let parsed = Shanghai
            .from_local_datetime(&canonical)
            .single()
            .context("上海时间无法唯一解析")?;
        return Ok(parsed.format(STORAGE_TIMESTAMP_FORMAT).to_string());
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Ok(parsed
            .with_timezone(&Shanghai)
            .format(STORAGE_TIMESTAMP_FORMAT)
            .to_string());
    }
    bail!("不支持的数据库时间格式")
}

pub fn parse_storage_timestamp(value: &str) -> Result<DateTime<Tz>> {
    let canonical = NaiveDateTime::parse_from_str(value.trim(), STORAGE_TIMESTAMP_FORMAT)
        .with_context(|| format!("无效的上海时间戳 {value}"))?;
    Shanghai
        .from_local_datetime(&canonical)
        .single()
        .context("上海时间无法唯一解析")
}

/// 将 canonical 或 RFC3339 时间按上海时区解析为业务日期。
pub fn storage_timestamp_date(value: &str) -> Result<NaiveDate> {
    let normalized = normalize_storage_timestamp(value)?;
    Ok(parse_storage_timestamp(&normalized)?.date_naive())
}

pub fn shanghai_today() -> NaiveDate {
    Utc::now().with_timezone(&Shanghai).date_naive()
}

pub fn format_storage_date(value: NaiveDate) -> String {
    value.format(STORAGE_DATE_FORMAT).to_string()
}

pub fn parse_storage_date(value: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), STORAGE_DATE_FORMAT)
        .with_context(|| format!("无效的业务日期 {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_offsets_are_converted_to_shanghai_time() {
        assert_eq!(
            normalize_storage_timestamp("2026-07-26T00:00:00Z").expect("normalize utc"),
            "2026-07-26 08:00:00"
        );
        assert_eq!(
            normalize_storage_timestamp("2026-07-26T00:00:00.987654321+08:00")
                .expect("normalize shanghai offset"),
            "2026-07-26 00:00:00"
        );
    }

    #[test]
    fn canonical_timestamp_is_idempotent() {
        assert_eq!(
            normalize_storage_timestamp("2026-07-26 12:34:56").expect("normalize canonical"),
            "2026-07-26 12:34:56"
        );
    }

    #[test]
    fn business_dates_remain_date_only() {
        let date = parse_storage_date("2026-07-26").expect("parse business date");
        assert_eq!(format_storage_date(date), "2026-07-26");
        assert!(parse_storage_date("2026-07-26 00:00:00").is_err());
    }

    #[test]
    fn timestamp_date_uses_shanghai_calendar_day() {
        assert_eq!(
            storage_timestamp_date("2026-07-25T16:00:00Z").expect("parse shanghai date"),
            NaiveDate::from_ymd_opt(2026, 7, 26).expect("valid date")
        );
    }
}
