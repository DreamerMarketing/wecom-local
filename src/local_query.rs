use anyhow::{anyhow, Result};
use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use serde_json::{json, Value};

use crate::{conversations, decoder, members, runtime_bridge, stats};

pub fn discover_conversations(query: Option<&str>) -> Result<Value> {
    let raw = runtime_bridge::list_conversations()?;
    conversations::normalize_payload(raw, query)
}

pub fn read_history(conversation_reference: &str, limit: usize, offset: usize) -> Result<Value> {
    let conversation = resolve_conversation(conversation_reference)?;
    read_history_for_conversation(&conversation, limit, offset)
}

pub fn read_history_in_range(
    conversation_reference: &str,
    limit: usize,
    offset: usize,
    since: Option<&str>,
    until: Option<&str>,
) -> Result<Value> {
    let range = MessageTimeRange::parse(since, until)?;
    if range.since.is_none() && range.until.is_none() {
        return read_history(conversation_reference, limit, offset);
    }

    let conversation = resolve_conversation(conversation_reference)?;
    let payload = read_history_for_conversation(&conversation, 0, 0)?;
    let filtered = filter_history_by_time(payload, &range)?;
    paginate_history(filtered, limit, offset)
}

#[derive(Debug)]
struct MessageTimeRange {
    since_text: Option<String>,
    since: Option<f64>,
    until_text: Option<String>,
    until: Option<f64>,
}

impl MessageTimeRange {
    fn parse(since: Option<&str>, until: Option<&str>) -> Result<Self> {
        let since_text = normalized_optional_time(since);
        let until_text = normalized_optional_time(until);
        let since = since_text
            .as_deref()
            .map(|value| parse_local_time(value, "since"))
            .transpose()?;
        let until = until_text
            .as_deref()
            .map(|value| parse_local_time(value, "until"))
            .transpose()?;

        if matches!((since, until), (Some(start), Some(end)) if start >= end) {
            return Err(anyhow!("since must be earlier than until"));
        }

        Ok(Self {
            since_text,
            since,
            until_text,
            until,
        })
    }
}

fn normalized_optional_time(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_local_time(value: &str, field: &str) -> Result<f64> {
    let naive = if let Ok(date_time) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        date_time
    } else if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        date.and_hms_opt(0, 0, 0)
            .ok_or_else(|| anyhow!("invalid {field} value"))?
    } else {
        return Err(anyhow!(
            "invalid {field} value; expected YYYY-MM-DD or YYYY-MM-DD HH:MM:SS"
        ));
    };

    Local
        .from_local_datetime(&naive)
        .single()
        .map(|date_time| date_time.timestamp() as f64)
        .ok_or_else(|| anyhow!("{field} does not identify one local time"))
}

fn filter_history_by_time(mut payload: Value, range: &MessageTimeRange) -> Result<Value> {
    if range.since.is_none() && range.until.is_none() {
        return Ok(payload);
    }

    let (scanned_count, returned_count) = {
        let rows = payload
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("runtime export does not contain a messages array"))?;
        let scanned_count = rows.len();
        rows.retain(|row| {
            let Some(send_time) = row.get("send_time").and_then(Value::as_f64) else {
                return false;
            };
            range.since.is_none_or(|since| send_time >= since)
                && range.until.is_none_or(|until| send_time < until)
        });
        (scanned_count, rows.len())
    };

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("since".to_string(), json!(range.since_text));
        obj.insert("until".to_string(), json!(range.until_text));
        obj.insert("scanned_count".to_string(), json!(scanned_count));
        obj.insert("range_matched_count".to_string(), json!(returned_count));
        obj.insert("exported_count".to_string(), json!(returned_count));
    }
    Ok(payload)
}

fn paginate_history(mut payload: Value, limit: usize, offset: usize) -> Result<Value> {
    let (matched_count, returned_count) = {
        let rows = payload
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow!("runtime export does not contain a messages array"))?;
        let matched_count = rows.len();
        let start = offset.min(matched_count);
        let available = matched_count - start;
        let take = if limit == 0 {
            available
        } else {
            limit.min(available)
        };
        *rows = rows.iter().skip(start).take(take).cloned().collect();
        (matched_count, rows.len())
    };

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("range_matched_count".to_string(), json!(matched_count));
        obj.insert("offset".to_string(), json!(offset));
        obj.insert("exported_count".to_string(), json!(returned_count));
    }
    Ok(payload)
}

