use crate::config::AuthConfig;
use argon2::{Argon2, PasswordVerifier};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque, hash_map::RandomState};
use std::hash::BuildHasher;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tracing::{error, warn};

const PASSWORD_CHECK_WINDOW: Duration = Duration::from_secs(5);
const PASSWORD_CHECKS_PER_WINDOW: u8 = 5;
const PASSWORD_CHECK_SHARDS: usize = 32;
const MAX_LOG_VALUE_BYTES: usize = 256;

pub struct Auth {
    config: AuthConfig,
    verified_header: OnceLock<[u8; 32]>,
    password_checks: PasswordCheckLimiter,
}

impl Auth {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config,
            verified_header: OnceLock::new(),
            password_checks: PasswordCheckLimiter::new(),
        }
    }

    fn reserve_password_check(&self, ip: Option<IpAddr>) -> bool {
        self.password_checks.reserve(ip)
    }
}

struct PasswordCheckLimiter {
    hash_builder: RandomState,
    shards: [Mutex<PasswordCheckShard>; PASSWORD_CHECK_SHARDS],
}

impl PasswordCheckLimiter {
    fn new() -> Self {
        Self {
            hash_builder: RandomState::new(),
            shards: std::array::from_fn(|_| Mutex::new(PasswordCheckShard::default())),
        }
    }

    fn reserve(&self, ip: Option<IpAddr>) -> bool {
        let shard = self.hash_builder.hash_one(ip) as usize % PASSWORD_CHECK_SHARDS;
        let mut shard = self.shards[shard].lock().unwrap();
        shard.reserve(ip, Instant::now())
    }
}

#[derive(Default)]
struct PasswordCheckShard {
    recent: VecDeque<(Instant, Option<IpAddr>)>,
    counts: HashMap<Option<IpAddr>, u8>,
}

impl PasswordCheckShard {
    fn reserve(&mut self, ip: Option<IpAddr>, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|(checked_at, _)| now.duration_since(*checked_at) >= PASSWORD_CHECK_WINDOW)
        {
            let (_, expired_ip) = self.recent.pop_front().unwrap();
            let count = self.counts.get_mut(&expired_ip).unwrap();
            *count -= 1;
            if *count == 0 {
                self.counts.remove(&expired_ip);
            }
        }

        let count = self.counts.entry(ip).or_default();
        if *count >= PASSWORD_CHECKS_PER_WINDOW {
            return false;
        }
        *count += 1;
        self.recent.push_back((now, ip));
        true
    }
}

pub async fn require_auth(State(auth): State<Arc<Auth>>, request: Request, next: Next) -> Response {
    let ip = client_ip(&request);
    let credentials = parse_credentials(request.headers().get(header::AUTHORIZATION));
    let (username, password, header_digest) = match credentials {
        Ok(credentials) => credentials,
        Err(reason) => {
            log_rejection(&request, ip, None, reason);
            return unauthorized();
        }
    };

    if username != auth.config.username {
        log_rejection(&request, ip, Some(&username), "invalid_username");
        return unauthorized();
    }

    let cached = auth
        .verified_header
        .get()
        .is_some_and(|known| bool::from(known.ct_eq(&header_digest)));
    if !cached {
        if !auth.reserve_password_check(ip) {
            log_rejection(&request, ip, Some(&username), "rate_limited");
            return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "5")]).into_response();
        }
        let auth_for_check = auth.clone();
        let valid = tokio::task::spawn_blocking(move || {
            let Ok(parsed) = argon2::PasswordHash::new(&auth_for_check.config.password_hash) else {
                return false;
            };
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .await
        .unwrap_or(false);
        if !valid {
            log_rejection(&request, ip, Some(&username), "invalid_password");
            return unauthorized();
        }
        let _ = auth.verified_header.set(header_digest);
    }

    if !allowed_origin(&request) {
        log_rejection(&request, ip, Some(&username), "invalid_origin");
        return (
            StatusCode::FORBIDDEN,
            "Wrong door. This request didn't come from MarketWatch.",
        )
            .into_response();
    }

    next.run(request).await
}

fn parse_credentials(
    value: Option<&axum::http::HeaderValue>,
) -> Result<(String, String, [u8; 32]), &'static str> {
    let value = value.ok_or("missing_credentials")?;
    let value = value.to_str().map_err(|_| "malformed_credentials")?;
    if value.len() > 2048 {
        return Err("malformed_credentials");
    }
    let (scheme, encoded) = value.split_once(' ').ok_or("malformed_credentials")?;
    if !scheme.eq_ignore_ascii_case("basic") || encoded.is_empty() {
        return Err("malformed_credentials");
    }
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| "malformed_credentials")?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| "malformed_credentials")?;
    let (username, password) = decoded.split_once(':').ok_or("malformed_credentials")?;
    if username.len() > 128 || password.len() > 1024 {
        return Err("malformed_credentials");
    }
    Ok((
        username.to_owned(),
        password.to_owned(),
        Sha256::digest(value.as_bytes()).into(),
    ))
}

