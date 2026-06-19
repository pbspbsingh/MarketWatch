use crate::models::{
    AssignmentSource, Theme, ThemeAiJob, ThemeAiJobStatus, ThemeAiJobSummary, ThemeSuggestion,
    ThemeTicker,
};
use crate::providers::{AiClient, AiError};
use crate::services::tickers::TickerCatalogService;
use crate::store::Store;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;
use tracing::error;

const MAX_THEMES_PER_TICKER: usize = 2;

pub struct ThemeService {
    store: Store,
    ai: Option<Arc<AiClient>>,
    ticker_catalog: Arc<TickerCatalogService>,
}

#[derive(Serialize)]
pub struct AiCapability {
    pub enabled: bool,
    pub model: Option<String>,
    pub batch_size: Option<usize>,
}

#[derive(Debug, Error)]
pub enum ThemeServiceError {
    #[error("{0}")]
    Validation(String),

    #[error(transparent)]
    Ai(#[from] AiError),

    #[error("theme persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error("ticker catalog failed: {0}")]
    TickerCatalog(#[source] anyhow::Error),

    #[error("invalid AI response: {0}")]
    InvalidAiResponse(#[source] serde_json::Error),
}

impl ThemeService {
    pub fn new(
        store: Store,
        ai: Option<Arc<AiClient>>,
        ticker_catalog: Arc<TickerCatalogService>,
    ) -> Self {
        Self {
            store,
            ai,
            ticker_catalog,
        }
    }

    pub async fn themes(&self) -> Result<Vec<Theme>, ThemeServiceError> {
        self.store
            .themes()
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn create(
        &self,
        name: &str,
        etf_symbol: &str,
        description: Option<&str>,
    ) -> Result<i64, ThemeServiceError> {
        let (name, etf_symbol, description) = normalize_theme(name, etf_symbol, description)?;
        if self
            .themes()
            .await?
            .iter()
            .any(|theme| theme.name.eq_ignore_ascii_case(&name))
        {
            return Err(ThemeServiceError::Validation(format!(
                "theme {name} already exists"
            )));
        }
        self.store
            .create_theme(&name, &etf_symbol, description.as_deref())
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn update(
        &self,
        id: i64,
        name: &str,
        etf_symbol: &str,
        description: Option<&str>,
    ) -> Result<(), ThemeServiceError> {
        let (name, etf_symbol, description) = normalize_theme(name, etf_symbol, description)?;
        if self
            .themes()
            .await?
            .iter()
            .any(|theme| theme.id != id && theme.name.eq_ignore_ascii_case(&name))
        {
            return Err(ThemeServiceError::Validation(format!(
                "theme {name} already exists"
            )));
        }
        let updated = self
            .store
            .update_theme(id, &name, &etf_symbol, description.as_deref())
            .await
            .map_err(ThemeServiceError::Persistence)?;
        updated
            .then_some(())
            .ok_or_else(|| ThemeServiceError::Validation("theme does not exist".to_owned()))
    }

    pub async fn delete(&self, id: i64) -> Result<(), ThemeServiceError> {
        let deleted = self
            .store
            .delete_theme(id)
            .await
            .map_err(ThemeServiceError::Persistence)?;
        deleted
            .then_some(())
            .ok_or_else(|| ThemeServiceError::Validation("theme does not exist".to_owned()))
    }

    pub async fn tickers(&self) -> Result<Vec<ThemeTicker>, ThemeServiceError> {
        self.store
            .theme_tickers()
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn ticker(&self, symbol: &str) -> Result<ThemeTicker, ThemeServiceError> {
        let symbol = symbol.trim().to_uppercase();
        validate_symbol(&symbol)?;
        self.ensure_ticker(&symbol).await?;
        self.store
            .theme_ticker(&symbol)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .ok_or_else(|| ThemeServiceError::Validation(format!("ticker {symbol} does not exist")))
    }

    pub async fn replace_manual(
        &self,
        symbol: &str,
        theme_ids: &[i64],
    ) -> Result<(), ThemeServiceError> {
        validate_symbol(symbol)?;
        validate_count(theme_ids.len())?;
        self.ensure_ticker(symbol).await?;
        let known_ids = self
            .themes()
            .await?
            .into_iter()
            .map(|theme| theme.id)
            .collect::<HashSet<_>>();
        if theme_ids.iter().any(|id| !known_ids.contains(id)) {
            return Err(ThemeServiceError::Validation(
                "one or more themes do not exist".to_owned(),
            ));
        }
        if theme_ids.iter().collect::<HashSet<_>>().len() != theme_ids.len() {
            return Err(ThemeServiceError::Validation(
                "duplicate theme assignment".to_owned(),
            ));
        }
        self.store
            .replace_theme_assignments(
                &symbol.trim().to_uppercase(),
                theme_ids,
                AssignmentSource::Manual,
                None,
                None,
            )
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn prompt(&self, symbols: &[String]) -> Result<String, ThemeServiceError> {
        let themes = self.themes().await?;
        let tickers = self.selected_tickers(symbols).await?;
        Ok(build_prompt(&themes, &tickers))
    }

    pub async fn parse_suggestions(
        &self,
        response: &str,
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let suggestions: Vec<ThemeSuggestion> = serde_json::from_str(strip_code_fence(response))
            .map_err(ThemeServiceError::InvalidAiResponse)?;
        self.validate_suggestions(suggestions).await
    }

    pub async fn suggest(
        &self,
        symbols: &[String],
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let ai = self.ai.as_ref().ok_or_else(|| {
            ThemeServiceError::Validation("AI theme suggestion is disabled".into())
        })?;
        let themes = self.themes().await?;
        let tickers = self.selected_tickers(symbols).await?;
        let prompt = build_prompt(&themes, &tickers);
        let response = ai.complete(&prompt).await?;
        let suggestions: Vec<ThemeSuggestion> = serde_json::from_str(strip_code_fence(&response))
            .map_err(ThemeServiceError::InvalidAiResponse)?;
        let symbols = tickers
            .iter()
            .map(|ticker| ticker.symbol.clone())
            .collect::<Vec<_>>();
        self.validate_automatic_suggestions(suggestions, &symbols)
            .await
    }

    pub async fn create_automatic_jobs(
        self: &Arc<Self>,
        symbols: &[String],
    ) -> Result<Vec<i64>, ThemeServiceError> {
        let ai = self.ai.as_ref().ok_or_else(|| {
            ThemeServiceError::Validation("automatic AI mapping is disabled".into())
        })?;
        let themes = self.themes().await?;
        let tickers = self.selected_tickers(symbols).await?;
        let batches = tickers
            .chunks(ai.batch_size())
            .map(|batch| {
                (
                    batch
                        .iter()
                        .map(|ticker| ticker.symbol.clone())
                        .collect::<Vec<_>>(),
                    build_prompt(&themes, batch),
                )
            })
            .collect::<Vec<_>>();
        let job_ids = self
            .store
            .create_theme_ai_jobs(ai.model(), &batches)
            .await
            .map_err(ThemeServiceError::Persistence)?;
        for (job_id, (_, prompt)) in job_ids.iter().copied().zip(batches) {
            let service = self.clone();
            tokio::spawn(async move {
                if let Err(job_error) = service.run_automatic_job(job_id, prompt).await {
                    error!(job_id, %job_error, "theme AI job failed");
                    if let Err(persistence_error) = service
                        .store
                        .fail_theme_ai_job(job_id, &job_error.to_string())
                        .await
                    {
                        error!(job_id, %persistence_error, "failed to persist theme AI job failure");
                    }
                }
            });
        }
        Ok(job_ids)
    }

    pub async fn ai_jobs(&self) -> Result<Vec<ThemeAiJobSummary>, ThemeServiceError> {
        self.store
            .theme_ai_jobs()
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn ai_job(&self, id: i64) -> Result<ThemeAiJob, ThemeServiceError> {
        self.store
            .theme_ai_job(id)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .ok_or_else(|| ThemeServiceError::Validation("AI job does not exist".to_owned()))
    }

    pub async fn apply_ai_job(&self, id: i64) -> Result<(), ThemeServiceError> {
        let job = self
            .store
            .theme_ai_job(id)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .ok_or_else(|| ThemeServiceError::Validation("AI job does not exist".to_owned()))?;
        if !matches!(job.status, ThemeAiJobStatus::Completed) {
            return Err(ThemeServiceError::Validation(
                "only completed AI jobs can be applied".to_owned(),
            ));
        }
        let suggestions = job.suggestions.ok_or_else(|| {
            ThemeServiceError::Validation("completed AI job has no suggestions".to_owned())
        })?;
        let suggestions = self
            .validate_automatic_suggestions(suggestions, &job.symbols)
            .await?;
        self.persist_suggestions(suggestions, AssignmentSource::AutomaticAi, Some(&job.model))
            .await?;
        self.store
            .mark_theme_ai_job_applied(id)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn delete_ai_job(&self, id: i64) -> Result<(), ThemeServiceError> {
        self.store
            .delete_theme_ai_job(id)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| {
                ThemeServiceError::Validation(
                    "running AI jobs cannot be discarded or job does not exist".to_owned(),
                )
            })
    }

    async fn run_automatic_job(&self, id: i64, prompt: String) -> Result<(), ThemeServiceError> {
        let ai = self.ai.as_ref().ok_or_else(|| {
            ThemeServiceError::Validation("automatic AI mapping is disabled".into())
        })?;
        self.store
            .set_theme_ai_job_running(id)
            .await
            .map_err(ThemeServiceError::Persistence)?;
        let response = ai.complete(&prompt).await?;
        let suggestions: Vec<ThemeSuggestion> = serde_json::from_str(strip_code_fence(&response))
            .map_err(ThemeServiceError::InvalidAiResponse)?;
        let job = self.ai_job(id).await?;
        let suggestions = self
            .validate_automatic_suggestions(suggestions, &job.symbols)
            .await?;
        self.store
            .complete_theme_ai_job(id, &response, &suggestions)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn apply_suggestions(
        &self,
        suggestions: Vec<ThemeSuggestion>,
        source: AssignmentSource,
    ) -> Result<(), ThemeServiceError> {
        let suggestions = self.validate_suggestions(suggestions).await?;
        let model = match source {
            AssignmentSource::AutomaticAi => self.ai.as_ref().map(|ai| ai.model()),
            _ => None,
        };
        self.persist_suggestions(suggestions, source, model).await
    }

    async fn persist_suggestions(
        &self,
        suggestions: Vec<ThemeSuggestion>,
        source: AssignmentSource,
        model: Option<&str>,
    ) -> Result<(), ThemeServiceError> {
        let mut assignments = Vec::with_capacity(suggestions.len());
        for suggestion in suggestions {
            let ids = self
                .store
                .theme_ids_by_names(&suggestion.themes)
                .await
                .map_err(ThemeServiceError::Persistence)?;
            assignments.push((suggestion.symbol, ids, suggestion.reasoning));
        }
        self.store
            .replace_theme_assignment_batch(&assignments, source, model)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub fn ai_capability(&self) -> AiCapability {
        AiCapability {
            enabled: self.ai.is_some(),
            model: self.ai.as_ref().map(|ai| ai.model().to_owned()),
            batch_size: self.ai.as_ref().map(|ai| ai.batch_size()),
        }
    }

    async fn selected_tickers(
        &self,
        symbols: &[String],
    ) -> Result<Vec<ThemeTicker>, ThemeServiceError> {
        let requested = symbols
            .iter()
            .map(|symbol| symbol.trim().to_uppercase())
            .collect::<HashSet<_>>();
        if requested.is_empty() {
            return Err(ThemeServiceError::Validation(
                "select at least one ticker".to_owned(),
            ));
        }
        let tickers = self
            .tickers()
            .await?
            .into_iter()
            .filter(|ticker| requested.contains(&ticker.symbol))
            .collect::<Vec<_>>();
        if tickers.len() != requested.len() {
            return Err(ThemeServiceError::Validation(
                "one or more selected tickers are unknown".to_owned(),
            ));
        }
        for ticker in &tickers {
            let profile = self
                .store
                .company_profile(&ticker.symbol)
                .await
                .map_err(ThemeServiceError::Persistence)?;
            if profile.is_none() {
                self.ensure_ticker(&ticker.symbol).await?;
            }
        }
        let tickers = self
            .tickers()
            .await?
            .into_iter()
            .filter(|ticker| requested.contains(&ticker.symbol))
            .collect::<Vec<_>>();
        Ok(tickers)
    }

    async fn validate_suggestions(
        &self,
        mut suggestions: Vec<ThemeSuggestion>,
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let known_themes = self
            .themes()
            .await?
            .into_iter()
            .map(|theme| (theme.name.to_lowercase(), theme.name))
            .collect::<HashMap<_, _>>();
        let mut seen = HashSet::new();
        for suggestion in &mut suggestions {
            suggestion.symbol = suggestion.symbol.trim().to_uppercase();
            validate_symbol(&suggestion.symbol)?;
            self.ensure_ticker(&suggestion.symbol).await?;
            if !seen.insert(suggestion.symbol.clone()) {
                return Err(ThemeServiceError::Validation(format!(
                    "duplicate suggestion for {}",
                    suggestion.symbol
                )));
            }
            validate_count(suggestion.themes.len())?;
            let mut unique = HashSet::new();
            for theme in &mut suggestion.themes {
                let canonical =
                    known_themes
                        .get(&theme.trim().to_lowercase())
                        .ok_or_else(|| {
                            ThemeServiceError::Validation(format!("unknown theme {theme}"))
                        })?;
                *theme = canonical.clone();
                if !unique.insert(theme.clone()) {
                    return Err(ThemeServiceError::Validation(format!(
                        "duplicate theme {} for {}",
                        theme, suggestion.symbol
                    )));
                }
            }
        }
        Ok(suggestions)
    }

    async fn validate_automatic_suggestions(
        &self,
        mut suggestions: Vec<ThemeSuggestion>,
        job_symbols: &[String],
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let job_symbols = job_symbols
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        for suggestion in &mut suggestions {
            suggestion.symbol = suggestion.symbol.trim().to_uppercase();
            if !job_symbols.contains(suggestion.symbol.as_str()) {
                return Err(ThemeServiceError::Validation(format!(
                    "{} is not part of this AI job",
                    suggestion.symbol
                )));
            }
        }
        self.validate_suggestions(suggestions).await
    }

    pub async fn ensure_ticker(&self, symbol: &str) -> Result<(), ThemeServiceError> {
        validate_symbol(symbol)?;
        self.ticker_catalog
            .ensure_ticker(symbol)
            .await
            .map_err(ThemeServiceError::TickerCatalog)
    }
}

fn normalize_theme(
    name: &str,
    etf_symbol: &str,
    description: Option<&str>,
) -> Result<(String, String, Option<String>), ThemeServiceError> {
    let name = name.trim();
    let etf_symbol = etf_symbol.trim().to_uppercase();
    if name.is_empty() {
        return Err(ThemeServiceError::Validation(
            "theme name is required".into(),
        ));
    }
    validate_symbol(&etf_symbol)?;
    Ok((
        name.to_owned(),
        etf_symbol,
        description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    ))
}

fn validate_symbol(symbol: &str) -> Result<(), ThemeServiceError> {
    if symbol.is_empty()
        || !symbol
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
    {
        return Err(ThemeServiceError::Validation(format!(
            "invalid ticker symbol {symbol}"
        )));
    }
    Ok(())
}

fn validate_count(count: usize) -> Result<(), ThemeServiceError> {
    if count > MAX_THEMES_PER_TICKER {
        return Err(ThemeServiceError::Validation(
            "a ticker may have at most two themes".to_owned(),
        ));
    }
    Ok(())
}

fn build_prompt(themes: &[Theme], tickers: &[ThemeTicker]) -> String {
    let themes = themes
        .iter()
        .map(|theme| {
            format!(
                "- {}: {}",
                theme.name,
                theme.description.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let tickers = tickers
        .iter()
        .map(|ticker| {
            format!(
                "- {} | {} | {}",
                ticker.symbol,
                ticker.name.as_deref().unwrap_or("Unknown"),
                ticker
                    .description
                    .as_deref()
                    .unwrap_or("No profile available")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"Assign themes to stocks based on each company's core business.

Rules:
- Use only themes from the available themes list. Do not create new themes, variants, synonyms, or near-duplicates.
- Assign one theme when there is a strong fit.
- Assign a second theme only when it represents another distinct, material business driver.
- Never assign more than two themes.
- Avoid themes related only to peripheral or minor activities.
- If no available theme fits a ticker, leave its themes array empty.
- Return JSON only. Do not include explanations or markdown.

Response format:
[{{"symbol":"AAPL","themes":["Theme Name"],"reasoning":"brief reason"}}]

Available themes:
{themes}

Tickers:
{tickers}"#
    )
}

fn strip_code_fence(response: &str) -> &str {
    let trimmed = response.trim();
    trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed)
}
