use super::Store;
use crate::models::{CompanyProfile, DailyCandle, Exchange, TickerSymbol};
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
    pub async fn has_nyse_holidays_for_year(&self, year: i32) -> anyhow::Result<bool> {
        let start = NaiveDate::from_ymd_opt(year, 1, 1).expect("valid calendar year");
        let end = NaiveDate::from_ymd_opt(year + 1, 1, 1).expect("valid calendar year");
        let count = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM nyse_holidays WHERE market_date >= ? AND market_date < ?",
            start,
            end,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to check NYSE holiday calendar")?;
        Ok(count > 0)
    }

    pub async fn nyse_holidays(&self) -> anyhow::Result<Vec<NaiveDate>> {
        sqlx::query_scalar("SELECT market_date FROM nyse_holidays ORDER BY market_date")
            .fetch_all(&self.pool)
            .await
            .context("failed to load NYSE holiday calendar")
    }

    pub async fn upsert_nyse_holidays(&self, holidays: &[NaiveDate]) -> anyhow::Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin NYSE holiday calendar transaction")?;
        let fetched_at = chrono::Utc::now().naive_utc();
        for market_date in holidays {
            sqlx::query!(
                "INSERT INTO nyse_holidays (market_date, fetched_at) VALUES (?, ?) \
                 ON CONFLICT (market_date) DO UPDATE SET fetched_at = excluded.fetched_at",
                market_date,
                fetched_at,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to store NYSE holiday")?;
        }
        transaction
            .commit()
            .await
            .context("failed to commit NYSE holiday calendar")
    }

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
                    symbol: TickerSymbol::try_from(profile.symbol)?,
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
            profile.symbol.as_str(),
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

    pub async fn earliest_daily_candle_date(
        &self,
        symbol: &str,
    ) -> anyhow::Result<Option<NaiveDate>> {
        sqlx::query_scalar!(
            r#"SELECT MIN(market_date) AS "market_date: NaiveDate"
             FROM daily_candles
             WHERE symbol = ?"#,
            symbol,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to load earliest daily candle date")
    }

    pub async fn daily_candles(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> anyhow::Result<Vec<DailyCandle>> {
        sqlx::query_as!(
            DailyCandle,
            r#"SELECT market_date AS "market_date: NaiveDate", open, high, low,
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

    pub async fn upsert_daily_candles(
        &self,
        symbol: &TickerSymbol,
        candles: &[DailyCandle],
    ) -> anyhow::Result<()> {
        if candles.is_empty() {
            return Ok(());
        }

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
                symbol.as_str(),
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

    pub async fn replace_daily_candles(
        &self,
        symbol: &TickerSymbol,
        candles: &[DailyCandle],
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !candles.is_empty(),
            "refusing to replace candles with an empty batch"
        );
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin daily candle replacement transaction")?;
        sqlx::query!(
            "DELETE FROM daily_candles WHERE symbol = ?",
            symbol.as_str()
        )
        .execute(&mut *transaction)
        .await
        .context("failed to delete replaced daily candles")?;
        for candle in candles {
            sqlx::query!(
                "INSERT INTO daily_candles (
                    symbol, market_date, open, high, low, close, volume
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)",
                symbol.as_str(),
                candle.market_date,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert replacement daily candle")?;
        }
        transaction
            .commit()
            .await
            .context("failed to commit daily candle replacement")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(day: u32, close: f64) -> DailyCandle {
        DailyCandle {
            market_date: NaiveDate::from_ymd_opt(2026, 1, day).unwrap(),
            open: close,
            high: close,
            low: close,
            close,
            volume: 1_000,
        }
    }

    #[tokio::test]
    async fn stores_nyse_holidays_by_year() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let holidays = [
            NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(),
        ];

        store.upsert_nyse_holidays(&holidays).await.unwrap();

        assert!(store.has_nyse_holidays_for_year(2026).await.unwrap());
        assert!(!store.has_nyse_holidays_for_year(2028).await.unwrap());
        assert_eq!(store.nyse_holidays().await.unwrap(), holidays);
    }

    #[tokio::test]
    async fn atomically_replaces_one_symbols_daily_candles() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        sqlx::query!("INSERT INTO tickers (symbol, exchange) VALUES ('TEST', 'NASDAQ')")
            .execute(&store.pool)
            .await
            .unwrap();
        store
            .upsert_daily_candles(
                &TickerSymbol::parse("TEST").unwrap(),
                &[candle(1, 10.0), candle(2, 11.0)],
            )
            .await
            .unwrap();

        store
            .replace_daily_candles(&TickerSymbol::parse("TEST").unwrap(), &[candle(3, 12.0)])
            .await
            .unwrap();

        assert_eq!(
            store
                .daily_candles(
                    "TEST",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                )
                .await
                .unwrap(),
            vec![candle(3, 12.0)],
        );
        assert!(
            store
                .replace_daily_candles(&TickerSymbol::parse("TEST").unwrap(), &[])
                .await
                .is_err()
        );
        assert_eq!(
            store
                .daily_candles(
                    "TEST",
                    NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                    NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
                )
                .await
                .unwrap()
                .len(),
            1,
        );
    }
}
