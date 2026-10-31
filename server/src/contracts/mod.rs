pub mod chart;
pub mod events;
pub mod industry;
pub mod live;
pub mod market;
pub mod tickers;
pub mod tracker;
pub mod trade_logs;

use crate::services::chart::{
    ChartIndustry, ChartSectorBenchmark, ChartSummary, ChartThemeBenchmark,
};
use crate::services::details::{
    FundamentalGrowthDetails, FundamentalGrowthMetric, FundamentalGrowthPoint,
    FundamentalGrowthSeries, ProfileDetails, TickerDetails,
};
use crate::services::study::{
    StudyCandle, StudyMovingAverage, StudyMovingAveragePoint, StudyResult, StudySeries,
};
use crate::services::trade_logs::market::{HourlyCandle, HourlyChart};
use crate::services::trade_logs::{Snapshot, Statistics, TagStatistics};
use crate::services::volume_run_rate::VolumeRunRate;
use journal::trade_logs::{
    Direction, Execution, ExecutionAction, ExecutionInput, Side, Tag, TagInput, Trade, TradeInput,
    TradeStatus, TradeSummary, Valuation,
};
use live::{
    LiveChartDelta, LiveCommand, LiveEvent, LiveSessionDelta, LiveSessionKind, RawLiveChartRequest,
};
use market_analysis::chart::MarketChartCandle;
use market_analysis::chart::MarketChartIndicators;
use market_analysis::chart::MarketChartInterval;
use market_analysis::chart::MarketChartPoint;
use market_analysis::chart::MarketChartRelativeStrength;
use market_analysis::chart::MarketChartSeries;
use market_analysis::chart::MarketChartSnapshot;
use market_analysis::chart::VolumeEventKind;
use market_analysis::{
    RelativeStrengthCalculation, RelativeStrengthCalculationPoint, RelativeStrengthStructure,
    RelativeStrengthSwing, RelativeStrengthSwingKind, RelativeStrengthTrend,
};
use market_types::{Forecast, FundamentalPeriod, Fundamentals, TradingViewSymbol, YahooSymbol};
use trade_logs::TradeLogSnapshot;

use crate::models::ThemeRanking;
use crate::models::TickerRanking;
use chart::{GroupSummary, GroupSummaryItem, HomeCharts, NextEarnings};
use collections::ticker_collection::RejectedTicker;
use collections::ticker_collection::TickerCollection;
use collections::ticker_collection::TickerCollectionFile;
use collections::ticker_collection::TickerCollectionSource;
use events::{ApplicationCommand, ApplicationEvent, ApplicationResource, ApplicationSnapshot};
use industry::{
    IndustryCatalogEntry, IndustryClassification, IndustryData, IndustryResource, IndustryState,
};
use market::MarketHours;
use market_analysis::PerformancePeriods;
use market_types::TickerSymbol;
use std::path::Path;
use tickers::{
    EnabledFilter, MinimumFilter, TickerFilterExclusions, TickerFilters, TickerMetricsResource,
    TickerMetricsUpdate, TickerSelection,
};
use tracker::{TrackerMode, TrackerResource, TrackerRow, TrackerUpdate};
use ts_rs::{Config, TS};

pub fn export(check: bool) -> anyhow::Result<()> {
    // serde_json sends integer IDs and counts as JSON numbers.
    let config = Config::default().with_large_int("number");
    let declarations = [
        TickerSymbol::decl(&config),
        TradingViewSymbol::decl(&config),
        ChartIndustry::decl(&config),
        ChartSectorBenchmark::decl(&config),
        ChartThemeBenchmark::decl(&config),
        ChartSummary::decl(&config),
        HomeCharts::decl(&config),
        NextEarnings::decl(&config),
        GroupSummaryItem::decl(&config),
        GroupSummary::decl(&config),
        FundamentalPeriod::decl(&config),
        Forecast::decl(&config),
        Fundamentals::decl(&config),
        FundamentalGrowthPoint::decl(&config),
        FundamentalGrowthSeries::decl(&config),
        FundamentalGrowthMetric::decl(&config),
        FundamentalGrowthDetails::decl(&config),
        ProfileDetails::decl(&config),
        TickerDetails::decl(&config),
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
        StudyCandle::decl(&config),
        StudyMovingAveragePoint::decl(&config),
        StudyMovingAverage::decl(&config),
        StudySeries::decl(&config),
        StudyResult::decl(&config),
        Direction::decl(&config),
        Side::decl(&config),
        ExecutionAction::decl(&config),
        TradeStatus::decl(&config),
        ExecutionInput::decl(&config),
        TradeInput::decl(&config),
        Execution::decl(&config),
        TradeSummary::decl(&config),
        Trade::decl(&config),
        Valuation::decl(&config),
        Tag::decl(&config),
        TagInput::decl(&config),
        Statistics::decl(&config),
        TagStatistics::decl(&config),
        Snapshot::decl(&config),
        TradeLogSnapshot::decl(&config),
        HourlyCandle::decl(&config),
        HourlyChart::decl(&config),
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
        TrackerMode::decl(&config),
        TrackerResource::decl(&config),
        TrackerRow::decl(&config),
        TrackerUpdate::decl(&config),
        MarketHours::decl(&config),
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
    let source = source
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/api/generated/contracts.ts");
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
