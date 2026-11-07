//! SuperAgent desktop shell.
//!
//! The app is a window onto the local SuperAgent daemon. On launch it checks the daemon's health
//! endpoint, starts it with `superagent start` if needed, then loads the UI the daemon serves.
//! Closing the window leaves the daemon running, so agents keep working in the background.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, Url, WebviewWindow};

const INSTALL_HELP: &str = "Install the SuperAgent CLI (needs Node.js 22.13 or newer):\n\n  npm install -g github:imthegoodboy/SuperAgent\n\nThen reopen this app, or run `superagent doctor` to check your setup.";

fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SUPERAGENT_HOME") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".superagent"))
}

/// The daemon port lives in ~/.superagent/config.json (default 7878).
fn port() -> u16 {
    data_dir()
        .and_then(|d| std::fs::read_to_string(d.join("config.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(7878)
}

fn healthy(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let request = format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"superagent\"")
}

#[cfg(windows)]
fn shell(cmd: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = Command::new("cmd");
    c.args(["/C", cmd]).creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(windows))]
fn shell(cmd: &str) -> Command {
    // Apps started from Finder or a desktop launcher don't get the shell PATH; use a login shell.
    let mut c = Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
    c.args(["-lc", cmd]);
    c
}

fn cli_installed() -> bool {
    let probe = if cfg!(windows) { "where superagent" } else { "command -v superagent" };
    shell(probe).output().map(|o| o.status.success()).unwrap_or(false)
}

fn show_error(window: &WebviewWindow, message: &str, help: &str) {
    // Give the splash page a moment to load its script.
    thread::sleep(Duration::from_millis(600));
    let js = format!(
        "window.showError && window.showError({}, {})",
        serde_json::to_string(message).unwrap_or_default(),
        serde_json::to_string(help).unwrap_or_default()
    );
    let _ = window.eval(&js);
}

fn connect(window: WebviewWindow) {
    let port = port();
    if !healthy(port) {
        if !cli_installed() {
            return show_error(&window, "The superagent command was not found.", INSTALL_HELP);
        }
        if let Err(e) = shell("superagent start").spawn() {
            return show_error(&window, "Could not start SuperAgent.", &e.to_string());
        }
        let deadline = Instant::now() + Duration::from_secs(40);
        while !healthy(port) {
            if Instant::now() > deadline {
                return show_error(
                    &window,
                    "SuperAgent did not start.",
                    "Run `superagent doctor` in a terminal to see what is missing,\nor check ~/.superagent/logs/daemon.log.",
                );
            }
            thread::sleep(Duration::from_millis(400));
        }
    }
    if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
        let _ = window.navigate(url);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the main window is defined in tauri.conf.json");
            thread::spawn(move || connect(window));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SuperAgent");
}
