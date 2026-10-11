//! Sidecar management for the Python backend.
//!
//! The backend is started as a child process in its *own process group* so the whole tree
//! (PyInstaller bootloader, `uv`, `sh -c ...`) can be terminated as a unit. The child prints one
//! JSON line `{"event":"ready","port":N,...}` on stdout once it listens on 127.0.0.1:N; until then
//! `backend_info` waits. On quit we ask the backend to shut down gracefully
//! (`POST /api/shutdown`), then escalate SIGTERM -> SIGKILL on the process group.
//!
//! Launch plans (first match wins):
//!   1. `JARVIS_BACKEND_URL` + `JARVIS_BACKEND_TOKEN`  attach to an externally started backend
//!   2. `JARVIS_BACKEND_CMD`                            run via `/bin/sh -c` (cwd = repository root in dev)
//!   3. debug builds                                    `uv run --project <repo>/backend jarvis-backend`
//!   4. release builds                                  `<Resources>/backend/jarvis-backend`

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The first start may have to load MLX / the Laya model.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const GRACEFUL_EXIT_WAIT: Duration = Duration::from_secs(5);
const TERM_WAIT: Duration = Duration::from_secs(3);
const KILL_WAIT: Duration = Duration::from_secs(2);
const STDERR_TAIL_LINES: usize = 60;

#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub base_url: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
struct ExitedPayload {
    code: Option<i32>,
    message: String,
    lines: Vec<String>,
}

#[derive(Clone)]
enum Phase {
    Starting,
    Ready(BackendInfo),
    Failed(String),
}

struct Proc {
    pid: i32,
    exited: Arc<AtomicBool>,
}

struct Inner {
    phase: Phase,
    generation: u64,
    proc: Option<Proc>,
    quitting: bool,
}

pub struct Backend {
    inner: Mutex<Inner>,
    cv: Condvar,
    stderr_tail: Mutex<VecDeque<String>>,
}

enum Plan {
    Attach(BackendInfo),
    Spawn { command: Command, label: String },
}

