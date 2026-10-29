pub mod events;
pub mod industry;

use std::path::Path;
use ts_rs::{Config, TS};

pub fn export(check: bool) -> anyhow::Result<()> {
    // serde_json sends integer IDs and counts as JSON numbers.
    let config = Config::default().with_large_int("number");
    let declarations = [
        crate::models::TickerSymbol::decl(&config),
        crate::models::ticker_collection::RejectedTicker::decl(&config),
        crate::models::TickerCollectionFile::decl(&config),
        crate::models::TickerCollectionSource::decl(&config),
        crate::models::TickerCollection::decl(&config),
        crate::models::PerformancePeriods::decl(&config),
        crate::models::ThemeRanking::decl(&config),
        industry::IndustryClassification::decl(&config),
        industry::IndustryResource::decl(&config),
        industry::IndustryData::decl(&config),
        industry::IndustryState::decl(&config),
        events::ApplicationResource::decl(&config),
        events::ApplicationCommand::decl(&config),
        events::ApplicationSnapshot::decl(&config),
        events::ApplicationEvent::decl(&config),
    ];
    let source = format!(
        "// Generated from Rust. Run cargo run -- --export-contracts.\n\n{}\n",
        declarations
            .map(|value| format!("export {value}"))
            .join("\n\n")
    );
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend/src/api/generated/contracts.ts");
    if check {
        anyhow::ensure!(
            std::fs::read_to_string(path)? == source,
            "Generated application contracts are stale"
        );
    } else {
        std::fs::create_dir_all(path.parent().expect("contract directory"))?;
        std::fs::write(path, source)?;
    }
    Ok(())
}