fn allowed_origin(request: &Request) -> bool {
    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if !websocket
        && matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        )
    {
        return true;
    }
    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(origin) = request.headers().get(header::ORIGIN) else {
        return false;
    };
    // A loopback proxy can terminate HTTPS without forwarding its original scheme.
    origin.as_bytes() == format!("http://{host}").as_bytes()
        || (loopback_peer(request) && origin.as_bytes() == format!("https://{host}").as_bytes())
}

fn loopback_peer(request: &Request) -> bool {
    peer_ip(request).is_some_and(|ip| ip.is_loopback())
}

fn peer_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.ip())
}

fn client_ip(request: &Request) -> Option<IpAddr> {
    let peer = peer_ip(request)?;
    let forwarded_host_matches = request
        .headers()
        .get(header::HOST)
        .is_some_and(|host| request.headers().get("x-forwarded-host") == Some(host));
    if !peer.is_loopback()
        || !request
            .headers()
            .get("x-forwarded-proto")
            .is_some_and(|value| value == "https")
        || !forwarded_host_matches
    {
        return Some(peer);
    }

    let mut forwarded = request.headers().get_all("x-forwarded-for").iter();
    let Some(value) = forwarded.next() else {
        return Some(peer);
    };
    if forwarded.next().is_some() {
        return Some(peer);
    }
    value
        .to_str()
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .or(Some(peer))
}

fn log_rejection(
    request: &Request,
    ip: Option<IpAddr>,
    username: Option<&str>,
    reason: &'static str,
) {
    let path = bounded(request.uri().path());
    let username = username.map(bounded);
    let user_agent = request
        .headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(bounded);
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(bounded);
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(bounded);
    if let Some(username) = username {
        error!(
            client_ip = ?ip,
            attempted_username = username,
            method = %request.method(),
            path = ?path,
            user_agent = ?user_agent,
            origin = ?origin,
            host = ?host,
            reason,
            "authentication denied"
        );
    } else {
        warn!(
            client_ip = ?ip,
            method = %request.method(),
            path = ?path,
            user_agent = ?user_agent,
            origin = ?origin,
            host = ?host,
            reason,
            "authentication denied"
        );
    }
}

