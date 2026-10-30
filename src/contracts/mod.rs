pub mod events;
pub mod industry;
pub mod live;
pub mod tickers;

use crate::models::chart::{
    MarketChartCandle, MarketChartIndicators, MarketChartInterval, MarketChartPoint,
    MarketChartRelativeStrength, MarketChartSeries, MarketChartSnapshot, VolumeEventKind,
};
use crate::models::{
    RelativeStrengthCalculation, RelativeStrengthCalculationPoint, RelativeStrengthStructure,
    RelativeStrengthSwing, RelativeStrengthSwingKind, RelativeStrengthTrend, YahooSymbol,
};
use crate::services::volume_run_rate::VolumeRunRate;
use live::{
    LiveChartDelta, LiveCommand, LiveEvent, LiveSessionDelta, LiveSessionKind, RawLiveChartRequest,
};

use crate::models::ticker_collection::RejectedTicker;
use crate::models::{
    PerformancePeriods, ThemeRanking, TickerCollection, TickerCollectionFile,
    TickerCollectionSource, TickerRanking, TickerSymbol,
};
use events::{ApplicationCommand, ApplicationEvent, ApplicationResource, ApplicationSnapshot};
use industry::{
    IndustryCatalogEntry, IndustryClassification, IndustryData, IndustryResource, IndustryState,
};
use std::path::Path;
use tickers::{
    EnabledFilter, MinimumFilter, TickerFilterExclusions, TickerFilters, TickerMetricsResource,
    TickerMetricsUpdate, TickerSelection,
};
use ts_rs::{Config, TS};

pub fn export(check: bool) -> anyhow::Result<()> {
    // serde_json sends integer IDs and counts as JSON numbers.
    let config = Config::default().with_large_int("number");
    let declarations = [
        TickerSymbol::decl(&config),
        YahooSymbol::decl(&config),
        VolumeEventKind::decl(&config),
        MarketChartInterval::decl(&config),
        MarketChartCandle::decl(&config),
        MarketChartPoint::decl(&config),
        MarketChartSeries::decl(&config),
        MarketChartIndicators::decl(&config),
        MarketChartSnapshot::decl(&config),
        MarketChartRelativeStrength::decl(&config),
        RelativeStrengthCalculation::decl(&config),
        RelativeStrengthCalculationPoint::decl(&config),
        RelativeStrengthSwingKind::decl(&config),
        RelativeStrengthTrend::decl(&config),
        RelativeStrengthSwing::decl(&config),
        RelativeStrengthStructure::decl(&config),
        VolumeRunRate::decl(&config),
        LiveCommand::decl(&config),
        RawLiveChartRequest::decl(&config),
        LiveChartDelta::decl(&config),
        LiveSessionKind::decl(&config),
        LiveSessionDelta::decl(&config),
        LiveEvent::decl(&config),
        RejectedTicker::decl(&config),
        TickerCollectionFile::decl(&config),
        TickerCollectionSource::decl(&config),
        TickerCollection::decl(&config),
        PerformancePeriods::decl(&config),
        ThemeRanking::decl(&config),
        TickerRanking::decl(&config),
        MinimumFilter::decl(&config),
        EnabledFilter::decl(&config),
        TickerFilters::decl(&config),
        TickerFilterExclusions::decl(&config),
        TickerSelection::decl(&config),
        TickerMetricsResource::decl(&config),
        TickerMetricsUpdate::decl(&config),
        IndustryClassification::decl(&config),
        IndustryCatalogEntry::decl(&config),
        IndustryResource::decl(&config),
        IndustryData::decl(&config),
        IndustryState::decl(&config),
        ApplicationResource::decl(&config),
        ApplicationCommand::decl(&config),
        ApplicationSnapshot::decl(&config),
        ApplicationEvent::decl(&config),
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
