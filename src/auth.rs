use crate::config::AuthConfig;
use argon2::{Argon2, PasswordVerifier};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tracing::warn;

const PASSWORD_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const MAX_LOG_VALUE_BYTES: usize = 256;

pub struct Auth {
    config: AuthConfig,
    verified_header: OnceLock<[u8; 32]>,
    last_password_check: Mutex<Option<Instant>>,
}

impl Auth {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config,
            verified_header: OnceLock::new(),
            last_password_check: Mutex::new(None),
        }
    }

    fn reserve_password_check(&self) -> bool {
        let now = Instant::now();
        let mut last_check = self.last_password_check.lock().unwrap();
        if last_check.is_some_and(|time| now.duration_since(time) < PASSWORD_CHECK_INTERVAL) {
            return false;
        }
        *last_check = Some(now);
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
        if !auth.reserve_password_check() {
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
    let scheme = if trusted_funnel(request) {
        "https"
    } else {
        "http"
    };
    let expected = format!("{scheme}://{host}");
    request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|value| value.as_bytes() == expected.as_bytes())
}

fn trusted_funnel(request: &Request) -> bool {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| peer.ip().is_loopback())
        && request
            .headers()
            .get("tailscale-funnel-request")
            .is_some_and(|value| value == "?1")
        && request
            .headers()
            .get("x-forwarded-proto")
            .is_some_and(|value| value == "https")
}

fn client_ip(request: &Request) -> Option<IpAddr> {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>()?.ip();
    if trusted_funnel(request) {
        request
            .headers()
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<IpAddr>().ok())
            .or(Some(peer))
    } else {
        Some(peer)
    }
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
    warn!(
        client_ip = ?ip,
        attempted_username = ?username,
        method = %request.method(),
        path = ?path,
        user_agent = ?user_agent,
        origin = ?origin,
        host = ?host,
        reason,
        "authentication denied"
    );
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

    #[test]
    fn forwarded_ip_is_used_only_for_local_funnel_proxy() {
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
            .insert("tailscale-funnel-request", "?1".parse().unwrap());
        request
            .headers_mut()
            .insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([203, 0, 113, 7])));
        request
            .headers_mut()
            .insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&request), Some(IpAddr::from([127, 0, 0, 1])));
    }
}
