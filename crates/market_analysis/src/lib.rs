pub mod chart;
mod performance;
mod relative_strength;

pub use performance::{
    PerformancePeriods, average_daily_range_percent, average_volume, candle_performance,
    close_above_sma, extension_from_50_sma,
};
pub use relative_strength::{
    ChartDateRange, RelativeStrengthCalculation, RelativeStrengthCalculationError,
    RelativeStrengthCalculationPoint, RelativeStrengthStructure, RelativeStrengthSwing,
    RelativeStrengthSwingKind, RelativeStrengthTrend, analyze_relative_strength_structure,
    calculate_relative_strength_line, calculate_relative_strength_line_with_period,
    chart_relative_strength_period,
};
