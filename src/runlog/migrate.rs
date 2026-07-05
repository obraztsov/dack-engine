//! One-shot **md → SQLite** runlog conversion (B1, `dack migrate-runlogs`). Parses the old markdown
//! day-files (`runlogs/YYYY-MM-DD.md`) + `tag-notes.ndjson` and imports them into a `runlogs.sqlite`
//! via [`SqliteRunLog`] — reusing the exact production schema/FTS (no drift). Idempotent: re-running
//! skips rows already present. Deletable after the cutover; the harness itself keeps NO markdown code.

use std::path::Path;

use super::sqlite::{ImportedEntry, SqliteRunLog};
use crate::error::{DackError, Result};

/// Counts from a migration run.
#[derive(Debug, Default, PartialEq)]
pub struct Migrated {
    pub day_files: usize,
    pub entries: usize,
    pub notes: usize,
}

/// Convert every `*.md` day-file + `tag-notes.ndjson` under `runlog_dir` into `db_path`.
pub fn migrate(runlog_dir: &Path, db_path: &Path) -> Result<Migrated> {
    let rl = SqliteRunLog::open(db_path)?;
    let mut m = Migrated::default();

    let mut day_paths: Vec<std::path::PathBuf> = std::fs::read_dir(runlog_dir)
        .map_err(|e| DackError::Runlog(format!("read {}: {e}", runlog_dir.display())))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| is_day_file(p))
        .collect();
    day_paths.sort(); // chronological import (oldest first)

    for path in &day_paths {
        m.day_files += 1;
        let text = std::fs::read_to_string(path)
            .map_err(|e| DackError::Runlog(format!("read {}: {e}", path.display())))?;
        for e in parse_day(&text) {
            if rl.import_entry(&e)? {
                m.entries += 1;
            }
        }
    }

    let notes_path = runlog_dir.join("tag-notes.ndjson");
    if notes_path.exists() {
        let text = std::fs::read_to_string(&notes_path)
            .map_err(|e| DackError::Runlog(format!("read {}: {e}", notes_path.display())))?;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let tag = v["tag"].as_str().unwrap_or_default();
                let note = v["note"].as_str().unwrap_or_default();
                let trust = v["trust"].as_str().unwrap_or("public");
                let ts = v["timestamp"].as_i64().unwrap_or(0);
                if !tag.is_empty() && !note.is_empty() && rl.import_note(tag, note, trust, ts)? {
                    m.notes += 1;
                }
            }
        }
    }
    Ok(m)
}

