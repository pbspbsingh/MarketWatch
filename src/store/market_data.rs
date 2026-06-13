use super::Store;
use crate::models::{CompanyProfile, DailyCandle, Exchange};
use anyhow::Context;
use chrono::{NaiveDate, NaiveDateTime};

struct StoredProfile {
    symbol: String,
    name: Option<String>,
    exchange: String,
    description: Option<String>,
    profile_fetched_at: NaiveDateTime,
}

impl Store {
    pub async fn company_profile(&self, symbol: &str) -> anyhow::Result<Option<CompanyProfile>> {
        let profile = sqlx::query_as!(
            StoredProfile,
            r#"SELECT symbol, name, exchange, description,
                    profile_fetched_at AS "profile_fetched_at!: NaiveDateTime"
             FROM tickers
             WHERE symbol = ? AND profile_fetched_at IS NOT NULL"#,
            symbol,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load company profile")?;

        profile
            .map(|profile| {
                let exchange = Exchange::from_tradingview_code(&profile.exchange)
                    .with_context(|| format!("invalid stored exchange: {}", profile.exchange))?;
                Ok(CompanyProfile {
                    symbol: profile.symbol,
                    name: profile.name,
                    exchange,
                    description: profile.description,
                    fetched_at: profile.profile_fetched_at.and_utc(),
                })
            })
            .transpose()
    }

    pub async fn upsert_company_profile(&self, profile: &CompanyProfile) -> anyhow::Result<()> {
        let exchange = profile.exchange.tradingview_code();
        let fetched_at = profile.fetched_at.naive_utc();
        sqlx::query!(
            "INSERT INTO tickers (
                symbol, name, exchange, description, profile_fetched_at
             )
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (symbol) DO UPDATE SET
                name = excluded.name,
                exchange = excluded.exchange,
                description = excluded.description,
                profile_fetched_at = excluded.profile_fetched_at",
            profile.symbol,
            profile.name,
            exchange,
            profile.description,
            fetched_at,
        )
        .execute(&self.pool)
        .await
        .context("failed to upsert company profile")?;
        Ok(())
    }

    pub async fn latest_daily_candle_date(
        &self,
        symbol: &str,
    ) -> anyhow::Result<Option<NaiveDate>> {
        sqlx::query_scalar!(
            r#"SELECT MAX(market_date) AS "market_date: NaiveDate"
             FROM daily_candles
             WHERE symbol = ?"#,
            symbol,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to load latest daily candle date")
    }

    pub async fn daily_candles(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> anyhow::Result<Vec<DailyCandle>> {
        sqlx::query_as!(
            DailyCandle,
            r#"SELECT symbol, market_date AS "market_date: NaiveDate", open, high, low,
                    close, volume
             FROM daily_candles
             WHERE symbol = ? AND market_date >= ? AND market_date < ?
             ORDER BY market_date"#,
            symbol,
            start,
            end,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load daily candles")
    }

    pub async fn upsert_daily_candles(&self, candles: &[DailyCandle]) -> anyhow::Result<()> {
        if candles.is_empty() {
            return Ok(());
        }

        let symbol = &candles[0].symbol;
        anyhow::ensure!(
            candles.iter().all(|candle| &candle.symbol == symbol),
            "daily candle batch must contain one symbol"
        );

        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin daily candle transaction")?;

        for candle in candles {
            sqlx::query!(
                "INSERT INTO daily_candles (
                    symbol, market_date, open, high, low, close, volume
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (symbol, market_date) DO UPDATE SET
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume",
                candle.symbol,
                candle.market_date,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to upsert daily candle")?;
        }

        transaction
            .commit()
            .await
            .context("failed to commit daily candles")?;
        Ok(())
    }
}
