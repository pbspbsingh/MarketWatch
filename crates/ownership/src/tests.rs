use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use chrono::{NaiveDate, Utc};
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::Importer;
use institutional::Store;

static NEXT: AtomicUsize = AtomicUsize::new(0);
const LATEST: i32 = 2026 * 4 + 2;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "institutions_test_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn zip(path: &Path, files: &[(&str, String)]) {
    let mut writer = ZipWriter::new(File::create(path).unwrap());
    for (name, contents) in files {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
}

fn archive(
    path: &Path,
    accession: &str,
    report_date: &str,
    ticker: &str,
    shares: f64,
    broken: bool,
) {
    let mut holdings = String::from(
        "ACCESSION_NUMBER\tHOLDING_ID\tISSUER_CUSIP\tISSUER_TITLE\tBALANCE\tUNIT\tCURRENCY_CODE\tCURRENCY_VALUE\tPERCENTAGE\tPAYOFF_PROFILE\tASSET_CAT\n",
    );
    let count = if broken { 4100 } else { 1 };
    for id in 0..count {
        holdings.push_str(&format!(
            "{accession}\t{id}\t123456789\tCOMMON STOCK\t{shares}\tNS\tUSD\t1000\t1.5\tLong\tEC\n"
        ));
    }
    if broken {
        holdings.push_str("too\tfew\tcolumns\n");
    }
    zip(
        path,
        &[
            (
                "SUBMISSION.tsv",
                format!(
                    "ACCESSION_NUMBER\tFILING_DATE\tREPORT_DATE\tSUB_TYPE\n{accession}\t15-JUL-2026\t{report_date}\tNPORT-P\n"
                ),
            ),
            (
                "REGISTRANT.tsv",
                format!(
                    "ACCESSION_NUMBER\tCIK\tREGISTRANT_NAME\n{accession}\t0000000001\tExample Sponsor\n"
                ),
            ),
            (
                "FUND_REPORTED_INFO.tsv",
                format!(
                    "ACCESSION_NUMBER\tSERIES_NAME\tSERIES_ID\tSERIES_LEI\tASSETS_ATTRBT_TO_MISC_SECURITY\n{accession}\tExample Fund\tS000000001\t\t0\n"
                ),
            ),
            (
                "IDENTIFIERS.tsv",
                format!("HOLDING_ID\tIDENTIFIER_TICKER\n0\t{ticker}\n"),
            ),
            ("FUND_REPORTED_HOLDING.tsv", holdings),
        ],
    );
}

#[tokio::test]
async fn resolves_identifiers_across_archives_and_reads_without_source_files() {
    let fixture = Fixture::new();
    let older = fixture.path("2026q1_nport.zip");
    let newer = fixture.path("2026q2_nport.zip");
    archive(&older, "old", "31-MAR-2026", "EX.A", 100.0, false);
    archive(&newer, "new", "30-JUN-2026", "", 125.0, false);
    let path = fixture.path("institutions.sqlite");
    let store = Store::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    assert!(
        Importer::new(store.clone())
            .import_archive(&older, LATEST - 2, |_| {})
            .await
            .unwrap()
    );
    assert!(
        Importer::new(store.clone())
            .import_archive(&newer, LATEST - 1, |_| {})
            .await
            .unwrap()
    );
    assert!(
        !Importer::new(store.clone())
            .import_archive(&older, LATEST - 2, |_| panic!("unchanged archive was read"))
            .await
            .unwrap()
    );
    let now = Utc::now();
    store
        .set_source_version("2026q1_nport.zip", Some(now), Some("\"version_1\""))
        .await
        .unwrap();
    store.publish(LATEST, now).await.unwrap();
    store.close().await;
    std::fs::remove_file(older).unwrap();
    std::fs::remove_file(newer).unwrap();
    let reopened = Store::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    let source = reopened.source("2026q1_nport.zip").await.unwrap().unwrap();
    assert_eq!(source.source_modified_at, Some(now));
    assert_eq!(source.source_etag.as_deref(), Some("\"version_1\""));
    let data = reopened.load("ex-a").await.unwrap().unwrap();
    assert_eq!(data.dataset.updated_at, now);
    let positions: Vec<_> = data
        .archives
        .iter()
        .flat_map(|a| &a.positions)
        .map(|p| p.shares)
        .collect();
    assert_eq!(positions, [125.0, 100.0]);
    assert_eq!(
        data.archives[1].filings[0].report_date,
        NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()
    );
    assert!(
        reopened
            .load("MISSING")
            .await
            .unwrap()
            .unwrap()
            .archives
            .iter()
            .all(|a| a.positions.is_empty() && a.cusips.is_empty())
    );
    reopened.close().await;
}

