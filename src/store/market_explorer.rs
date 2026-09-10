use super::Store;
use crate::models::TickerSymbol;
use anyhow::Context;
use chrono::NaiveDate;

pub struct MarketExplorerCandleSummary {
    pub total_tickers: usize,
    pub industry_mapped_tickers: usize,
    pub latest_candle_tickers: usize,
}

impl Store {
    pub async fn market_explorer_candle_summary(
        &self,
        target_date: NaiveDate,
    ) -> anyhow::Result<MarketExplorerCandleSummary> {
        let total_tickers = self.known_tickers().await?.len();
        let (industry_mapped_tickers, latest_candle_tickers) = sqlx::query_as::<_, (i64, i64)>(
            "WITH industry_tickers AS (
                    SELECT DISTINCT symbol FROM industry_membership_tickers
                 )
                 SELECT
                    (SELECT COUNT(*) FROM industry_tickers),
                    COUNT(*)
                 FROM industry_tickers
                 JOIN daily_candles
                   ON daily_candles.symbol = industry_tickers.symbol
                  AND daily_candles.market_date = ?",
        )
        .bind(target_date)
        .fetch_one(&self.pool)
        .await
        .context("failed to load Market Explorer candle summary")?;

        Ok(MarketExplorerCandleSummary {
            total_tickers,
            industry_mapped_tickers: usize::try_from(industry_mapped_tickers)
                .context("invalid industry ticker count")?,
            latest_candle_tickers: usize::try_from(latest_candle_tickers)
                .context("invalid latest candle ticker count")?,
        })
    }

    pub async fn industry_tickers_requiring_candle(
        &self,
        target_date: NaiveDate,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        let symbols = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT industry_membership_tickers.symbol
             FROM industry_membership_tickers
             WHERE NOT EXISTS (
                SELECT 1
                FROM daily_candles
                WHERE daily_candles.symbol = industry_membership_tickers.symbol
                  AND daily_candles.market_date = ?
             )
             ORDER BY industry_membership_tickers.symbol",
        )
        .bind(target_date)
        .fetch_all(&self.pool)
        .await
        .context("failed to load industry tickers requiring candles")?;

        symbols
            .into_iter()
            .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
            .collect()
    }
}
