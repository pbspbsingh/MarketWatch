use std::{
    path::Path,
    sync::{Arc, RwLock},
    time::Duration,
};

use anyhow::{Result, ensure};
use chrono::{DateTime, Utc};
use reqwest::{Client, Response, StatusCode, header};
use tokio::{
    io::AsyncWriteExt,
    sync::Mutex,
    time::{Instant, sleep},
};

use crate::models::institutions::{OwnershipProgress, SourceArchive};

pub(crate) const NPORT_URL: &str =
    "https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets";
pub(crate) const FACTS_URL: &str =
    "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip";
pub(crate) const TICKERS_URL: &str = "https://www.sec.gov/files/company_tickers.json";
pub(crate) type Progress = Arc<RwLock<OwnershipProgress>>;

pub(crate) struct SourceVersion {
    pub modified_at: Option<DateTime<Utc>>,
    pub etag: Option<String>,
}

impl SourceVersion {
    fn from_headers(headers: &header::HeaderMap) -> Result<Self> {
        let modified_at = headers
            .get(header::LAST_MODIFIED)
            .map(|value| {
                Ok::<_, anyhow::Error>(
                    DateTime::parse_from_rfc2822(value.to_str()?)?.with_timezone(&Utc),
                )
            })
            .transpose()?;
        let etag = headers
            .get(header::ETAG)
            .map(|value| value.to_str().map(str::to_owned))
            .transpose()?;
        Ok(Self { modified_at, etag })
    }
}

/// All SEC hosts and retries share this gate. No automatic, unmetered redirects.
pub(crate) struct SecClient {
    http: Client,
    next_request: Mutex<Instant>,
    transfer: tokio::sync::Semaphore,
}