pub fn search_messages(
    conversation_reference: &str,
    query: &str,
    limit: usize,
    max_scan: usize,
) -> Result<Value> {
    let query = query.trim();
    if query.is_empty() {
        return Err(anyhow!("search query cannot be empty"));
    }

    let payload = read_history(conversation_reference, max_scan, 0)?;
    filter_search_payload(payload, query, limit, max_scan)
}

pub fn conversation_stats(
    conversation_reference: &str,
    max_scan: usize,
    include_members: bool,
) -> Result<Value> {
    let conversation = resolve_conversation(conversation_reference)?;
    if include_members {
        let (raw_history, raw_members) =
            runtime_bridge::export_history_and_members(&conversation.conversation_id, max_scan, 0)?;
        let payload = decoder::decode_payload(raw_history)?;
        let members = members::normalize_payload(raw_members, members::MemberDetailScope::Full)?;
        return stats::summarize_payload_with_members(payload, max_scan, &members);
    }

    let payload = read_history_for_conversation(&conversation, max_scan, 0)?;
    stats::summarize_payload(payload, max_scan)
}

pub fn list_members(
    conversation_reference: &str,
    scope: members::MemberDetailScope,
) -> Result<Value> {
    let conversation = resolve_conversation(conversation_reference)?;
    read_members_for_conversation(&conversation, scope)
}

fn read_history_for_conversation(
    conversation: &conversations::ResolvedConversation,
    limit: usize,
    offset: usize,
) -> Result<Value> {
    let raw = runtime_bridge::export_history(&conversation.conversation_id, limit, offset)?;
    decoder::decode_payload(raw)
}

fn read_members_for_conversation(
    conversation: &conversations::ResolvedConversation,
    scope: members::MemberDetailScope,
) -> Result<Value> {
    let raw = runtime_bridge::list_members(&conversation.conversation_id)?;
    members::normalize_payload(raw, scope)
}

fn resolve_conversation(
    conversation_reference: &str,
) -> Result<conversations::ResolvedConversation> {
    let conversation_reference = conversation_reference.trim();
    if conversation_reference.is_empty() {
        return Err(anyhow!("conversation reference cannot be empty"));
    }

    if conversations::looks_like_conversation_id(conversation_reference) {
        return conversations::ResolvedConversation::from_id(conversation_reference);
    }

    let payload = discover_conversations(Some(conversation_reference))?;
    conversations::resolve_one(&payload, conversation_reference)
}

fn filter_search_payload(
    mut payload: Value,
    query: &str,
    limit: usize,
    scan_limit: usize,
) -> Result<Value> {
    let rows = payload
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| anyhow!("runtime export does not contain a messages array"))?;

    let scanned_count = rows.len();
    let query_key = query.to_lowercase();
    let mut matches = rows
        .iter()
        .filter(|row| row_matches_query(row, &query_key))
        .cloned()
        .collect::<Vec<_>>();
    let matched_count = matches.len();
    if limit > 0 && matches.len() > limit {
        matches.truncate(limit);
    }
    let returned_count = matches.len();
    *rows = matches;

    if let Some(obj) = payload.as_object_mut() {
        obj.insert("query".to_string(), json!(query));
        obj.insert("scan_limit".to_string(), limit_or_all(scan_limit));
        obj.insert("scanned_count".to_string(), json!(scanned_count));
        obj.insert("matched_count".to_string(), json!(matched_count));
        obj.insert("returned_count".to_string(), json!(returned_count));
        obj.remove("offset");
        obj.remove("exported_count");
    }

    Ok(payload)
}

fn row_matches_query(row: &Value, query_key: &str) -> bool {
    ["text", "display_text", "sender_display"]
        .into_iter()
        .filter_map(|key| row.get(key).and_then(Value::as_str))
        .map(str::to_lowercase)
        .any(|value| value.contains(query_key))
}