#[tokio::test]
async fn failed_reimport_rolls_back_already_written_batches() {
    let fixture = Fixture::new();
    let path = fixture.path("2026q2_nport.zip");
    archive(&path, "good", "30-JUN-2026", "EX", 100.0, false);
    let store = Store::connect(&format!(
        "sqlite://{}",
        fixture.path("institutions.sqlite").display()
    ))
    .await
    .unwrap();
    Importer::new(store.clone())
        .import_archive(&path, LATEST - 1, |_| {})
        .await
        .unwrap();
    store.publish(LATEST, Utc::now()).await.unwrap();
    archive(&path, "broken", "30-JUN-2026", "EX", 200.0, true);
    assert!(
        Importer::new(store.clone())
            .import_archive(&path, LATEST - 1, |_| {})
            .await
            .is_err()
    );
    let data = store.load("EX").await.unwrap().unwrap();
    let positions: Vec<_> = data.archives.iter().flat_map(|a| &a.positions).collect();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].accession, "good");
    assert_eq!(positions[0].shares, 100.0);
    // A panicking parser must also roll back batches sent before it stopped.
    archive(&path, "panicked", "30-JUN-2026", "EX", 250.0, false);
    let error = Importer::new(store.clone())
        .import_archive(&path, LATEST - 1, |_| panic!("parser interrupted"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("archive parser task failed"));
    let data = store.load("EX").await.unwrap().unwrap();
    assert_eq!(data.archives[1].positions[0].accession, "good");
    assert_eq!(data.archives[1].positions[0].shares, 100.0);
    // A successful replacement replaces rather than appends the previous rows.
    archive(&path, "replacement", "30-JUN-2026", "EX", 300.0, false);
    assert!(
        Importer::new(store.clone())
            .import_archive(&path, LATEST - 1, |_| {})
            .await
            .unwrap()
    );
    let data = store.load("EX").await.unwrap().unwrap();
    assert_eq!(data.archives[1].positions[0].shares, 300.0);
    assert_eq!(data.archives[1].positions.len(), 1);
    store.close().await;
}