impl SecClient {
    pub fn new(user_agent: &str) -> Result<Self> {
        ensure!(
            user_agent.contains('@') && !user_agent.contains("your-domain.com"),
            "SEC access requires an application name and contact email"
        );
        Ok(Self {
            http: Client::builder()
                .user_agent(user_agent)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(40))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            next_request: Mutex::new(Instant::now()),
            transfer: tokio::sync::Semaphore::new(1),
        })
    }

    async fn wait(&self) {
        let mut next = self.next_request.lock().await;
        sleep(next.saturating_duration_since(Instant::now())).await;
        *next = Instant::now() + Duration::from_millis(251);
    }

    async fn backoff(&self, attempt: u32, response: Option<&Response>) -> Result<()> {
        let mut delay = Duration::from_secs(2_u64.pow(attempt));
        if let Some(value) = response.and_then(|r| r.headers().get(header::RETRY_AFTER)) {
            let value = value.to_str()?;
            let requested = if let Ok(seconds) = value.parse::<u64>() {
                Duration::from_secs(seconds)
            } else {
                (chrono::DateTime::parse_from_rfc2822(value)?.with_timezone(&Utc) - Utc::now())
                    .to_std()
                    .unwrap_or_default()
            };
            delay = delay.max(requested);
        }
        ensure!(
            delay <= Duration::from_secs(120),
            "SEC requested a longer pause; retry ownership refresh later"
        );
        let mut next = self.next_request.lock().await;
        *next = (*next).max(Instant::now() + delay);
        Ok(())
    }

    async fn response(&self, url: &str, bulk: bool) -> Result<Response> {
        for attempt in 1..=3 {
            self.wait().await;
            tracing::debug!(url, attempt, "requesting SEC source");
            let result = self
                .http
                .get(url)
                .timeout(Duration::from_secs(if bulk { 300 } else { 40 }))
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    if attempt < 3
                        && (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                    {
                        self.backoff(attempt, Some(&response)).await?;
                        continue;
                    }
                    anyhow::bail!("SEC returned HTTP {status} for {url}");
                }
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!()
    }

    pub async fn bytes(&self, url: &str) -> Result<Vec<u8>> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            let mut response = self.response(url, false).await?;
            let mut bytes = Vec::new();
            let result = async {
                while let Some(chunk) = response.chunk().await? {
                    ensure!(
                        bytes.len() + chunk.len() <= 32 * 1024 * 1024,
                        "SEC response exceeds size limit"
                    );
                    bytes.extend_from_slice(&chunk);
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            match result {
                Ok(()) => return Ok(bytes),
                Err(error) if attempt < 3 && error.downcast_ref::<reqwest::Error>().is_some() => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub async fn archives(&self) -> Result<Vec<SourceArchive>> {
        let html = String::from_utf8(self.bytes(NPORT_URL).await?)?;
        let pattern = regex::Regex::new(r"/(\d{4})q([1-4])_nport\.zip")?;
        let mut periods = pattern
            .captures_iter(&html)
            .map(|c| Ok(c[1].parse::<i32>()? * 4 + c[2].parse::<i32>()? - 1))
            .collect::<Result<Vec<_>>>()?;
        periods.sort_unstable();
        periods.dedup();
        periods.reverse();
        periods.truncate(5);
        ensure!(
            periods.len() == 5 && periods.windows(2).all(|w| w[0] - w[1] == 1),
            "SEC did not publish five consecutive ownership archives"
        );
        // Import oldest first. The manifest is published only when all five exist.
        periods.reverse();
        Ok(periods
            .into_iter()
            .map(|period| SourceArchive {
                period,
                url: format!(
                    "https://www.sec.gov/files/dera/data/form-n-port-data-sets/{}q{}_nport.zip",
                    period.div_euclid(4),
                    period.rem_euclid(4) + 1
                ),
            })
            .collect())
    }

    pub async fn download(
        &self,
        source: &SourceArchive,
        path: &Path,
        progress: &Progress,
    ) -> Result<SourceVersion> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            let mut response = self.response(&source.url, true).await?;
            let version = SourceVersion::from_headers(response.headers())?;
            let expected = response.content_length();
            {
                let mut state = progress.write().unwrap();
                state.bytes_received = 0;
                state.bytes_total = expected;
            }
            let mut file = tokio::fs::File::create(path).await?;
            let mut received = 0_u64;
            let result = async {
                while let Some(chunk) = response.chunk().await? {
                    received += chunk.len() as u64;
                    ensure!(
                        received <= 8 * 1024 * 1024 * 1024,
                        "SEC archive exceeds 8 GB size limit"
                    );
                    file.write_all(&chunk).await?;
                    progress.write().unwrap().bytes_received = received;
                }
                file.flush().await?;
                ensure!(
                    received > 0 && expected.is_none_or(|n| received == n),
                    "incomplete SEC archive download"
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            match result {
                Ok(()) => return Ok(version),
                Err(error) if attempt < 3 && error.downcast_ref::<reqwest::Error>().is_some() => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub async fn archive_changed(
        &self,
        source: &SourceArchive,
        known: &institutions::SourceState,
    ) -> Result<bool> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            self.wait().await;
            tracing::debug!(url = %source.url, attempt, "checking SEC archive update");
            let mut request = self.http.head(&source.url);
            if let Some(etag) = &known.source_etag {
                request = request.header(header::IF_NONE_MATCH, etag);
            }
            if let Some(modified) = known.source_modified_at {
                request = request.header(
                    header::IF_MODIFIED_SINCE,
                    modified.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
                );
            }
            let response = request.send().await?;
            if response.status() == StatusCode::NOT_MODIFIED {
                return Ok(false);
            }
            if attempt < 3
                && (response.status() == StatusCode::TOO_MANY_REQUESTS
                    || response.status().is_server_error())
            {
                self.backoff(attempt, Some(&response)).await?;
                continue;
            }
            ensure!(
                response.status().is_success(),
                "SEC ownership update check returned HTTP {}",
                response.status()
            );
            let remote = SourceVersion::from_headers(response.headers())?;
            return Ok(match (known.source_etag.as_ref(), remote.etag.as_ref()) {
                (Some(before), Some(after)) => before != after,
                _ => match (known.source_modified_at, remote.modified_at) {
                    (Some(before), Some(after)) => before != after,
                    _ => true,
                },
            });
        }
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    fn server(response: String) -> (SourceArchive, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/source.zip", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let length = socket.read(&mut buffer).unwrap();
                assert!(length > 0 && request.len() < 16384);
                request.extend_from_slice(&buffer[..length]);
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (SourceArchive { period: 0, url }, task)
    }

    #[tokio::test]
    async fn conditional_check_skips_unchanged_sources_without_local_files() {
        let client = SecClient::new("MarketWatch tests test@example.org").unwrap();
        let modified = DateTime::parse_from_rfc2822("Wed, 21 Oct 2015 07:28:00 GMT")
            .unwrap()
            .with_timezone(&Utc);
        let known = institutions::SourceState {
            imported_at: Utc::now(),
            source_modified_at: Some(modified),
            source_etag: Some("\"version_1\"".into()),
        };
        let (source, request) =
            server("HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into());
        assert!(!client.archive_changed(&source, &known).await.unwrap());
        let request = request.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("head /source.zip "));
        assert!(request.contains("if-none-match: \"version_1\""));
        assert!(request.contains("if-modified-since: wed, 21 oct 2015 07:28:00 gmt"));

        let (source, request) = server("HTTP/1.1 200 OK\r\nETag: \"version_2\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
        assert!(client.archive_changed(&source, &known).await.unwrap());
        request.join().unwrap();
    }

    #[tokio::test]
    async fn download_retains_the_version_of_the_received_body() {
        let client = SecClient::new("MarketWatch tests test@example.org").unwrap();
        let (source, request) = server("HTTP/1.1 200 OK\r\nETag: \"version_2\"\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata".into());
        let path = std::env::temp_dir().join(format!(
            "institutions_download_{:032x}.zip",
            fastrand::u128(..)
        ));
        let progress = Arc::new(RwLock::new(OwnershipProgress::default()));
        let version = client.download(&source, &path, &progress).await.unwrap();
        let bytes = tokio::fs::read(&path).await.unwrap();
        tokio::fs::remove_file(path).await.unwrap();
        request.join().unwrap();
        assert_eq!(bytes, b"data");
        assert_eq!(version.etag.as_deref(), Some("\"version_2\""));
        assert_eq!(
            version.modified_at.unwrap().to_rfc3339(),
            "2015-10-21T07:28:00+00:00"
        );
    }
}
