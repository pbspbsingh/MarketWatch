use std::env;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn output(program: &str, args: &[&str]) -> Option<String> {
    let result = Command::new(program).args(args).output().ok()?;
    result
        .status
        .success()
        .then(|| String::from_utf8_lossy(&result.stdout).trim().to_owned())
}

fn main() {
    // Keep debug metadata current without running subprocesses or tracking frontend changes.
    for path in ["build.rs", "Cargo.toml", "Cargo.lock", "src"] {
        println!("cargo::rerun-if-changed={path}");
    }
    let profile = env::var("PROFILE").expect("Cargo must provide PROFILE");
    let built_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("build clock must be after the Unix epoch")
        .as_secs();
    println!("cargo::rustc-env=MARKET_WATCH_BUILD_BUILT_AT={built_at}");
    println!("cargo::rustc-env=MARKET_WATCH_BUILD_PROFILE={profile}");
    println!(
        "cargo::rustc-env=MARKET_WATCH_BUILD_TARGET={}",
        env::var("TARGET").expect("Cargo must provide TARGET")
    );

    if profile != "release" {
        println!("cargo::rustc-env=MARKET_WATCH_BUILD_GIT_COMMIT=");
        println!("cargo::rustc-env=MARKET_WATCH_BUILD_GIT_DIRTY=");
        println!("cargo::rustc-env=MARKET_WATCH_BUILD_RUSTC=Not collected in debug builds");
        return;
    }

    // Production metadata also follows embedded assets and optional Git state.
    for path in [
        "frontend/src",
        "frontend/scripts",
        "frontend/vite.config.ts",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/dist_gzipped",
    ] {
        if Path::new(path).exists() {
            println!("cargo::rerun-if-changed={path}");
        }
    }
    if let Some(files) = output("git", &["ls-files", "-z"]) {
        for path in files.split('\0').filter(|path| !path.is_empty()) {
            println!("cargo::rerun-if-changed={path}");
        }
    }
    for entry in ["HEAD", "index", "refs", "packed-refs"] {
        if let Some(path) = output("git", &["rev-parse", "--git-path", entry])
            && Path::new(&path).exists()
        {
            println!("cargo::rerun-if-changed={path}");
        }
    }
    println!("cargo::rerun-if-env-changed=RUSTC");

    let commit = output("git", &["rev-parse", "--verify", "HEAD"]).unwrap_or_default();
    let dirty = output(
        "git",
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .map(|status| (!status.is_empty()).to_string())
    .unwrap_or_default();
    let rustc = env::var("RUSTC").expect("Cargo must provide RUSTC");
    let compiler = output(&rustc, &["--version"]).unwrap_or_else(|| "Unknown".into());

    for (key, value) in [
        ("GIT_COMMIT", commit),
        ("GIT_DIRTY", dirty),
        ("RUSTC", compiler),
    ] {
        println!("cargo::rustc-env=MARKET_WATCH_BUILD_{key}={value}");
    }
}