#[tokio::test]
async fn imports_issuer_share_counts_and_multiple_classes() {
    let fixture = Fixture::new();
    let tickers = fixture.path("company_tickers.json");
    std::fs::write(
        &tickers,
        r#"{"0":{"ticker":"EX.A","cik_str":1},"1":{"ticker":"EX.B","cik_str":1}}"#,
    )
    .unwrap();
    let facts = fixture.path("companyfacts.zip");
    zip(&facts, &[
        ("CIK0000000001.json", r#"{"cik":1,"facts":{"dei":{"EntityCommonStockSharesOutstanding":{"units":{"shares":[{"end":"2026-06-30","val":200,"filed":"2026-08-01"},{"end":"2026-06-30","val":100,"filed":"2026-07-01"}]}}}}}"#.into()),
        // Exact stub from the SEC bulk archive that previously aborted the import.
        ("CIK0000002110.json", r#"{"cik":"0000002110","entityName":"","facts":{}}"#.into()),
        ("CIK0000003521.json", "{}".into()),
        ("CIK0000000002.json", r#"{"cik":"0000000002","facts":{"dei":{"EntityCommonStockSharesOutstanding":{"units":{"shares":[{"end":"2026-06-30","val":50,"filed":"2026-07-01"}]}}}}}"#.into()),
        ("CIK0000000003.json", r#"{"facts":{"dei":{"EntityCommonStockSharesOutstanding":{"units":{"shares":[{"end":"2026-06-30","val":75,"filed":"2026-07-01"}]}}}}}"#.into()),
    ]);
    let store = Store::connect(&format!(
        "sqlite://{}",
        fixture.path("institutions.sqlite").display()
    ))
    .await
    .unwrap();
    assert!(
        Importer::new(store.clone())
            .import_tickers(&tickers)
            .await
            .unwrap()
    );
    assert!(
        !Importer::new(store.clone())
            .import_tickers(&tickers)
            .await
            .unwrap()
    );
    assert!(
        Importer::new(store.clone())
            .import_company_facts(&facts, |_| {})
            .await
            .unwrap()
    );
    assert!(
        !Importer::new(store.clone())
            .import_company_facts(&facts, |_| panic!("unchanged facts were read"))
            .await
            .unwrap()
    );
    store.publish(LATEST, Utc::now()).await.unwrap();
    let data = store.load("EX-A").await.unwrap().unwrap();
    let issuer = data.issuer.unwrap();
    assert!(issuer.multiple_classes);
    assert_eq!(
        issuer.counts[&NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()],
        100.0
    );
    // Issuer identity comes from the filename, independent of the JSON CIK type.
    std::fs::write(
        &tickers,
        r#"{"0":{"ticker":"STRING_CIK","cik_str":2},"1":{"ticker":"MISSING_CIK","cik_str":3}}"#,
    )
    .unwrap();
    Importer::new(store.clone())
        .import_tickers(&tickers)
        .await
        .unwrap();
    let issuer = store
        .load("STRING_CIK")
        .await
        .unwrap()
        .unwrap()
        .issuer
        .unwrap();
    assert_eq!(
        issuer.counts[&NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()],
        50.0
    );
    let issuer = store
        .load("MISSING_CIK")
        .await
        .unwrap()
        .unwrap()
        .issuer
        .unwrap();
    assert_eq!(
        issuer.counts[&NaiveDate::from_ymd_opt(2026, 6, 30).unwrap()],
        75.0
    );
    store.close().await;
}

#[tokio::test]
#[ignore = "requires SEC_COMPANYFACTS_ARCHIVE pointing to the SEC bulk ZIP"]
async fn imports_complete_sec_company_facts_archive() {
    let fixture = Fixture::new();
    let path = PathBuf::from(
        std::env::var_os("SEC_COMPANYFACTS_ARCHIVE").expect("set SEC_COMPANYFACTS_ARCHIVE"),
    );
    let store = Store::connect(&format!(
        "sqlite://{}",
        fixture.path("institutions.sqlite").display()
    ))
    .await
    .unwrap();
    Importer::new(store.clone())
        .import_company_facts(&path, |index| {
            if index.is_multiple_of(1000) {
                eprintln!("Read {index} issuer records");
            }
        })
        .await
        .unwrap();
    assert!(store.source("companyfacts.zip").await.unwrap().is_some());
    let tickers = fixture.path("company_tickers.json");
    std::fs::write(&tickers, r#"{"0":{"ticker":"AIR","cik_str":1750}}"#).unwrap();
    Importer::new(store.clone())
        .import_tickers(&tickers)
        .await
        .unwrap();
    store.publish(LATEST, Utc::now()).await.unwrap();
    assert!(
        !store
            .load("AIR")
            .await
            .unwrap()
            .unwrap()
            .issuer
            .unwrap()
            .counts
            .is_empty()
    );
    store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readers_see_previous_data_during_import() {
    let fixture = Fixture::new();
    let path = fixture.path("2026q2_nport.zip");
    archive(&path, "old", "30-JUN-2026", "EX", 100.0, false);
    let store = Store::connect(&format!(
        "sqlite://{}",
        fixture.path("institutions.sqlite").display()
    ))
    .await
    .unwrap();
    Importer::new(store.clone())
        .import_archive(&path, LATEST - 1, |_| {})
        .await
        .unwrap();
    store.publish(LATEST, Utc::now()).await.unwrap();
    archive(&path, "new", "30-JUN-2026", "EX", 200.0, false);
    let (started, waiting) = tokio::sync::oneshot::channel();
    let started = std::sync::Mutex::new(Some(started));
    let (release, blocked) = std::sync::mpsc::channel();
    let writer = store.clone();
    let task = tokio::spawn(async move {
        Importer::new(writer.clone())
            .import_archive(&path, LATEST - 1, move |_| {
                if let Some(started) = started.lock().unwrap().take() {
                    let _ = started.send(());
                    blocked
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                }
            })
            .await
            .unwrap();
    });
    waiting.await.unwrap();
    let data = store.load("EX").await.unwrap().unwrap();
    assert_eq!(data.archives[1].positions[0].shares, 100.0);
    release.send(()).unwrap();
    task.await.unwrap();
    let data = store.load("EX").await.unwrap().unwrap();
    assert_eq!(data.archives[1].positions[0].shares, 200.0);
    store.close().await;
}
