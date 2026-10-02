use crate::app::AppState;
use axum::http::header;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct BuildInfo {
    version: &'static str,
    built_at: u64,
    git_commit: Option<&'static str>,
    git_dirty: Option<bool>,
    mode: &'static str,
    compiler: &'static str,
    target: &'static str,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/build-info", get(build_info))
}

async fn build_info() -> ([(header::HeaderName, &'static str); 1], Json<BuildInfo>) {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(BuildInfo {
            version: env!("CARGO_PKG_VERSION"),
            built_at: env!("MARKET_WATCH_BUILD_BUILT_AT")
                .parse()
                .expect("build timestamp must be Unix seconds"),
            git_commit: match env!("MARKET_WATCH_BUILD_GIT_COMMIT") {
                "" => None,
                commit => Some(commit),
            },
            git_dirty: match env!("MARKET_WATCH_BUILD_GIT_DIRTY") {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            },
            mode: env!("MARKET_WATCH_BUILD_PROFILE"),
            compiler: env!("MARKET_WATCH_BUILD_RUSTC"),
            target: env!("MARKET_WATCH_BUILD_TARGET"),
        }),
    )
}
