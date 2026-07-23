//! Shared git operations behind the [`RepoHost`](super::RepoHost) seam. Commits and pushes go
//! through plain `git`, so the single-remote ([`PlainGitRepo`](super::git::PlainGitRepo)) and
//! multi-remote ([`MultiRemoteRepo`](super::multi::MultiRemoteRepo)) hosts share *this* core and
//! differ only in how many remotes they fan out to.
//!
//! The duck "authors its own commits" via per-commit `git -c user.name=<DID>` — the commit
//! history is attributed to the Soul DID (on-thesis), while the *signing key* stays in the
//! `gl` identity dir the harness controls (never in agent env).

use std::path::PathBuf;

use tokio::process::Command;

use super::{CommitId, CommitMeta, RepoChange, RepoPath};
use crate::error::{DackError, Result};

pub struct GitCore {
    pub workdir: PathBuf,
    /// DID used to attribute harness-authored commits (e.g. reverts) when no per-commit
    /// author is supplied.
    pub default_author: String,
}

impl GitCore {
    pub fn new(workdir: impl Into<PathBuf>, default_author: impl Into<String>) -> Self {
        Self {
            workdir: workdir.into(),
            default_author: default_author.into(),
        }
    }

    /// Run `git -C <workdir> <args>` and return stdout, or an error carrying stderr.
    async fn git(&self, args: &[&str]) -> Result<String> {
        self.git_env(args, &[]).await
    }