fn limit_or_all(value: usize) -> Value {
    if value == 0 {
        Value::Null
    } else {
        json!(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_direct_r_conversation_id_without_discovery() {
        let resolved = resolve_conversation(" R:0000000001 ").unwrap();
        assert_eq!(resolved.conversation_id, "R:0000000001");
        assert_eq!(resolved.conversation_name, "");
    }

    #[test]
    fn resolves_direct_s_conversation_id_without_discovery() {
        let resolved = resolve_conversation("S:0000000001").unwrap();
        assert_eq!(resolved.conversation_id, "S:0000000001");
        assert_eq!(resolved.conversation_name, "");
    }

    #[test]
    fn rejects_empty_conversation_reference_before_runtime_access() {
        let error = resolve_conversation("   ").unwrap_err();
        assert!(error.to_string().contains("cannot be empty"));
    }

    #[test]
    fn filters_search_payload_by_decoded_text() {
        let payload = json!({
            "conversation_id": "R:0000000001",
            "conversation_name": "Synthetic Team",
            "total_message_ids": 3,
            "offset": 0,
            "exported_count": 3,
            "messages": [
                {
                    "message_id": 1,
                    "sender_display": "Synthetic Alice",
                    "text": "Alpha roadmap",
                    "display_text": "Alpha roadmap"
                },
                {
                    "message_id": 2,
                    "sender_display": "Synthetic Bob",
                    "text": "Beta note",
                    "display_text": "Beta note"
                },
                {
                    "message_id": 3,
                    "sender_display": "Synthetic Carol",
                    "text": "Alpha launch",
                    "display_text": "Alpha launch"
                }
            ]
        });

        let result = filter_search_payload(payload, "alpha", 1, 3).unwrap();
        assert_eq!(result["query"], "alpha");
        assert_eq!(result["scan_limit"], 3);
        assert_eq!(result["scanned_count"], 3);
        assert_eq!(result["matched_count"], 2);
        assert_eq!(result["returned_count"], 1);
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
        assert!(result.get("offset").is_none());
        assert!(result.get("exported_count").is_none());
    }

    #[test]
    fn filters_search_payload_by_sender_display() {
        let payload = json!({
            "conversation_id": "R:0000000001",
            "conversation_name": "Synthetic Team",
            "total_message_ids": 1,
            "exported_count": 1,
            "messages": [
                {
                    "message_id": 1,
                    "sender_display": "Synthetic Alice",
                    "text": "Roadmap",
                    "display_text": "Roadmap"
                }
            ]
        });

        let result = filter_search_payload(payload, "alice", 0, 1).unwrap();
        assert_eq!(result["matched_count"], 1);
        assert_eq!(result["returned_count"], 1);
    }

    #[test]
    fn rejects_empty_search_query_before_runtime_access() {
        let error = search_messages("R:0000000001", "   ", 20, 1000).unwrap_err();
        assert!(error.to_string().contains("search query cannot be empty"));
    }

    #[test]
    fn filters_history_with_inclusive_since_and_exclusive_until() {
        let start = Local
            .with_ymd_and_hms(2026, 8, 27, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp() as f64;
        let payload = json!({
            "exported_count": 3,
            "messages": [
                {"message_id": 1, "send_time": start - 1.0},
                {"message_id": 2, "send_time": start},
                {"message_id": 3, "send_time": start + 86_400.0}
            ]
        });
        let range = MessageTimeRange::parse(Some("2026-08-27"), Some("2026-08-28")).unwrap();

        let filtered = filter_history_by_time(payload, &range).unwrap();

        assert_eq!(filtered["since"], "2026-08-27");
        assert_eq!(filtered["until"], "2026-08-28");
        assert_eq!(filtered["scanned_count"], 3);
        assert_eq!(filtered["range_matched_count"], 1);
        assert_eq!(filtered["exported_count"], 1);
        assert_eq!(filtered["messages"][0]["message_id"], 2);
    }

    #[test]
    fn paginates_after_date_filtering() {
        let payload = json!({
            "range_matched_count": 3,
            "exported_count": 3,
            "messages": [
                {"message_id": 10},
                {"message_id": 11},
                {"message_id": 12}
            ]
        });

        let paged = paginate_history(payload, 1, 1).unwrap();

        assert_eq!(paged["range_matched_count"], 3);
        assert_eq!(paged["offset"], 1);
        assert_eq!(paged["exported_count"], 1);
        assert_eq!(paged["messages"][0]["message_id"], 11);
    }

    #[test]
    fn rejects_reversed_history_time_range() {
        let error = MessageTimeRange::parse(Some("2026-08-28"), Some("2026-08-27")).unwrap_err();
        assert!(error.to_string().contains("since must be earlier"));
    }
}