impl Backend {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner { phase: Phase::Starting, generation: 0, proc: None, quitting: false }),
            cv: Condvar::new(),
            stderr_tail: Mutex::new(VecDeque::new()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    fn push_tail(&self, line: String) {
        let mut t = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        if t.len() >= STDERR_TAIL_LINES {
            t.pop_front();
        }
        t.push_back(line);
    }

    /// Start (or restart) the backend asynchronously. Returns immediately.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        let generation = {
            let mut g = self.lock();
            g.generation += 1;
            g.phase = Phase::Starting;
            g.proc = None;
            g.quitting = false;
            g.generation
        };
        self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let this = Arc::clone(self);
        let app = app.clone();
        std::thread::Builder::new()
            .name("backend-launcher".into())
            .spawn(move || this.launch(&app, generation))
            .expect("failed to spawn launcher thread");
    }

    /// Blocks until the backend is ready (or has failed). Called from the webview.
    pub fn info(&self) -> Result<BackendInfo, String> {
        let mut g = self.lock();
        loop {
            match &g.phase {
                Phase::Ready(info) => return Ok(info.clone()),
                Phase::Failed(msg) => return Err(msg.clone()),
                Phase::Starting => {
                    g = self.cv.wait(g).unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    }

    fn set_phase(&self, generation: u64, phase: Phase) -> bool {
        let mut g = self.lock();
        if g.generation != generation {
            return false;
        }
        g.phase = phase;
        self.cv.notify_all();
        true
    }

    fn launch(self: &Arc<Self>, app: &AppHandle, generation: u64) {
        match self.build_plan(app) {
            Err(msg) => {
                log::error!(target: "backend", "{msg}");
                self.set_phase(generation, Phase::Failed(msg));
            }
            Ok(Plan::Attach(info)) => {
                log::info!(target: "backend", "attaching to external backend at {}", info.base_url);
                self.set_phase(generation, Phase::Ready(info));
            }
            Ok(Plan::Spawn { command, label }) => self.spawn_and_wait(app, generation, command, label),
        }
    }

    fn build_plan(&self, app: &AppHandle) -> Result<Plan, String> {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());

        if let (Some(url), Some(token)) = (env("JARVIS_BACKEND_URL"), env("JARVIS_BACKEND_TOKEN")) {
            return Ok(Plan::Attach(BackendInfo { base_url: url.trim_end_matches('/').to_string(), token }));
        }

        let repo_root = repo_root();

        if let Some(cmd) = env("JARVIS_BACKEND_CMD") {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(&cmd);
            if let Some(root) = &repo_root {
                c.current_dir(root);
            }
            return Ok(Plan::Spawn { command: c, label: format!("JARVIS_BACKEND_CMD: {cmd}") });
        }

        if cfg!(debug_assertions) {
            let root = repo_root.ok_or_else(|| {
                "Development backend not found: the repository checkout this build was compiled from is gone. \
                 Set JARVIS_BACKEND_CMD or JARVIS_BACKEND_URL/JARVIS_BACKEND_TOKEN."
                    .to_string()
            })?;
            let backend_dir = root.join("backend");
            let mut c = Command::new("uv");
            c.args(["run", "--project"]).arg(&backend_dir).arg("jarvis-backend").current_dir(&root);
            return Ok(Plan::Spawn { command: c, label: format!("uv run --project {} jarvis-backend", backend_dir.display()) });
        }

        let resources = app.path().resource_dir().map_err(|e| format!("cannot resolve the resource directory: {e}"))?;
        let dir = resources.join("backend");
        let exe = dir.join("jarvis-backend");
        if !exe.is_file() {
            return Err(format!(
                "The bundled Jarvis engine is missing ({} not found). Rebuild the app with `make build`, or run it \
                 with JARVIS_BACKEND_CMD pointing at a backend.",
                exe.display()
            ));
        }
        let mut c = Command::new(&exe);
        c.current_dir(&dir);
        Ok(Plan::Spawn { command: c, label: exe.display().to_string() })
    }

    fn spawn_and_wait(self: &Arc<Self>, app: &AppHandle, generation: u64, mut cmd: Command, label: String) {
        let token = random_token();
        let data_dir = data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            log::warn!(target: "backend", "cannot create data dir {}: {e}", data_dir.display());
        }

        cmd.env("JARVIS_TOKEN", &token)
            .env("JARVIS_DATA_DIR", &data_dir)
            .env("JARVIS_PARENT_PID", std::process::id().to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("PATH", augmented_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0); // own process group => killpg() reaches the whole tree

        log::info!(target: "backend", "starting sidecar: {label}");
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let hint = if cfg!(debug_assertions) && e.kind() == std::io::ErrorKind::NotFound {
                    " (is `uv` installed and on PATH? https://docs.astral.sh/uv/)"
                } else {
                    ""
                };
                let msg = format!("Could not start the Jarvis engine ({label}): {e}{hint}");
                log::error!(target: "backend", "{msg}");
                self.set_phase(generation, Phase::Failed(msg));
                return;
            }
        };

        let pid = child.id() as i32;
        let exited = Arc::new(AtomicBool::new(false));
        {
            let mut g = self.lock();
            if g.generation != generation {
                // Superseded while spawning: do not leak the process.
                drop(g);
                signal_group(pid, libc::SIGKILL);
                let _ = child.wait();
                return;
            }
            g.proc = Some(Proc { pid, exited: Arc::clone(&exited) });
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // stderr -> Tauri log + ring buffer
        if let Some(stderr) = stderr {
            let this = Arc::clone(self);
            std::thread::Builder::new()
                .name("backend-stderr".into())
                .spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                        log::info!(target: "backend", "{line}");
                        this.push_tail(line);
                    }
                })
                .ok();
        }

        // stdout -> ready line (then keep draining so the pipe never fills)
        let (tx, rx) = mpsc::channel::<Result<u16, String>>();
        if let Some(stdout) = stdout {
            let this = Arc::clone(self);
            std::thread::Builder::new()
                .name("backend-stdout".into())
                .spawn(move || {
                    let mut sent = false;
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if !sent {
                            if let Some(port) = parse_ready(&line) {
                                sent = true;
                                let _ = tx.send(Ok(port));
                                continue;
                            }
                        }
                        log::info!(target: "backend", "[stdout] {line}");
                        this.push_tail(line);
                    }
                    if !sent {
                        let _ = tx.send(Err("the engine closed its output before it was ready".into()));
                    }
                })
                .ok();
        } else {
            let _ = tx.send(Err("no stdout pipe".into()));
        }

        // exit monitor: owns the Child
        {
            let this = Arc::clone(self);
            let app = app.clone();
            let exited = Arc::clone(&exited);
            std::thread::Builder::new()
                .name("backend-monitor".into())
                .spawn(move || {
                    let status = child.wait();
                    exited.store(true, Ordering::SeqCst);
                    this.on_exit(&app, generation, status.ok());
                })
                .ok();
        }

        match rx.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(port)) => {
                let info = BackendInfo { base_url: format!("http://127.0.0.1:{port}"), token };
                if self.set_phase(generation, Phase::Ready(info)) {
                    log::info!(target: "backend", "sidecar ready on port {port} (pid {pid})");
                }
            }
            Ok(Err(reason)) => {
                // Give the exit monitor a moment to report the real exit status first; it wins if it did.
                std::thread::sleep(Duration::from_millis(400));
                let still_starting = matches!(self.lock().phase, Phase::Starting);
                if still_starting {
                    let tail = self.tail();
                    let msg = failure_message(&format!("The Jarvis engine failed to start: {reason}."), &tail);
                    self.set_phase(generation, Phase::Failed(msg));
                }
            }
            Err(_) => {
                log::error!(target: "backend", "sidecar did not become ready within {READY_TIMEOUT:?}; killing it");
                signal_group(pid, libc::SIGKILL);
                let tail = self.tail();
                let msg = failure_message(
                    &format!("The Jarvis engine did not become ready within {} seconds.", READY_TIMEOUT.as_secs()),
                    &tail,
                );
                self.set_phase(generation, Phase::Failed(msg));
            }
        }
    }

    fn on_exit(&self, app: &AppHandle, generation: u64, status: Option<ExitStatus>) {
        let (code, how) = match status {
            Some(s) => match (s.code(), s.signal()) {
                (Some(c), _) => (Some(c), format!("exit code {c}")),
                (None, Some(sig)) => (None, format!("signal {sig}")),
                _ => (None, "unknown status".to_string()),
            },
            None => (None, "unknown status".to_string()),
        };
        log::warn!(target: "backend", "sidecar process ended ({how})");
        let message = {
            let mut g = self.lock();
            if g.generation != generation || g.quitting {
                return;
            }
            let tail = self.tail();
            let headline = if matches!(g.phase, Phase::Starting) {
                format!("The Jarvis engine exited before it was ready ({how}).")
            } else {
                format!("The Jarvis engine stopped unexpectedly ({how}).")
            };
            let msg = failure_message(&headline, &tail);
            g.phase = Phase::Failed(msg.clone());
            g.proc = None;
            self.cv.notify_all();
            msg
        };
        let _ = app.emit("backend-exited", ExitedPayload { code, message, lines: self.tail() });
    }

    /// Terminates the current sidecar (if we own one): graceful HTTP shutdown, then SIGTERM, then SIGKILL.
    fn terminate(&self) {
        let (proc, info) = {
            let mut g = self.lock();
            g.generation += 1; // makes the exit monitor / launcher ignore this process from now on
            let info = match &g.phase {
                Phase::Ready(i) => Some(i.clone()),
                _ => None,
            };
            (g.proc.take(), info)
        };
        let Some(proc) = proc else { return };
        if proc.exited.load(Ordering::SeqCst) {
            return;
        }

        if let Some(info) = &info {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(3)))
                .http_status_as_error(false)
                .build()
                .into();
            let url = format!("{}/api/shutdown", info.base_url);
            match agent.post(&url).header("Authorization", format!("Bearer {}", info.token)).send_empty() {
                Ok(resp) => log::info!(target: "backend", "POST /api/shutdown -> {}", resp.status()),
                Err(e) => log::warn!(target: "backend", "POST /api/shutdown failed: {e}"),
            }
            if wait_exited(&proc.exited, GRACEFUL_EXIT_WAIT) {
                log::info!(target: "backend", "sidecar exited gracefully");
                return;
            }
            log::warn!(target: "backend", "sidecar did not exit within {GRACEFUL_EXIT_WAIT:?}; sending SIGTERM");
        } else {
            log::warn!(target: "backend", "sidecar not ready; sending SIGTERM");
        }

        signal_group(proc.pid, libc::SIGTERM);
        if wait_exited(&proc.exited, TERM_WAIT) {
            return;
        }
        log::warn!(target: "backend", "sidecar ignored SIGTERM; sending SIGKILL to its process group");
        signal_group(proc.pid, libc::SIGKILL);
        wait_exited(&proc.exited, KILL_WAIT);
    }

    /// Stop the sidecar and start a fresh one (UI "Restart" button).
    pub fn restart(self: &Arc<Self>, app: &AppHandle) {
        self.terminate();
        self.start(app);
    }

    /// Final shutdown when the app quits. Never leaves an orphan.
    pub fn shutdown(&self) {
        {
            let mut g = self.lock();
            g.quitting = true;
        }
        self.terminate();
    }
}