    /// As [`git`](Self::git), but with extra environment overlaid — used to pass an ephemeral HTTPS
    /// credential helper's `DACK_GIT_USER`/`DACK_GIT_TOKEN` for a token push (out of argv).
    async fn git_env(&self, args: &[&str], env: &[(&str, String)]) -> Result<String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.workdir).args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd
            .output()
            .await
            .map_err(|e| DackError::Repo(format!("git spawn ({}): {e}", args.join(" "))))?;
        if !out.status.success() {
            return Err(DackError::Repo(format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    async fn head(&self) -> Result<CommitId> {
        Ok(CommitId(self.git(&["rev-parse", "HEAD"]).await?.trim().to_string()))
    }

    pub async fn read_file(&self, path: &RepoPath) -> Result<Vec<u8>> {
        let full = self.workdir.join(&path.0);
        tokio::fs::read(&full)
            .await
            .map_err(|e| DackError::Repo(format!("read {}: {e}", path.0)))
    }

    /// Write + commit a single file, attributed to `commit.author_did`. Idempotent: if the
    /// contents are unchanged, no empty commit is made and the current HEAD is returned.
    pub async fn write_file(
        &self,
        path: &RepoPath,
        contents: &[u8],
        commit: &CommitMeta,
    ) -> Result<CommitId> {
        let full = self.workdir.join(&path.0);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| DackError::Repo(format!("mkdir {}: {e}", path.0)))?;
        }
        // ATOMIC replace: write to a unique temp in the same dir, then rename over the target. A
        // concurrent READER (the recall MCP runs in its OWN process, so it can't share a lock) thus
        // sees either the whole old file or the whole new one — never a half-written/truncated file.
        // The nonce keeps two writes to the same path from colliding on the temp name.
        static TMP_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = TMP_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = std::path::PathBuf::from(format!(
            "{}.tmp.{}.{nonce}",
            full.display(),
            std::process::id()
        ));
        tokio::fs::write(&tmp, contents)
            .await
            .map_err(|e| DackError::Repo(format!("write {}: {e}", path.0)))?;
        if let Err(e) = tokio::fs::rename(&tmp, &full).await {
            let _ = tokio::fs::remove_file(&tmp).await; // best-effort cleanup of the orphan temp
            return Err(DackError::Repo(format!("rename {}: {e}", path.0)));
        }
        self.git(&["add", "--", &path.0]).await?;

        // Nothing staged for this path (unchanged) → don't create an empty commit.
        let staged = self
            .git(&["status", "--porcelain", "--", &path.0])
            .await?;
        if staged.trim().is_empty() {
            return self.head().await;
        }
        self.commit_path(&path.0, &commit.message, &commit.author_did).await
    }

    /// Revert one file to its prior committed version — the ONE rollback case:
    /// a malformed skill/stimulus that broke a run. If the file has earlier history, check
    /// out the parent version; if it was only ever introduced once, remove it. The revert
    /// is itself committed (harness-authored).
    pub async fn revert_file(&self, path: &RepoPath) -> Result<CommitId> {
        let log = self
            .git(&["log", "-n", "2", "--format=%H", "--", &path.0])
            .await?;
        let hashes: Vec<&str> = log.lines().filter(|l| !l.is_empty()).collect();
        if hashes.len() >= 2 {
            // Restore the version from the commit before the latest one touching the path.
            self.git(&["checkout", hashes[1], "--", &path.0]).await?;
        } else {
            // Only one commit ever introduced it → the prior state is "absent".
            self.git(&["rm", "-f", "--", &path.0]).await?;
        }
        let author = self.default_author.clone();
        self.commit_path(&path.0, &format!("revert malformed {}", path.0), &author)
            .await
    }

    /// Delete a tracked file and commit the removal (harness-authored). Used by runlog retention to
    /// age off old day-files. A no-op (returns HEAD) if the path isn't tracked/present.
    pub async fn remove(&self, path: &RepoPath, message: &str, author: &str) -> Result<CommitId> {
        if self.git(&["rm", "-f", "--", &path.0]).await.is_err() {
            return self.head().await; // not tracked / already gone — nothing to do.
        }
        self.commit_path(&path.0, message, author).await
    }

    /// List files under `path` (filesystem walk, `.git` excluded) to `max_depth` relative
    /// to `path` — used by the `stimuli/` walker (depth ≤ 2) and memory `ls`.
    pub async fn list_dir(&self, path: &RepoPath, max_depth: usize) -> Result<Vec<RepoPath>> {
        let root = self.workdir.join(&path.0);
        let mut out = Vec::new();
        // Iterative walk to avoid async recursion. Stack of (abs_dir, depth).
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let mut rd = match tokio::fs::read_dir(&dir).await {
                Ok(rd) => rd,
                Err(_) => continue, // path may not exist yet
            };
            while let Some(entry) = rd
                .next_entry()
                .await
                .map_err(|e| DackError::Repo(format!("readdir: {e}")))?
            {
                let name = entry.file_name();
                if name == ".git" {
                    continue;
                }
                let abs = entry.path();
                let ft = entry
                    .file_type()
                    .await
                    .map_err(|e| DackError::Repo(format!("filetype: {e}")))?;
                if ft.is_dir() {
                    if depth + 1 <= max_depth {
                        stack.push((abs, depth + 1));
                    }
                } else if let Ok(rel) = abs.strip_prefix(&self.workdir) {
                    out.push(RepoPath(rel.to_string_lossy().into_owned()));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Commit a single pathspec attributed to `author_did` (author + committer), with no
    /// dependence on global git config.
    async fn commit_path(&self, path: &str, message: &str, author_did: &str) -> Result<CommitId> {
        let name = format!("user.name={author_did}");
        let email = format!("user.email={author_did}@dack");
        self.git(&[
            "-c", &name, "-c", &email, "commit", "-m", message, "--", path,
        ])
        .await?;
        self.head().await
    }

    /// The working-tree delta vs HEAD (untracked files included), as porcelain entries.
    /// `--porcelain=v1 -z`-free parse: each line is `XY <path>`; renames (`R`) report the
    /// destination. Empty result = clean tree.
    pub async fn status_porcelain(&self) -> Result<Vec<RepoChange>> {
        let out = self
            .git(&["status", "--porcelain", "--untracked-files=all"])
            .await?;
        let mut changes = Vec::new();
        for line in out.lines() {
            if line.len() < 4 {
                continue;
            }
            let code = line[..2].to_string();
            // Path starts at column 3. A rename prints `orig -> dest`; the dest is what changed.
            let rest = &line[3..];
            let raw = rest.rsplit(" -> ").next().unwrap_or(rest).trim();
            // git quotes paths containing special chars; strip the surrounding quotes.
            let path = raw.trim_matches('"').to_string();
            changes.push(RepoChange {
                code,
                path: RepoPath(path),
            });
        }
        Ok(changes)
    }

    /// Stage exactly `paths` (new/modified/deleted) and commit them attributed to `author_did`.
    /// `Ok(None)` when nothing was staged (the tree was already clean for these paths) — never
    /// an empty commit. The per-run sweep's committer for tool-driven `Write`/`Edit`.
    pub async fn commit_paths(
        &self,
        paths: &[RepoPath],
        message: &str,
        author_did: &str,
    ) -> Result<Option<CommitId>> {
        if paths.is_empty() {
            return Ok(None);
        }
        let mut add: Vec<&str> = vec!["add", "-A", "--"];
        add.extend(paths.iter().map(|p| p.0.as_str()));
        self.git(&add).await?;

        // Anything actually staged among these paths? (Avoid an empty commit.)
        let mut diff: Vec<&str> = vec!["diff", "--cached", "--name-only", "--"];
        diff.extend(paths.iter().map(|p| p.0.as_str()));
        if self.git(&diff).await?.trim().is_empty() {
            return Ok(None);
        }

        let name = format!("user.name={author_did}");
        let email = format!("user.email={author_did}@dack");
        let mut commit: Vec<&str> =
            vec!["-c", &name, "-c", &email, "commit", "-m", message, "--"];
        commit.extend(paths.iter().map(|p| p.0.as_str()));
        self.git(&commit).await?;
        Ok(Some(self.head().await?))
    }

    /// Discard a working-tree change, restoring it to HEAD: `checkout HEAD -- <path>` for a
    /// tracked file, or delete the file for an untracked one. The tripwire's revert — no commit.
    pub async fn restore_to_head(&self, change: &RepoChange) -> Result<()> {
        if change.is_untracked() {
            let full = self.workdir.join(&change.path.0);
            tokio::fs::remove_file(&full)
                .await
                .map_err(|e| DackError::Repo(format!("rm untracked {}: {e}", change.path.0)))?;
        } else {
            self.git(&["checkout", "HEAD", "--", &change.path.0]).await?;
        }
        Ok(())
    }

    /// `git push <remote> HEAD:<branch>` with `env` overlaid (an ephemeral token credential, if any).
    /// The branch is HEAD's current branch.
    pub async fn push(&self, remote: &str, env: &[(&str, String)]) -> Result<()> {
        self.push_with(remote, env, &[]).await
    }

    /// As [`push`](Self::push), but with extra `-c <cfg>` overrides prepended — used to inject an
    /// ephemeral HTTPS credential helper (`credential.helper=…`) for a plain-git token push, so the
    /// token rides in `env` (out of argv) while the helper that reads it rides in the config args.
    pub async fn push_with(
        &self,
        remote: &str,
        env: &[(&str, String)],
        config_args: &[String],
    ) -> Result<()> {
        let branch = self
            .git(&["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string();
        let refspec = format!("HEAD:refs/heads/{branch}");
        let mut args: Vec<&str> = Vec::with_capacity(config_args.len() * 2 + 3);
        for c in config_args {
            args.push("-c");
            args.push(c);
        }
        args.push("push");
        args.push(remote);
        args.push(&refspec);
        self.git_env(&args, env).await?;
        Ok(())
    }
}

/// The result of a boot-time reconcile against the remote (for logging + health).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileOutcome {
    /// Local HEAD already matches the remote — nothing to do.
    InSync,
    /// Local was strictly behind (clean) → fast-forwarded to the remote (adopted operator changes).
    FastForwarded,
    /// Local was strictly ahead (unpushed local commits; remote unchanged) → left as-is; the cycle
    /// push ships it.
    Ahead,
    /// Local and remote DIVERGED → snapshotted local HEAD to `backup_branch`, adopted the remote for
    /// everything, then restored the duck-owned `local_paths` (memory) from the snapshot + committed.
    Merged { backup_branch: String },
    /// Reconcile did NOT run (no remote, dirty working tree, or an offline fetch) — local is used
    /// as-is. `reason` says which.
    Skipped(String),
}

impl GitCore {
    /// Boot-time reconcile against `url`/`branch`, making the REMOTE authoritative for everything
    /// EXCEPT `local_paths` (the duck's own memory, kept local) — so an operator can reconfigure a
    /// duck by pushing config + restarting. SAFE by construction: never clobbers uncommitted work
    /// (skips a dirty tree), and a divergence snapshots local HEAD to a `pre-sync-<now>` branch before
    /// adopting the remote (nothing is ever lost). `now` (unix secs) names the snapshot + is passed in
    /// so this stays testable. An offline/failed fetch is non-fatal (uses local).
    pub async fn reconcile_with_remote(
        &self,
        url: &str,
        local_paths: &[String],
        author_did: &str,
        now: i64,
    ) -> Result<ReconcileOutcome> {
        // Never touch a dirty tree — the operator should `dack reconcile` (commit) first, else a
        // reset would silently discard their uncommitted hand-edits (which aren't in any snapshot).
        if !self.git(&["status", "--porcelain"]).await?.trim().is_empty() {
            return Ok(ReconcileOutcome::Skipped(
                "soul working tree has uncommitted changes — run `dack reconcile` first".into(),
            ));
        }
        let branch = self.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_string();
        // Fetch the remote branch → FETCH_HEAD. A fetch failure (offline / auth) is NON-fatal.
        if let Err(e) = self.git(&["fetch", url, &branch]).await {
            return Ok(ReconcileOutcome::Skipped(format!("fetch failed ({e}) — using local soul")));
        }
        let local = self.git(&["rev-parse", "HEAD"]).await?.trim().to_string();
        let remote = self.git(&["rev-parse", "FETCH_HEAD"]).await?.trim().to_string();
        if local == remote {
            return Ok(ReconcileOutcome::InSync);
        }
        let base = self
            .git(&["merge-base", &local, &remote])
            .await
            .ok()
            .map(|s| s.trim().to_string());
        match base.as_deref() {
            // Local is an ancestor of remote → strictly behind, CLEAN → fast-forward adopt.
            Some(b) if b == local => {
                self.git(&["reset", "--hard", &remote]).await?;
                Ok(ReconcileOutcome::FastForwarded)
            }
            // Remote is an ancestor of local → local is ahead (unpushed) → leave it; push ships it.
            Some(b) if b == remote => Ok(ReconcileOutcome::Ahead),
            // Diverged (or unrelated histories): snapshot local, adopt remote, restore duck-owned paths.
            _ => {
                let backup = format!("pre-sync-{now}");
                self.git(&["branch", "-f", &backup, &local]).await?; // snapshot local HEAD (safety net)
                self.git(&["reset", "--hard", &remote]).await?; // adopt remote wholesale
                for p in local_paths {
                    // Restore the duck-owned path (memory) from the snapshot. A path absent in the
                    // snapshot just errors harmlessly (ignored).
                    let _ = self.git(&["checkout", &backup, "--", p]).await;
                }
                self.git(&["add", "-A"]).await?;
                if self.git(&["status", "--porcelain"]).await?.trim().is_empty() {
                    // Remote already matched local memory → no merge commit needed.
                    return Ok(ReconcileOutcome::Merged { backup_branch: backup });
                }
                let name = format!("user.name={author_did}");
                let email = format!("user.email={author_did}@dack");
                let msg = format!("reconcile: adopt remote, keep local {}", local_paths.join(","));
                self.git(&["-c", &name, "-c", &email, "commit", "-m", &msg]).await?;
                Ok(ReconcileOutcome::Merged { backup_branch: backup })
            }
        }
    }
}

/// Is a `git push` failure TRANSIENT (worth a backoff-retry) vs PERMANENT (auth / non-fast-forward /
/// bad repo — retrying can't fix it, fail fast)? Used by the multi-remote push retry loop.
pub(crate) fn is_transient_push_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    [
        "500", "502", "503", "504",
        "internal server error", "bad gateway", "service unavailable", "gateway timeout",
        "unexpected disconnect", "hung up", "sideband", "early eof", "rpc failed",
        "timed out", "timeout", "connection reset", "connection refused", "broken pipe",
        "could not read from remote", "failed to connect", "temporarily unavailable",
    ]
    .iter()
    .any(|p| m.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo(tag: &str) -> PathBuf {
        // A throwaway repo under the system temp dir (no tempfile crate dependency).
        // `tag` keeps concurrent tests in the same binary (shared pid) from clobbering each other.
        let dir = std::env::temp_dir().join(format!("dack-gitcore-{}-{tag}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "seed"],
            vec!["config", "user.email", "seed@dack"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .await
                .unwrap();
        }
        dir
    }

    // ── reconcile_with_remote helpers ────────────────────────────────────────────
    async fn git(dir: &std::path::Path, args: &[&str]) {
        Command::new("git").arg("-C").arg(dir).args(args).output().await.unwrap();
    }
    async fn writef(dir: &std::path::Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        tokio::fs::create_dir_all(p.parent().unwrap()).await.unwrap();
        tokio::fs::write(&p, content).await.unwrap();
    }
    async fn readf(dir: &std::path::Path, rel: &str) -> String {
        tokio::fs::read_to_string(dir.join(rel)).await.unwrap_or_default()
    }
    /// A bare remote + a work repo (soul) sharing an initial commit (`prompts/p.md` + `memory/m.md`),
    /// with `work` pushed to the bare. Returns (bare_url, work_dir, GitCore-over-work).
    async fn setup_reconcile(tag: &str) -> (String, PathBuf, GitCore) {
        let base = std::env::temp_dir().join(format!("dack-reconcile-{}-{tag}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&base).await;
        let bare = base.join("remote.git");
        let work = base.join("work");
        tokio::fs::create_dir_all(&work).await.unwrap();
        Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).output().await.unwrap();
        for a in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "seed"],
            vec!["config", "user.email", "s@d"],
        ] {
            git(&work, &a).await;
        }
        writef(&work, "prompts/p.md", "base-config\n").await;
        writef(&work, "memory/m.md", "base-mem\n").await;
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-q", "-m", "init"]).await;
        let bare_url = bare.to_string_lossy().to_string();
        git(&work, &["push", "-q", &bare_url, "HEAD:refs/heads/main"]).await;
        let core = GitCore::new(&work, "did:key:zSoul");
        (bare_url, work, core)
    }
    /// Simulate an OPERATOR editing `rel`=`content` on the remote (clone bare → edit → push).
    async fn operator_push(bare_url: &str, tag: &str, rel: &str, content: &str) {
        let op = std::env::temp_dir().join(format!("dack-op-{}-{tag}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&op).await;
        Command::new("git").args(["clone", "-q", bare_url]).arg(&op).output().await.unwrap();
        git(&op, &["config", "user.name", "op"]).await;
        git(&op, &["config", "user.email", "op@d"]).await;
        writef(&op, rel, content).await;
        git(&op, &["add", "-A"]).await;
        git(&op, &["commit", "-q", "-m", "operator edit"]).await;
        git(&op, &["push", "-q", "origin", "main"]).await;
    }
    const MEM: &[&str] = &["memory/"];

    #[tokio::test]
    async fn reconcile_in_sync_is_noop() {
        let (url, _w, core) = setup_reconcile("insync").await;
        let out = core.reconcile_with_remote(&url, &["memory/".into()], "did:key:zSoul", 1).await.unwrap();
        assert_eq!(out, ReconcileOutcome::InSync);
    }

    #[tokio::test]
    async fn reconcile_behind_fast_forwards_and_adopts_config() {
        let (url, work, core) = setup_reconcile("behind").await;
        operator_push(&url, "behind", "prompts/p.md", "operator-config\n").await;
        let out = core.reconcile_with_remote(&url, &["memory/".into()], "did:key:zSoul", 1).await.unwrap();
        assert_eq!(out, ReconcileOutcome::FastForwarded);
        assert_eq!(readf(&work, "prompts/p.md").await, "operator-config\n", "adopted the operator's config");
    }

    #[tokio::test]
    async fn reconcile_ahead_leaves_local_untouched() {
        let (url, work, core) = setup_reconcile("ahead").await;
        writef(&work, "memory/m.md", "duck-mem-v2\n").await; // an unpushed local commit
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-q", "-m", "duck memory"]).await;
        let out = core.reconcile_with_remote(&url, &["memory/".into()], "did:key:zSoul", 1).await.unwrap();
        assert_eq!(out, ReconcileOutcome::Ahead);
        assert_eq!(readf(&work, "memory/m.md").await, "duck-mem-v2\n", "local commits untouched");
    }

    #[tokio::test]
    async fn reconcile_diverged_adopts_remote_config_keeps_local_memory() {
        let (url, work, core) = setup_reconcile("div").await;
        // The DUCK edits its memory locally (unpushed) …
        writef(&work, "memory/m.md", "duck-mem-latest\n").await;
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-q", "-m", "duck memory"]).await;
        // … while the OPERATOR pushes a config change to the remote → DIVERGED.
        operator_push(&url, "div", "prompts/p.md", "operator-config\n").await;

        let out = core.reconcile_with_remote(&url, &MEM.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "did:key:zSoul", 42).await.unwrap();
        match out {
            ReconcileOutcome::Merged { backup_branch } => assert_eq!(backup_branch, "pre-sync-42"),
            other => panic!("expected Merged, got {other:?}"),
        }
        // Config adopted from the remote; memory KEPT from local — no loss either way.
        assert_eq!(readf(&work, "prompts/p.md").await, "operator-config\n", "config ← remote");
        assert_eq!(readf(&work, "memory/m.md").await, "duck-mem-latest\n", "memory ← local");
        // The pre-reconcile local HEAD is preserved as a branch (nothing lost).
        let branches = String::from_utf8_lossy(
            &Command::new("git").arg("-C").arg(&work).args(["branch", "--list", "pre-sync-42"]).output().await.unwrap().stdout,
        ).to_string();
        assert!(branches.contains("pre-sync-42"), "snapshot branch exists: {branches}");
    }

    #[tokio::test]
    async fn reconcile_skips_a_dirty_tree() {
        let (url, work, core) = setup_reconcile("dirty").await;
        operator_push(&url, "dirty", "prompts/p.md", "operator-config\n").await;
        writef(&work, "prompts/p.md", "uncommitted-local-edit\n").await; // dirty, NOT committed
        let out = core.reconcile_with_remote(&url, &["memory/".into()], "did:key:zSoul", 1).await.unwrap();
        assert!(matches!(out, ReconcileOutcome::Skipped(_)), "dirty tree is skipped, not clobbered");
        assert_eq!(readf(&work, "prompts/p.md").await, "uncommitted-local-edit\n", "uncommitted work preserved");
    }

    #[tokio::test]
    async fn write_read_list_and_revert_round_trip() {
        let dir = init_repo("rtrip").await;
        let core = GitCore::new(&dir, "did:key:zSoul");
        let path = RepoPath("memory/log.md".into());
        let meta = |m: &str| CommitMeta {
            message: m.into(),
            author_did: "did:key:zSoul".into(),
        };

        // v1
        core.write_file(&path, b"first\n", &meta("first")).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"first\n");

        // unchanged write → no new commit (idempotent)
        let h1 = core.write_file(&path, b"first\n", &meta("noop")).await.unwrap();
        let h1b = core.write_file(&path, b"first\n", &meta("noop")).await.unwrap();
        assert_eq!(h1, h1b, "unchanged content must not create a new commit");

        // v2
        core.write_file(&path, b"second\n", &meta("second")).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"second\n");

        // list_dir sees the file
        let listed = core.list_dir(&RepoPath("memory".into()), 2).await.unwrap();
        assert!(listed.iter().any(|p| p.0 == "memory/log.md"));

        // revert v2 → back to v1 (the malformed-file rollback case)
        core.revert_file(&path).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"first\n");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn status_sweep_and_tripwire_revert() {
        let dir = init_repo("sweep").await;
        let core = GitCore::new(&dir, "did:key:zSoul");
        // Seed a committed memory file so it has HEAD history.
        let mem = RepoPath("memory/log.md".into());
        core.write_file(&mem, b"seed\n", &CommitMeta { message: "seed".into(), author_did: "did:key:zSoul".into() })
            .await
            .unwrap();

        // Simulate a run's tool-driven writes straight to the working tree (no commit):
        // an ALLOWED memory append + a FORBIDDEN new skill file.
        tokio::fs::write(dir.join("memory/log.md"), b"seed\nagent note\n").await.unwrap();
        tokio::fs::create_dir_all(dir.join("skills/evil")).await.unwrap();
        tokio::fs::write(dir.join("skills/evil/SKILL.md"), b"injected\n").await.unwrap();

        // status sees both (one modified, one untracked).
        let changes = core.status_porcelain().await.unwrap();
        assert!(changes.iter().any(|c| c.path.0 == "memory/log.md" && !c.is_untracked()));
        let evil = changes.iter().find(|c| c.path.0 == "skills/evil/SKILL.md").unwrap().clone();
        assert!(evil.is_untracked(), "new skill file is untracked");

        // Tripwire: revert the forbidden untracked write → file gone, tree clean of it.
        core.restore_to_head(&evil).await.unwrap();
        assert!(!dir.join("skills/evil/SKILL.md").exists(), "forbidden write reverted");

        // Sweep: commit ONLY the allowlisted memory path → a real commit, attributed to Soul.
        let committed = core
            .commit_paths(&[mem.clone()], "run-x express: sweep", "did:key:zSoul")
            .await
            .unwrap();
        assert!(committed.is_some(), "the memory change was committed");
        assert_eq!(core.read_file(&mem).await.unwrap(), b"seed\nagent note\n");

        // Idempotent: a second sweep with nothing changed → no empty commit.
        assert!(core.commit_paths(&[mem], "noop", "did:key:zSoul").await.unwrap().is_none());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn push_to_local_bare_remote_offline() {
        let base = std::env::temp_dir().join(format!("dack-push-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&base).await;
        let work = base.join("work");
        let bare = base.join("remote.git");
        tokio::fs::create_dir_all(&work).await.unwrap();
        // A local bare remote stands in for a real git remote (the push path, offline-tested).
        Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).output().await.unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.name", "s"], vec!["config", "user.email", "s@d"]] {
            Command::new("git").arg("-C").arg(&work).args(&args).output().await.unwrap();
        }
        Command::new("git").arg("-C").arg(&work).args(["remote", "add", "origin"]).arg(&bare).output().await.unwrap();

        let core = GitCore::new(&work, "did:key:zSoul");
        core.write_file(&RepoPath("SOUL.md".into()), b"I am.\n", &CommitMeta { message: "genesis".into(), author_did: "did:key:zSoul".into() })
            .await
            .unwrap();
        core.push("origin", &[]).await.unwrap();

        // The bare remote now has the branch at our HEAD.
        let head = core.head().await.unwrap();
        let remote_ref = Command::new("git").arg("-C").arg(&bare).args(["rev-parse", "refs/heads/main"]).output().await.unwrap();
        assert_eq!(String::from_utf8_lossy(&remote_ref.stdout).trim(), head.0);

        let _ = tokio::fs::remove_dir_all(&base).await;
    }
}
