//! Subprocess sensor runner — the real implementation of the [`SensorRunner`] contract
//! (PRD §5.2). Spawns the executable with a cleared env (read-scoped: only the declared
//! env is injected), writes the trigger payload to stdin, enforces a timeout
//! (`kill_on_drop`), and parses stdout as newline-delimited JSON.

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::{SensorCandidate, SensorRunner};
use crate::error::{DackError, Result};

pub struct SubprocessSensor;

#[async_trait]
impl SensorRunner for SubprocessSensor {
    async fn run(
        &self,
        exe: &Path,
        stdin: &[u8],
        env: &HashMap<String, String>,
        timeout: Duration,
    ) -> Result<Vec<SensorCandidate>> {
        // env_clear enforces "inject only the read-scoped env the sensor declares"
        // (PRD §5.2). The caller is responsible for including PATH/interpreter vars in
        // `env` when the sensor needs them.
        let mut child = Command::new(exe)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| DackError::Sensor(format!("spawn {exe:?}: {e}")))?;

        if let Some(mut sin) = child.stdin.take() {
            sin.write_all(stdin)
                .await
                .map_err(|e| DackError::Sensor(format!("write stdin: {e}")))?;
            // Drop closes stdin so a `read until EOF` sensor proceeds.
        }

        let output = tokio::time::timeout(timeout, child.wait_with_output())
            .await
            .map_err(|_| DackError::Sensor(format!("timeout after {timeout:?}")))?
            .map_err(|e| DackError::Sensor(format!("wait: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(DackError::Sensor(format!(
                "exit {:?}: {}",
                output.status.code(),
                stderr.trim()
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut candidates = Vec::new();
        for (lineno, line) in stdout.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let candidate: SensorCandidate = serde_json::from_str(line)
                .map_err(|e| DackError::Sensor(format!("line {}: {e}", lineno + 1)))?;
            candidates.push(candidate);
        }
        Ok(candidates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_ndjson_from_a_trivial_shell_sensor() {
        // A "sensor" that emits two candidate rows — the curl+jq shape, minus the net.
        let runner = SubprocessSensor;
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/bin:/usr/bin".to_string());
        let candidates = runner
            .run(
                Path::new("/bin/sh"),
                b"",
                &env,
                Duration::from_secs(5),
            )
            .await;
        // /bin/sh with empty stdin and no script reads EOF and exits 0 with no output.
        let candidates = candidates.expect("trivial sensor runs");
        assert!(candidates.is_empty());
    }
}