fn wait_exited(flag: &AtomicBool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if flag.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    flag.load(Ordering::SeqCst)
}

fn signal_group(pid: i32, sig: i32) {
    // SAFETY: killpg with a pid obtained from a child we spawned (its pgid == pid via process_group(0)).
    unsafe {
        libc::killpg(pid, sig);
    }
}

fn parse_ready(line: &str) -> Option<u16> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event")?.as_str()? != "ready" {
        return None;
    }
    u16::try_from(v.get("port")?.as_u64()?).ok().filter(|p| *p != 0)
}

fn failure_message(headline: &str, tail: &[String]) -> String {
    if tail.is_empty() {
        return headline.to_string();
    }
    let last: Vec<&str> = tail.iter().rev().take(12).map(String::as_str).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{headline}\n\nLast engine output:\n{}", last.join("\n"))
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("system random number generator unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("JARVIS_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    Path::new(&home).join("Library/Application Support/Jarvis")
}

/// GUI apps launched from Finder get a minimal PATH; add the usual tool locations (uv, node, brew).
fn augmented_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(String::from).collect();
    for extra in [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ] {
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

/// `<repo>/app/src-tauri/../..` as compiled; only meaningful on the machine that built the app.
fn repo_root() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let p = p.canonicalize().ok()?;
    p.is_dir().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_ready_line() {
        assert_eq!(parse_ready(r#"{"event":"ready","port":53211,"version":"0.1.0","pid":1234}"#), Some(53211));
        assert_eq!(parse_ready("  {\"event\":\"ready\",\"port\":80}  "), Some(80));
        assert_eq!(parse_ready(r#"{"event":"ready","port":0}"#), None);
        assert_eq!(parse_ready(r#"{"event":"ready","port":70000}"#), None);
        assert_eq!(parse_ready(r#"{"event":"log","port":1}"#), None);
        assert_eq!(parse_ready("INFO: Uvicorn running"), None);
        assert_eq!(parse_ready(""), None);
    }

    #[test]
    fn tokens_are_256_bit_hex_and_unique() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn failure_message_keeps_the_last_lines() {
        let tail: Vec<String> = (0..30).map(|i| format!("line {i}")).collect();
        let msg = failure_message("It broke.", &tail);
        assert!(msg.starts_with("It broke."));
        assert!(msg.contains("line 29"));
        assert!(!msg.contains("line 5\n"));
        assert_eq!(failure_message("Plain.", &[]), "Plain.");
    }

    #[test]
    fn path_gets_the_usual_tool_locations() {
        let p = augmented_path();
        assert!(p.split(':').any(|s| s == "/opt/homebrew/bin"));
        assert!(p.split(':').any(|s| s == "/usr/bin"));
    }

    #[test]
    fn process_group_kill_takes_down_the_whole_tree() {
        // sh (group leader) -> sleep: killing the group must end both.
        let mut child = Command::new("/bin/sh").args(["-c", "sleep 30 & wait"]).process_group(0).spawn().unwrap();
        let pid = child.id() as i32;
        std::thread::sleep(Duration::from_millis(200));
        signal_group(pid, libc::SIGKILL);
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(200));
        // no process of that group is left
        let alive = unsafe { libc::killpg(pid, 0) } == 0;
        assert!(!alive);
        let flag = AtomicBool::new(false);
        assert!(!wait_exited(&flag, Duration::from_millis(120)));
        flag.store(true, Ordering::SeqCst);
        assert!(wait_exited(&flag, Duration::from_millis(120)));
    }
}
