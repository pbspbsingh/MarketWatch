use crate::app::AppState;
use crate::models::DailyNote;
use crate::services::daily_notes::{DailyNoteSummary, DailyNotesError, RenderedMarkdown};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::error;

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<Value>)>;

#[derive(Deserialize)]
struct ListQuery {
    query: Option<String>,
}

#[derive(Deserialize)]
struct CreateInput {
    date: NaiveDate,
}

#[derive(Deserialize)]
struct UpdateInput {
    markdown: String,
    revision: i64,
}

#[derive(Deserialize)]
struct RenderInput {
    markdown: String,
    query: Option<String>,
}

#[derive(Serialize)]
struct NoteDocument {
    #[serde(flatten)]
    note: DailyNote,
    html: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/daily-notes", get(list).post(create))
        .route("/daily-notes/render", axum::routing::post(render))
        .route("/daily-notes/{date}", get(note).put(update).delete(remove))
}

async fn render(
    State(state): State<AppState>,
    Json(input): Json<RenderInput>,
) -> ApiResult<RenderedMarkdown> {
    state
        .daily_notes
        .render(&input.markdown, input.query.as_deref())
        .map(Json)
        .map_err(api_error)
}

async fn list(
    State(state): State<AppState>,
    Query(input): Query<ListQuery>,
) -> ApiResult<Vec<DailyNoteSummary>> {
    state
        .daily_notes
        .list(input.query.as_deref())
        .await
        .map(Json)
        .map_err(api_error)
}

async fn note(
    State(state): State<AppState>,
    Path(date): Path<NaiveDate>,
) -> ApiResult<NoteDocument> {
    let note = state.daily_notes.get(date).await.map_err(api_error)?;
    note_document(&state, note).map(Json).map_err(api_error)
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<CreateInput>,
) -> Result<(StatusCode, Json<NoteDocument>), (StatusCode, Json<Value>)> {
    let note = state
        .daily_notes
        .create(input.date)
        .await
        .map_err(api_error)?;
    note_document(&state, note)
        .map(|document| (StatusCode::CREATED, Json(document)))
        .map_err(api_error)
}

async fn update(
    State(state): State<AppState>,
    Path(date): Path<NaiveDate>,
    Json(input): Json<UpdateInput>,
) -> ApiResult<NoteDocument> {
    let note = state
        .daily_notes
        .update(date, &input.markdown, input.revision)
        .await
        .map_err(api_error)?;
    note_document(&state, note).map(Json).map_err(api_error)
}

async fn remove(
    State(state): State<AppState>,
    Path(date): Path<NaiveDate>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    state
        .daily_notes
        .delete(date)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(api_error)
}

fn note_document(state: &AppState, note: DailyNote) -> Result<NoteDocument, DailyNotesError> {
    let html = state.daily_notes.render(&note.markdown, None)?.html;
    Ok(NoteDocument { note, html })
}

fn api_error(error_value: DailyNotesError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        DailyNotesError::Validation(_) => StatusCode::BAD_REQUEST,
        DailyNotesError::NotFound(_) => StatusCode::NOT_FOUND,
        DailyNotesError::Conflict { .. } => StatusCode::CONFLICT,
        DailyNotesError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
        DailyNotesError::Rendering(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    if status.is_server_error() {
        error!(error = %error_value, "daily notes request failed");
    }
    let body = match &error_value {
        DailyNotesError::Conflict {
            current_revision, ..
        } => json!({
            "error": error_value.to_string(),
            "current_revision": current_revision,
        }),
        _ => json!({"error": error_value.to_string()}),
    };
    (status, Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_service_errors_to_http_statuses() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 3).unwrap();
        assert_eq!(
            api_error(DailyNotesError::Validation("invalid".to_owned())).0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            api_error(DailyNotesError::NotFound(date)).0,
            StatusCode::NOT_FOUND
        );
        let conflict = api_error(DailyNotesError::Conflict {
            date,
            current_revision: 2,
        });
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(conflict.1.0["current_revision"], 2);
    }
}
