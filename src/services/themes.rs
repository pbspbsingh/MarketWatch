use crate::models::{
    AssignmentSource, Theme, ThemeAiJob, ThemeAiJobStatus, ThemeAiJobSummary, ThemeSuggestion,
    ThemeSuggestionError, ThemeTicker, TickerSymbol,
};
use crate::providers::{AiClient, AiError};
use crate::services::tickers::TickerCatalogService;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;
use tracing::error;

const MAX_THEMES_PER_TICKER: usize = 2;

struct AutomaticValidation {
    suggestions: Vec<ThemeSuggestion>,
    errors: Vec<ThemeSuggestionError>,
}

#[derive(Deserialize)]
struct RawThemeSuggestion {
    symbol: String,
    themes: Vec<String>,
    #[serde(default)]
    reasoning: Option<String>,
}

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
        etf_symbol: &TickerSymbol,
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
        etf_symbol: &TickerSymbol,
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

    pub async fn filter_industries(
        &self,
    ) -> Result<Vec<crate::models::ThemeTickerIndustry>, ThemeServiceError> {
        self.store
            .theme_filter_industries()
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn delete_ticker(&self, symbol: &TickerSymbol) -> Result<(), ThemeServiceError> {
        self.store
            .delete_ticker(symbol)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| ThemeServiceError::Validation("ticker does not exist".to_owned()))
    }

    pub async fn ticker(&self, symbol: &TickerSymbol) -> Result<ThemeTicker, ThemeServiceError> {
        self.ensure_ticker(symbol).await?;
        self.store
            .theme_ticker(symbol)
            .await
            .map_err(ThemeServiceError::Persistence)?
            .ok_or_else(|| ThemeServiceError::Validation(format!("ticker {symbol} does not exist")))
    }

    pub async fn replace_manual(
        &self,
        symbol: &TickerSymbol,
        theme_ids: &[i64],
    ) -> Result<(), ThemeServiceError> {
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
            .replace_theme_assignments(symbol, theme_ids, AssignmentSource::Manual, None, None)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    pub async fn prompt(&self, symbols: &[TickerSymbol]) -> Result<String, ThemeServiceError> {
        let themes = self.themes().await?;
        let tickers = self.selected_tickers(symbols).await?;
        Ok(build_prompt(&themes, &tickers))
    }

    pub async fn parse_suggestions(
        &self,
        response: &str,
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let suggestions: Vec<RawThemeSuggestion> = serde_json::from_str(strip_code_fence(response))
            .map_err(ThemeServiceError::InvalidAiResponse)?;
        self.validate_raw_suggestions(suggestions).await
    }

    pub async fn suggest(
        &self,
        symbols: &[TickerSymbol],
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let ai = self.ai.as_ref().ok_or_else(|| {
            ThemeServiceError::Validation("AI theme suggestion is disabled".into())
        })?;
        let themes = self.themes().await?;
        let tickers = self.selected_tickers(symbols).await?;
        let prompt = build_prompt(&themes, &tickers);
        let response = ai.complete(&prompt).await?;
        let suggestions: Vec<RawThemeSuggestion> =
            serde_json::from_str(strip_code_fence(&response))
                .map_err(ThemeServiceError::InvalidAiResponse)?;
        let symbols = tickers
            .iter()
            .map(|ticker| ticker.symbol.clone())
            .collect::<Vec<_>>();
        let suggestions = typed_suggestions(suggestions)?;
        self.validate_automatic_suggestions(suggestions, &symbols)
            .await
    }

    pub async fn create_automatic_jobs(
        self: &Arc<Self>,
        symbols: &[TickerSymbol],
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
            self.spawn_automatic_job(job_id, prompt);
        }
        Ok(job_ids)
    }

    pub async fn retry_automatic_job(self: &Arc<Self>, id: i64) -> Result<i64, ThemeServiceError> {
        let ai = self.ai.as_ref().ok_or_else(|| {
            ThemeServiceError::Validation("automatic AI mapping is disabled".into())
        })?;
        let job = self.ai_job(id).await?;
        if !matches!(job.status, ThemeAiJobStatus::Failed) {
            return Err(ThemeServiceError::Validation(
                "only failed AI jobs can be retried".to_owned(),
            ));
        }
        if job.model != ai.model() {
            return Err(ThemeServiceError::Validation(format!(
                "job model {} does not match configured model {}",
                job.model,
                ai.model()
            )));
        }
        if !self
            .store
            .retry_theme_ai_job(id)
            .await
            .map_err(ThemeServiceError::Persistence)?
        {
            return Err(ThemeServiceError::Validation(
                "AI job is no longer failed".to_owned(),
            ));
        }
        self.spawn_automatic_job(id, job.prompt);
        Ok(id)
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
        if !matches!(
            job.status,
            ThemeAiJobStatus::Completed | ThemeAiJobStatus::PartiallyFailed
        ) {
            return Err(ThemeServiceError::Validation(
                "only completed or partially failed AI jobs can be applied".to_owned(),
            ));
        }
        let suggestions = job.suggestions.ok_or_else(|| {
            ThemeServiceError::Validation("completed AI job has no suggestions".to_owned())
        })?;
        let suggestions = self
            .validate_automatic_suggestions(suggestions, &job.symbols)
            .await?;
        let assignments = self.resolve_suggestions(suggestions).await?;
        self.store
            .apply_theme_ai_job(id, &assignments, &job.model)
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
        let job = self.ai_job(id).await?;
        let validation = self
            .validate_automatic_response(&response, &job.symbols)
            .await?;
        self.store
            .finish_theme_ai_job(id, &response, &validation.suggestions, &validation.errors)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    fn spawn_automatic_job(self: &Arc<Self>, job_id: i64, prompt: String) {
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
        let assignments = self.resolve_suggestions(suggestions).await?;
        self.store
            .replace_theme_assignment_batch(&assignments, source, model)
            .await
            .map_err(ThemeServiceError::Persistence)
    }

    async fn resolve_suggestions(
        &self,
        suggestions: Vec<ThemeSuggestion>,
    ) -> Result<Vec<(TickerSymbol, Vec<i64>, Option<String>)>, ThemeServiceError> {
        let mut assignments = Vec::with_capacity(suggestions.len());
        for suggestion in suggestions {
            let ids = self
                .store
                .theme_ids_by_names(&suggestion.themes)
                .await
                .map_err(ThemeServiceError::Persistence)?;
            assignments.push((suggestion.symbol, ids, suggestion.reasoning));
        }
        Ok(assignments)
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
        symbols: &[TickerSymbol],
    ) -> Result<Vec<ThemeTicker>, ThemeServiceError> {
        let requested = symbols.iter().cloned().collect::<HashSet<_>>();
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

    async fn validate_raw_suggestions(
        &self,
        suggestions: Vec<RawThemeSuggestion>,
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let suggestions = typed_suggestions(suggestions)?;
        self.validate_suggestions(suggestions).await
    }

    async fn validate_automatic_suggestions(
        &self,
        suggestions: Vec<ThemeSuggestion>,
        job_symbols: &[TickerSymbol],
    ) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
        let job_symbols = job_symbols.iter().collect::<HashSet<_>>();
        for suggestion in &suggestions {
            if !job_symbols.contains(&suggestion.symbol) {
                return Err(ThemeServiceError::Validation(format!(
                    "{} is not part of this AI job",
                    suggestion.symbol
                )));
            }
        }
        self.validate_suggestions(suggestions).await
    }

    async fn validate_automatic_response(
        &self,
        response: &str,
        job_symbols: &[TickerSymbol],
    ) -> Result<AutomaticValidation, ThemeServiceError> {
        let values: Vec<serde_json::Value> = serde_json::from_str(strip_code_fence(response))
            .map_err(ThemeServiceError::InvalidAiResponse)?;
        let allowed = job_symbols.iter().cloned().collect::<HashSet<_>>();
        let known_themes = self.known_theme_names().await?;
        let mut seen = HashSet::new();
        let mut returned = HashSet::new();
        let mut suggestions = Vec::new();
        let mut errors = Vec::new();

        for value in values {
            let symbol = value
                .get("symbol")
                .and_then(serde_json::Value::as_str)
                .map(|symbol| symbol.trim().to_uppercase())
                .filter(|symbol| !symbol.is_empty());
            if let Some(symbol) = &symbol {
                returned.insert(symbol.clone());
            }
            let suggestion = match serde_json::from_value::<RawThemeSuggestion>(value) {
                Ok(suggestion) => suggestion,
                Err(error) => {
                    errors.push(ThemeSuggestionError {
                        symbol,
                        error: format!("invalid suggestion: {error}"),
                    });
                    continue;
                }
            };
            match self
                .validate_one_suggestion(suggestion, &known_themes, Some(&allowed), &mut seen)
                .await
            {
                Ok(suggestion) => suggestions.push(suggestion),
                Err((symbol, error)) => errors.push(ThemeSuggestionError { symbol, error }),
            }
        }

        for symbol in job_symbols {
            if !returned.contains(symbol.as_str()) {
                errors.push(ThemeSuggestionError {
                    symbol: Some(symbol.to_string()),
                    error: "AI response omitted this ticker".to_owned(),
                });
            }
        }

        Ok(AutomaticValidation {
            suggestions,
            errors,
        })
    }

    async fn known_theme_names(&self) -> Result<HashMap<String, String>, ThemeServiceError> {
        Ok(self
            .themes()
            .await?
            .into_iter()
            .map(|theme| (theme.name.to_lowercase(), theme.name))
            .collect())
    }

    async fn validate_one_suggestion(
        &self,
        mut suggestion: RawThemeSuggestion,
        known_themes: &HashMap<String, String>,
        allowed_symbols: Option<&HashSet<TickerSymbol>>,
        seen: &mut HashSet<TickerSymbol>,
    ) -> Result<ThemeSuggestion, (Option<String>, String)> {
        let raw_symbol = suggestion.symbol.trim().to_uppercase();
        let error_symbol = (!raw_symbol.is_empty()).then(|| raw_symbol.clone());
        let symbol = normalize_symbol(&raw_symbol)
            .map_err(|error| (error_symbol.clone(), error.to_string()))?;
        if allowed_symbols.is_some_and(|allowed| !allowed.contains(&symbol)) {
            return Err((error_symbol, format!("{symbol} is not part of this AI job")));
        }
        if !seen.insert(symbol.clone()) {
            return Err((error_symbol, format!("duplicate suggestion for {symbol}")));
        }
        if let Err(error) = self.ensure_ticker(&symbol).await {
            return Err((error_symbol, error.to_string()));
        }
        if let Err(error) = validate_count(suggestion.themes.len()) {
            return Err((error_symbol, error.to_string()));
        }
        let mut unique = HashSet::new();
        for theme in &mut suggestion.themes {
            let Some(canonical) = known_themes.get(&theme.trim().to_lowercase()) else {
                return Err((error_symbol, format!("unknown theme {theme}")));
            };
            *theme = canonical.clone();
            if !unique.insert(theme.clone()) {
                return Err((
                    error_symbol,
                    format!("duplicate theme {theme} for {symbol}"),
                ));
            }
        }
        Ok(ThemeSuggestion {
            symbol,
            themes: suggestion.themes,
            reasoning: suggestion.reasoning,
        })
    }

    pub async fn ensure_ticker(&self, symbol: &TickerSymbol) -> Result<(), ThemeServiceError> {
        self.ticker_catalog
            .ensure_ticker_symbol(symbol)
            .await
            .map_err(ThemeServiceError::TickerCatalog)
    }
}

fn normalize_theme(
    name: &str,
    etf_symbol: &TickerSymbol,
    description: Option<&str>,
) -> Result<(String, TickerSymbol, Option<String>), ThemeServiceError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ThemeServiceError::Validation(
            "theme name is required".into(),
        ));
    }
    Ok((
        name.to_owned(),
        etf_symbol.clone(),
        description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    ))
}

fn normalize_symbol(symbol: &str) -> Result<TickerSymbol, ThemeServiceError> {
    TickerSymbol::parse(symbol)
        .map_err(|_| ThemeServiceError::Validation(format!("invalid ticker symbol {symbol}")))
}

fn typed_suggestions(
    suggestions: Vec<RawThemeSuggestion>,
) -> Result<Vec<ThemeSuggestion>, ThemeServiceError> {
    suggestions
        .into_iter()
        .map(|suggestion| {
            Ok(ThemeSuggestion {
                symbol: normalize_symbol(&suggestion.symbol)?,
                themes: suggestion.themes,
                reasoning: suggestion.reasoning,
            })
        })
        .collect()
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
