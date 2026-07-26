use super::Store;
use crate::models::TickerSymbol;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::{QueryBuilder, Sqlite};

#[derive(Debug, PartialEq)]
pub struct TickerIndustryMembership {
    pub industry_key: String,
    pub industry_name: String,
    pub symbol: TickerSymbol,
}

impl Store {
    pub async fn ticker_has_industry(&self, symbol: &TickerSymbol) -> anyhow::Result<bool> {
        let symbol = symbol.as_str();
        sqlx::query_scalar!(
            "SELECT EXISTS(
                SELECT 1 FROM industry_membership_tickers WHERE symbol = ?
             ) AS \"exists!: bool\"",
            symbol,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to check ticker industry")
    }

    pub async fn add_ticker_industry(
        &self,
        industry_key: &str,
        industry_name: &str,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<()> {
        let symbol = symbol.as_str();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin ticker industry transaction")?;
        let stale_fetched_at = DateTime::<Utc>::UNIX_EPOCH.naive_utc();
        sqlx::query!(
            "INSERT INTO industry_memberships (industry_key, industry_name, fetched_at)
             VALUES (?, ?, ?)
             ON CONFLICT (industry_key) DO UPDATE SET industry_name = excluded.industry_name",
            industry_key,
            industry_name,
            stale_fetched_at,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to ensure industry membership")?;
        sqlx::query!(
            "INSERT INTO industry_membership_tickers (industry_key, symbol)
             VALUES (?, ?)
             ON CONFLICT (industry_key, symbol) DO NOTHING",
            industry_key,
            symbol,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to add ticker industry")?;
        transaction
            .commit()
            .await
            .context("failed to commit ticker industry")
    }

    pub async fn industry_membership_fetched_at(
        &self,
        industry_key: &str,
    ) -> anyhow::Result<Option<DateTime<Utc>>> {
        sqlx::query_scalar!(
            r#"SELECT fetched_at AS "fetched_at: NaiveDateTime"
               FROM industry_memberships
               WHERE industry_key = ?"#,
            industry_key,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load industry membership fetch time")
        .map(|value| value.map(|value| value.and_utc()))
    }

    pub async fn replace_industry_membership(
        &self,
        industry_key: &str,
        fetched_at: DateTime<Utc>,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin industry membership transaction")?;
        let fetched_at = fetched_at.naive_utc();
        sqlx::query!(
            "INSERT INTO industry_memberships (industry_key, fetched_at)
             VALUES (?, ?)
             ON CONFLICT (industry_key) DO UPDATE SET fetched_at = excluded.fetched_at",
            industry_key,
            fetched_at,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to upsert industry membership")?;
        sqlx::query!(
            "DELETE FROM industry_membership_tickers WHERE industry_key = ?",
            industry_key,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to clear industry membership tickers")?;

        for symbol in symbols {
            sqlx::query!(
                "INSERT INTO industry_membership_tickers (industry_key, symbol)
                 VALUES (?, ?)",
                industry_key,
                symbol.as_str(),
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert industry membership ticker")?;
        }

        transaction
            .commit()
            .await
            .context("failed to commit industry membership")?;
        Ok(())
    }

    pub async fn known_tickers(&self) -> anyhow::Result<Vec<TickerSymbol>> {
        let symbols = sqlx::query_scalar!(
            "SELECT symbol FROM tickers
             UNION
             SELECT symbol FROM industry_membership_tickers
             UNION
             SELECT symbol FROM theme_stocks
             ORDER BY symbol"
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load known tickers")?;
        symbols
            .into_iter()
            .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
            .collect()
    }

    pub async fn tickers_for_industries(
        &self,
        industry_keys: &[String],
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        if industry_keys.is_empty() {
            return self.known_tickers().await;
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT DISTINCT symbol
             FROM industry_membership_tickers
             WHERE industry_key IN (",
        );
        {
            let mut separated = query.separated(", ");
            for industry_key in industry_keys {
                separated.push_bind(industry_key);
            }
        }
        query.push(") ORDER BY symbol");
        let symbols = query
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load tickers for industries")?;
        symbols
            .into_iter()
            .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
            .collect()
    }

    pub async fn industry_for_ticker(
        &self,
        symbol: &TickerSymbol,
        industry_keys: &[String],
    ) -> anyhow::Result<Option<(String, String)>> {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT industry_membership_tickers.industry_key,
                    industry_rankings.industry_name
             FROM industry_membership_tickers
             JOIN industry_rankings
               ON industry_rankings.industry_key = industry_membership_tickers.industry_key
             WHERE symbol = ",
        );
        query.push_bind(symbol.as_str());
        if !industry_keys.is_empty() {
            query.push(" AND industry_membership_tickers.industry_key IN (");
            let mut separated = query.separated(", ");
            for industry_key in industry_keys {
                separated.push_bind(industry_key);
            }
            query.push(")");
        }
        query.push(" LIMIT 1");
        query
            .build_query_as::<(String, String)>()
            .fetch_optional(&self.pool)
            .await
            .context("failed to load ticker industry")
    }

    pub async fn industries_for_symbols(
        &self,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerIndustryMembership>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT industry_membership_tickers.industry_key,
                    industry_rankings.industry_name,
                    industry_membership_tickers.symbol
             FROM industry_membership_tickers
             JOIN industry_rankings
               ON industry_rankings.industry_key = industry_membership_tickers.industry_key
             WHERE industry_membership_tickers.symbol IN (",
        );
        {
            let mut separated = query.separated(", ");
            for symbol in symbols {
                separated.push_bind(symbol.as_str());
            }
        }
        query
            .push(") ORDER BY industry_rankings.industry_name, industry_membership_tickers.symbol");
        let rows = query
            .build_query_as::<(String, String, String)>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load industries for symbols")?;
        rows.into_iter()
            .map(|(industry_key, industry_name, symbol)| {
                Ok(TickerIndustryMembership {
                    industry_key,
                    industry_name,
                    symbol: TickerSymbol::try_from(symbol)?,
                })
            })
            .collect()
    }

    pub async fn all_industries_for_symbols<'a>(
        &self,
        symbols: impl IntoIterator<Item = &'a TickerSymbol>,
    ) -> anyhow::Result<Vec<TickerIndustryMembership>> {
        let symbols = symbols.into_iter().collect::<Vec<_>>();
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT industry_membership_tickers.industry_key,
                    COALESCE(
                        industry_rankings.industry_name,
                        industry_memberships.industry_name,
                        industry_membership_tickers.industry_key
                    ) AS industry_name,
                    industry_membership_tickers.symbol
             FROM industry_membership_tickers
             JOIN industry_memberships
               ON industry_memberships.industry_key = industry_membership_tickers.industry_key
             LEFT JOIN industry_rankings
               ON industry_rankings.industry_key = industry_membership_tickers.industry_key
             WHERE industry_membership_tickers.symbol IN (",
        );
        {
            let mut separated = query.separated(", ");
            for symbol in symbols {
                separated.push_bind(symbol.as_str());
            }
        }
        query.push(" ) ORDER BY industry_name, industry_membership_tickers.symbol");
        let rows = query
            .build_query_as::<(String, String, String)>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load all ticker industries")?;
        rows.into_iter()
            .map(|(industry_key, industry_name, symbol)| {
                Ok(TickerIndustryMembership {
                    industry_key,
                    industry_name,
                    symbol: TickerSymbol::try_from(symbol)?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{IndustryRankingRow, IndustryRankings};
    use chrono::NaiveDate;

    #[tokio::test]
    async fn stores_filters_and_unions_known_membership_tickers() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store
            .replace_industry_membership(
                "semiconductors",
                Utc::now(),
                &[
                    TickerSymbol::parse("AMD").unwrap(),
                    TickerSymbol::parse("NVDA").unwrap(),
                ],
            )
            .await
            .unwrap();
        store
            .replace_industry_membership(
                "computerhardware",
                Utc::now(),
                &[
                    TickerSymbol::parse("NVDA").unwrap(),
                    TickerSymbol::parse("SMCI").unwrap(),
                ],
            )
            .await
            .unwrap();

        assert_eq!(
            store.known_tickers().await.unwrap(),
            ["AMD", "NVDA", "SMCI"]
        );
        assert_eq!(
            store
                .tickers_for_industries(&["semiconductors".to_owned()])
                .await
                .unwrap(),
            ["AMD", "NVDA"]
        );
        assert_eq!(
            store
                .tickers_for_industries(&[
                    "semiconductors".to_owned(),
                    "computerhardware".to_owned(),
                ])
                .await
                .unwrap(),
            ["AMD", "NVDA", "SMCI"]
        );
        store
            .replace_industry_rankings_if_newer(&IndustryRankings {
                market_date: NaiveDate::from_ymd_opt(2026, 6, 17).unwrap(),
                fetched_at: Utc::now(),
                rows: vec![IndustryRankingRow {
                    key: "semiconductors".to_owned(),
                    name: "Semiconductors".to_owned(),
                    performance_day: 0.0,
                    performance_week: 0.0,
                    performance_month: 0.0,
                    performance_quarter: 0.0,
                    performance_half_year: 0.0,
                    performance_year: 0.0,
                    performance_year_to_date: 0.0,
                }],
            })
            .await
            .unwrap();
        assert_eq!(
            store
                .industry_for_ticker(&TickerSymbol::parse("NVDA").unwrap(), &[])
                .await
                .unwrap(),
            Some(("semiconductors".to_owned(), "Semiconductors".to_owned()))
        );
        assert_eq!(
            store
                .industry_for_ticker(
                    &TickerSymbol::parse("NVDA").unwrap(),
                    &["computerhardware".to_owned()],
                )
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn stores_ticker_industry_without_current_ranking() {
        let store = Store::connect("sqlite::memory:").await.unwrap();

        store
            .add_ticker_industry(
                "unknownindustry",
                "Unknown Industry",
                &TickerSymbol::parse("TICKER").unwrap(),
            )
            .await
            .unwrap();

        assert!(
            store
                .ticker_has_industry(&TickerSymbol::parse("TICKER").unwrap())
                .await
                .unwrap()
        );
        assert_eq!(store.known_tickers().await.unwrap(), ["TICKER"]);
        assert_eq!(
            store
                .all_industries_for_symbols(std::iter::once(
                    &TickerSymbol::parse("TICKER").unwrap(),
                ))
                .await
                .unwrap(),
            [TickerIndustryMembership {
                industry_key: "unknownindustry".to_owned(),
                industry_name: "Unknown Industry".to_owned(),
                symbol: TickerSymbol::parse("TICKER").unwrap(),
            }]
        );
    }
}