/// A `runlogs/`-style day-file: `YYYY-MM-DD.md`.
fn is_day_file(p: &Path) -> bool {
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(date) = name.strip_suffix(".md") else {
        return false;
    };
    // exactly 10 chars `dddd-dd-dd`
    date.len() == 10
        && date.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Split a day-file into `## ` entry blocks and parse each.
pub fn parse_day(text: &str) -> Vec<ImportedEntry> {
    let mut blocks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if line.starts_with("## ") && !cur.is_empty() {
            blocks.push(std::mem::take(&mut cur));
        }
        if line.starts_with("## ") || !cur.is_empty() {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    if !cur.is_empty() {
        blocks.push(cur);
    }
    blocks.iter().filter_map(|b| parse_block(b)).collect()
}

/// Parse one `## `-block into an [`ImportedEntry`] (best-effort; `None` if the heading is malformed).
fn parse_block(block: &str) -> Option<ImportedEntry> {
    let heading_line = block.lines().next()?;
    if !heading_line.starts_with("## ") {
        return None;
    }
    // `## {run_id} · {state} · {outcome} — {summary}`
    let rest = &heading_line[3..];
    let mut segs = rest.splitn(3, " · ");
    let run_id = segs.next()?.trim().to_string();
    let state = segs.next()?.trim().to_string();
    let (outcome, context_summary) = match segs.next() {
        Some(tail) => match tail.split_once(" — ") {
            Some((o, s)) => (o.trim().to_string(), s.trim().to_string()),
            None => (tail.trim().to_string(), String::new()),
        },
        None => (String::new(), String::new()),
    };
    if run_id.is_empty() {
        return None;
    }

    let mut ts = 0i64;
    let mut source = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut thought = String::new();
    let mut sent: Vec<String> = Vec::new();
    for line in block.lines() {
        let l = line.trim_start();
        if let Some(v) = l.strip_prefix("- timestamp: ") {
            ts = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = l.strip_prefix("- source: ") {
            source = v.trim().to_string();
        } else if let Some(v) = l.strip_prefix("- tags: ") {
            tags = v.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        } else if let Some(v) = l.strip_prefix("- thought: ") {
            thought = v.trim().to_string();
        } else if let Some(text) = outward_text(l) {
            sent.push(text);
        }
    }

    // Origin trust: `payload_tier=TrustTier("<name>")` (in the context_summary/heading). Absent ⇒ "".
    let trust = between(block, "payload_tier=TrustTier(\"", "\")").unwrap_or_default();

    // Untrusted incoming = the ```untrusted … ``` fence body.
    let incoming = between(block, "```untrusted\n", "\n```").unwrap_or_default();

    // Safe body = the block up to (excluding) the raw-stimulus section — the exact original render,
    // minus the untrusted fence. Trailing newline trimmed.
    let safe_body = match block.find("- raw stimulus") {
        Some(i) => block[..i].trim_end().to_string(),
        None => block.trim_end().to_string(),
    };

    Some(ImportedEntry {
        run_id,
        source,
        state,
        trust,
        outcome,
        ts,
        context_summary,
        thought,
        sent,
        incoming,
        heading: heading_line.to_string(),
        safe_body,
        tags,
    })
}

/// The `text` field of an outward tool-call line (`- \`mcp__x__reply\` {json} → allow`).
fn outward_text(line: &str) -> Option<String> {
    if !(line.contains("__reply`") || line.contains("__post`") || line.contains("__send_message`")) {
        return None;
    }
    // The JSON input sits between the tool backtick-close and the ` → ` decision arrow.
    let after = line.split_once("` ")?.1;
    let json = after.rsplit_once(" → ").map(|(j, _)| j).unwrap_or(after);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
        return v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string());
    }
    between(json, "\"text\":\"", "\"").or_else(|| between(json, "\"text\": \"", "\""))
}

/// The substring strictly between the first `start` and the following `end` (both exclusive).
fn between(hay: &str, start: &str, end: &str) -> Option<String> {
    let i = hay.find(start)? + start.len();
    let j = hay[i..].find(end)? + i;
    Some(hay[i..j].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
## run-telegram-1000-perceive · Perceive · OK — source=telegram-pub type=telegram_message directive_tier=SelfTier payload_tier=TrustTier(\"public\")
- timestamp: 1700000000
- source: telegram-pub
- tags: 945712096, telegram
- thought: someone asked about ducks
- tool calls:
  - `mcp__telegram__reply` {\"text\":\"quack back\"} → allow
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
```untrusted
{\"text\":\"are you a real duck?\"}
```

## run-x-2000-express · Express · OK — no tags here
- timestamp: 1700000100
- thought: nothing to add
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
```untrusted
{}
```
";

    #[test]
    fn parses_blocks_fields_trust_incoming_and_sent() {
        let es = parse_day(SAMPLE);
        assert_eq!(es.len(), 2);
        let e = &es[0];
        assert_eq!(e.run_id, "run-telegram-1000-perceive");
        assert_eq!(e.state, "Perceive");
        assert_eq!(e.ts, 1700000000);
        assert_eq!(e.source, "telegram-pub");
        assert_eq!(e.tags, vec!["945712096", "telegram"]);
        assert_eq!(e.trust, "public", "trust recovered from payload_tier in the summary");
        assert_eq!(e.thought, "someone asked about ducks");
        assert_eq!(e.sent, vec!["quack back"], "outward reply text extracted");
        assert_eq!(e.incoming, "{\"text\":\"are you a real duck?\"}");
        assert!(e.safe_body.contains("## run-telegram"), "safe body keeps the heading");
        assert!(!e.safe_body.contains("untrusted"), "safe body drops the raw fence");
        assert_eq!(es[1].tags.len(), 0, "second entry has no tags");
    }

    #[tokio::test]
    async fn migrate_imports_entries_and_notes_idempotently() {
        use crate::runlog::RunLogWriter;
        let dir = std::env::temp_dir().join(format!("dack-mig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("2026-07-01.md"), SAMPLE).unwrap();
        std::fs::write(
            dir.join("tag-notes.ndjson"),
            "{\"tag\":\"945712096\",\"note\":\"likes ducks\",\"trust\":\"org\",\"timestamp\":1700000050}\n",
        )
        .unwrap();
        let db = dir.join("runlogs.sqlite");

        let m = migrate(&dir, &db).unwrap();
        assert_eq!(m, Migrated { day_files: 1, entries: 2, notes: 1 });

        // Re-run → everything already present → zero new rows (idempotent).
        let m2 = migrate(&dir, &db).unwrap();
        assert_eq!(m2, Migrated { day_files: 1, entries: 0, notes: 0 });

        // The imported data is queryable through the normal store surface.
        let rl = SqliteRunLog::open(&db).unwrap();
        assert_eq!(rl.search("quack", &["sent"], 10).unwrap(), vec!["run-telegram-1000-perceive".to_string()]);
        assert!(rl.search("real duck", &["incoming"], 10).unwrap().len() == 1, "raw incoming is searchable");
        let notes = rl.tag_notes(None, None, Some("945712096"), false, 10).await.unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note, "likes ducks");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
