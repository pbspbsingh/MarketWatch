use crate::config::ProviderConfig;
use crate::store::Store;
use anyhow::Context;
use chrono::{Datelike, NaiveDate, Utc};
use reqwest::Client;
use scraper::{Html, Selector};
use std::collections::HashSet;
use std::time::Duration;
use tracing::{info, warn};

const NYSE_CALENDAR_URL: &str = "https://www.nyse.com/trade/hours-calendars";

pub async fn load_holidays(
    store: &Store,
    providers: &ProviderConfig,
) -> anyhow::Result<HashSet<NaiveDate>> {
    let current_year = Utc::now().year();
    if !store.has_nyse_holidays_for_year(current_year).await? {
        match fetch_holidays(providers).await {
            Ok(holidays) => {
                store.upsert_nyse_holidays(&holidays).await?;
                info!(
                    holiday_count = holidays.len(),
                    "refreshed NYSE holiday calendar"
                );
            }
            Err(error) => {
                warn!(%error, "failed to refresh NYSE holiday calendar; using cached dates")
            }
        }
    }

    Ok(store.nyse_holidays().await?.into_iter().collect())
}

async fn fetch_holidays(providers: &ProviderConfig) -> anyhow::Result<Vec<NaiveDate>> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(providers.connect_timeout_secs))
        .timeout(Duration::from_secs(providers.request_timeout_secs))
        .user_agent("MarketWatch/1.0")
        .build()
        .context("failed to build NYSE calendar client")?;
    info!(url = NYSE_CALENDAR_URL, "requesting NYSE holiday calendar");
    let html = client
        .get(NYSE_CALENDAR_URL)
        .send()
        .await
        .context("failed to fetch NYSE holiday calendar")?
        .error_for_status()
        .context("NYSE holiday calendar returned an error status")?
        .text()
        .await
        .context("failed to read NYSE holiday calendar")?;
    parse_holidays(&html)
}

fn parse_holidays(html: &str) -> anyhow::Result<Vec<NaiveDate>> {
    let document = Html::parse_document(html);
    let table_selector = Selector::parse("table").expect("valid static selector");
    let header_selector = Selector::parse("thead th").expect("valid static selector");
    let row_selector = Selector::parse("tbody tr").expect("valid static selector");
    let cell_selector = Selector::parse("td").expect("valid static selector");

    for table in document.select(&table_selector) {
        let years = table
            .select(&header_selector)
            .skip(1)
            .map(|header| text(&header).parse::<i32>())
            .collect::<Result<Vec<_>, _>>();
        let Ok(years) = years else {
            continue;
        };
        if years.is_empty() {
            continue;
        }

        let mut holidays = Vec::new();
        for row in table.select(&row_selector) {
            for (year, cell) in years.iter().zip(row.select(&cell_selector)) {
                if let Some(date) = parse_date(*year, &text(&cell)) {
                    holidays.push(date);
                }
            }
        }
        if !holidays.is_empty() {
            return Ok(holidays);
        }
    }

    anyhow::bail!("NYSE holiday calendar table was not found")
}

fn parse_date(year: i32, value: &str) -> Option<NaiveDate> {
    let date = value
        .chars()
        .take_while(|character| {
            character.is_ascii_alphabetic()
                || character.is_ascii_digit()
                || matches!(character, ',' | ' ')
        })
        .collect::<String>();
    NaiveDate::parse_from_str(&format!("{date} {year}"), "%A, %B %-d %Y").ok()
}

fn text(element: &scraper::ElementRef<'_>) -> String {
    element.text().collect::<String>().trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_holiday_table_and_ignores_footnotes() {
        let holidays = parse_holidays(
            "<table><thead><tr><th>Holiday</th><th>2026</th></tr></thead><tbody>\
             <tr><th>New Year's Day</th><td>Thursday, January 1</td></tr>\
             <tr><th>Thanksgiving Day</th><td>Thursday, November 26***</td></tr>\
             <tr><th>Unavailable</th><td>—*</td></tr>\
             </tbody></table>",
        )
        .unwrap();

        assert_eq!(
            holidays,
            [
                NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 11, 26).unwrap(),
            ]
        );
    }
}