fn bounded(value: &str) -> &str {
    let end = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= MAX_LOG_VALUE_BYTES)
        .last()
        .unwrap_or(0);
    if value.len() <= MAX_LOG_VALUE_BYTES {
        value
    } else {
        &value[..end]
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::WWW_AUTHENTICATE,
            "Basic realm=\"MarketWatch\", charset=\"UTF-8\"",
        )],
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::PasswordHasher;
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    fn test_auth() -> Arc<Auth> {
        let password_hash = Argon2::default()
            .hash_password(b"correct password")
            .unwrap();
        Arc::new(Auth::new(AuthConfig {
            username: "marketwatch".to_owned(),
            password_hash: password_hash.to_string(),
        }))
    }

    fn test_router() -> Router {
        Router::new()
            .route(
                "/private",
                get(|| async { "ok" }).post(|| async { "saved" }),
            )
            .fallback(|| async { "fallback" })
            .layer(axum::middleware::from_fn_with_state(
                test_auth(),
                require_auth,
            ))
    }

    fn authorization(username: &str, password: &str) -> String {
        format!(
            "Basic {}",
            STANDARD.encode(format!("{username}:{password}"))
        )
    }

    fn request(method: Method, path: &str, authorization: Option<&str>) -> Request {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "localhost:8080");
        if let Some(authorization) = authorization {
            builder = builder.header(header::AUTHORIZATION, authorization);
        }
        builder.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn auth_covers_routes_and_frontend_fallback() {
        let router = test_router();
        for path in ["/private", "/other"] {
            let response = router
                .clone()
                .oneshot(request(Method::GET, path, None))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert!(response.headers().contains_key(header::WWW_AUTHENTICATE));
        }
        let invalid = authorization("intruder", "correct password");
        let response = router
            .clone()
            .oneshot(request(Method::GET, "/private", Some(&invalid)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let valid = authorization("marketwatch", "correct password");
        for path in ["/private", "/other"] {
            let response = router
                .clone()
                .oneshot(request(Method::GET, path, Some(&valid)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let wrong_password = authorization("marketwatch", "wrong password");
        let response = test_router()
            .oneshot(request(Method::GET, "/private", Some(&wrong_password)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn concurrent_valid_requests_are_authorized() {
        let router = test_router();
        let valid = authorization("marketwatch", "correct password");
        assert_eq!(
            router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&valid)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let (first, second, third) = tokio::join!(
            router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&valid))),
            router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&valid))),
            router.oneshot(request(Method::GET, "/private", Some(&valid))),
        );
        for response in [first.unwrap(), second.unwrap(), third.unwrap()] {
            assert_eq!(response.status(), StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn cached_credentials_bypass_password_check_limit() {
        let router = test_router();
        let valid = authorization("marketwatch", "correct password");
        let invalid = authorization("marketwatch", "wrong password");

        assert_eq!(
            router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&valid)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for _ in 1..PASSWORD_CHECKS_PER_WINDOW {
            let response = router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&invalid)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let limited = router
            .clone()
            .oneshot(request(Method::GET, "/private", Some(&invalid)))
            .await
            .unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.headers()[header::RETRY_AFTER], "5");
        assert_eq!(
            router
                .oneshot(request(Method::GET, "/private", Some(&valid)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }

    #[test]
    fn password_check_limit_is_per_ip_and_rolling() {
        let mut shard = PasswordCheckShard::default();
        let first_ip = Some(IpAddr::from([203, 0, 113, 7]));
        let second_ip = Some(IpAddr::from([198, 51, 100, 9]));
        let start = Instant::now();

        for _ in 0..PASSWORD_CHECKS_PER_WINDOW {
            assert!(shard.reserve(first_ip, start));
        }
        assert!(!shard.reserve(first_ip, start));
        assert!(shard.reserve(second_ip, start));
        assert!(!shard.reserve(
            first_ip,
            start + PASSWORD_CHECK_WINDOW - Duration::from_nanos(1)
        ));
        assert!(shard.reserve(first_ip, start + PASSWORD_CHECK_WINDOW));
        assert_eq!(shard.counts.get(&first_ip), Some(&1));
        assert_eq!(shard.counts.get(&second_ip), None);
    }

    #[test]
    fn password_check_limit_uses_shared_bucket_when_ip_is_unknown() {
        let mut shard = PasswordCheckShard::default();
        let now = Instant::now();
        for _ in 0..PASSWORD_CHECKS_PER_WINDOW {
            assert!(shard.reserve(None, now));
        }
        assert!(!shard.reserve(None, now));
    }

    #[tokio::test]
    async fn cross_site_writes_and_websocket_handshakes_are_rejected() {
        let router = test_router();
        let valid = authorization("marketwatch", "correct password");
        assert_eq!(
            router
                .clone()
                .oneshot(request(Method::GET, "/private", Some(&valid)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let mut write = request(Method::POST, "/private", Some(&valid));
        write
            .headers_mut()
            .insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert_eq!(
            router.clone().oneshot(write).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let mut websocket = request(Method::GET, "/private", Some(&valid));
        websocket
            .headers_mut()
            .insert(header::UPGRADE, "websocket".parse().unwrap());
        websocket
            .headers_mut()
            .insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert_eq!(
            router.clone().oneshot(websocket).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let mut same_origin = request(Method::POST, "/private", Some(&valid));
        same_origin
            .headers_mut()
            .insert(header::ORIGIN, "http://localhost:8080".parse().unwrap());
        assert_eq!(
            router.oneshot(same_origin).await.unwrap().status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn loopback_https_proxy_accepts_same_origin_writes_and_websockets() {
        let router = test_router();
        let valid = authorization("marketwatch", "correct password");
        for method in [Method::POST, Method::GET] {
            let mut proxied = request(method.clone(), "/private", Some(&valid));
            proxied
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))));
            proxied
                .headers_mut()
                .insert(header::ORIGIN, "https://localhost:8080".parse().unwrap());
            if method == Method::GET {
                proxied
                    .headers_mut()
                    .insert(header::UPGRADE, "websocket".parse().unwrap());
            }
            assert_eq!(
                router.clone().oneshot(proxied).await.unwrap().status(),
                StatusCode::OK
            );
        }

        for origin in ["https://evil.example", "https://localhost:9999"] {
            let mut proxied = request(Method::POST, "/private", Some(&valid));
            proxied
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))));
            proxied
                .headers_mut()
                .insert(header::ORIGIN, origin.parse().unwrap());
            assert_eq!(
                router.clone().oneshot(proxied).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }

        let mut remote = request(Method::POST, "/private", Some(&valid));
        remote
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 1], 1234))));
        remote
            .headers_mut()
            .insert(header::ORIGIN, "https://localhost:8080".parse().unwrap());
        assert_eq!(
            router.oneshot(remote).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn forwarded_ip_requires_matching_loopback_https_proxy_headers() {
        let mut request = request(Method::GET, "/", None);
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))));
        request
            .headers_mut()
            .insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([127, 0, 0, 1])));
        request
            .headers_mut()
            .insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([127, 0, 0, 1])));
        request
            .headers_mut()
            .insert("x-forwarded-host", "localhost:8080".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([203, 0, 113, 7])));
        request
            .headers_mut()
            .insert(header::ORIGIN, "https://localhost:8080".parse().unwrap());
        request
            .headers_mut()
            .insert(header::UPGRADE, "websocket".parse().unwrap());
        assert!(allowed_origin(&request));

        request
            .headers_mut()
            .insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([127, 0, 0, 1])));
        request
            .headers_mut()
            .insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        request
            .headers_mut()
            .append("x-forwarded-for", "198.51.100.9".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([127, 0, 0, 1])));

        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, 1], 1234))));
        assert_eq!(client_ip(&request), Some(IpAddr::from([192, 0, 2, 1])));
    }
}
