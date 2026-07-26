use crate::models::TickerSymbol;
use crate::store::Store;
use serde::Serialize;
use std::cmp::Ordering;
use std::ops::Range;
use thiserror::Error;

const RESULT_LIMIT: usize = 10;
const MAX_QUERY_LENGTH: usize = 64;

pub struct GlobalSearchService {
    store: Store,
}

#[derive(Debug, Error)]
pub enum GlobalSearchError {
    #[error("search query must contain between 1 and {MAX_QUERY_LENGTH} characters")]
    Validation,
    #[error("global search persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobalSearchResultKind {
    Industry,
    Theme,
    Ticker,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct GlobalSearchResult {
    #[serde(rename = "type")]
    pub kind: GlobalSearchResultKind,
    pub key: String,
    pub label: String,
    pub matches: Vec<[usize; 2]>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct GlobalSearchResults {
    pub groups: Vec<GlobalSearchResult>,
    pub tickers: Vec<GlobalSearchResult>,
}

struct Candidate {
    kind: GlobalSearchResultKind,
    key: String,
    label: String,
}

struct RankedCandidate {
    result: GlobalSearchResult,
    score: usize,
}

#[derive(Default)]
struct Normalized {
    chars: Vec<char>,
    original_indices: Vec<usize>,
    words: Vec<Range<usize>>,
}

struct TokenMatch {
    score: usize,
    positions: Vec<usize>,
}

impl GlobalSearchService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn search(&self, query: &str) -> Result<GlobalSearchResults, GlobalSearchError> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > MAX_QUERY_LENGTH {
            return Err(GlobalSearchError::Validation);
        }

        let (industry_rankings, themes, tickers) = tokio::try_join!(
            self.store.current_industry_rankings(),
            self.store.themes_with_assignments(),
            self.store.known_tickers(),
        )
        .map_err(GlobalSearchError::Persistence)?;

        let mut groups = industry_rankings
            .into_iter()
            .flat_map(|rankings| rankings.rows)
            .map(|industry| Candidate {
                kind: GlobalSearchResultKind::Industry,
                key: industry.key,
                label: industry.name,
            })
            .collect::<Vec<_>>();
        groups.extend(themes.into_iter().map(|theme| Candidate {
            kind: GlobalSearchResultKind::Theme,
            key: theme.id.to_string(),
            label: theme.name,
        }));
        let tickers = tickers
            .into_iter()
            .map(ticker_candidate)
            .collect::<Vec<_>>();

        Ok(GlobalSearchResults {
            groups: ranked_matches(query, groups),
            tickers: ranked_matches(query, tickers),
        })
    }
}

fn ticker_candidate(symbol: TickerSymbol) -> Candidate {
    Candidate {
        kind: GlobalSearchResultKind::Ticker,
        key: symbol.to_string(),
        label: symbol.to_string(),
    }
}

fn ranked_matches(query: &str, candidates: Vec<Candidate>) -> Vec<GlobalSearchResult> {
    let normalized_query = normalize(query);
    let mut ranked = candidates
        .into_iter()
        .filter_map(|candidate| {
            let normalized_label = normalize(&candidate.label);
            let matched = match_label(&normalized_query, &normalized_label)?;
            Some(RankedCandidate {
                result: GlobalSearchResult {
                    kind: candidate.kind,
                    key: candidate.key,
                    label: candidate.label,
                    matches: original_ranges(&normalized_label, matched.positions),
                },
                score: matched.score,
            })
        })
        .collect::<Vec<_>>();
    ranked.sort_by(compare_ranked);
    ranked
        .into_iter()
        .take(RESULT_LIMIT)
        .map(|candidate| candidate.result)
        .collect()
}

fn compare_ranked(left: &RankedCandidate, right: &RankedCandidate) -> Ordering {
    left.score
        .cmp(&right.score)
        .then_with(|| {
            left.result
                .label
                .to_lowercase()
                .cmp(&right.result.label.to_lowercase())
        })
        .then_with(|| left.result.kind_order().cmp(&right.result.kind_order()))
        .then_with(|| left.result.key.cmp(&right.result.key))
}

impl GlobalSearchResult {
    fn kind_order(&self) -> u8 {
        match self.kind {
            GlobalSearchResultKind::Industry => 0,
            GlobalSearchResultKind::Theme => 1,
            GlobalSearchResultKind::Ticker => 2,
        }
    }
}

fn normalize(value: &str) -> Normalized {
    let mut normalized = Normalized::default();
    let mut in_word = false;
    let mut word_start = 0;
    for (original_index, value_char) in value.chars().enumerate() {
        if value_char.is_alphanumeric() {
            if !in_word {
                if !normalized.chars.is_empty() {
                    normalized.chars.push(' ');
                    normalized.original_indices.push(original_index);
                }
                word_start = normalized.chars.len();
                in_word = true;
            }
            for lowered in value_char.to_lowercase() {
                normalized.chars.push(lowered);
                normalized.original_indices.push(original_index);
            }
        } else if in_word {
            normalized.words.push(word_start..normalized.chars.len());
            in_word = false;
        }
    }
    if in_word {
        normalized.words.push(word_start..normalized.chars.len());
    }
    normalized
}

fn match_label(query: &Normalized, label: &Normalized) -> Option<TokenMatch> {
    if query.chars.is_empty() || label.chars.is_empty() {
        return None;
    }
    if query.chars == label.chars {
        return Some(TokenMatch {
            score: 0,
            positions: non_space_positions(0, &query.chars),
        });
    }
    if label.chars.starts_with(&query.chars) {
        return Some(TokenMatch {
            score: 10 + label.chars.len().saturating_sub(query.chars.len()),
            positions: non_space_positions(0, &query.chars),
        });
    }
    if let Some(start) = find_subslice(&label.chars, &query.chars) {
        return Some(TokenMatch {
            score: 30 + start,
            positions: non_space_positions(start, &query.chars),
        });
    }

    let mut score = 100;
    let mut positions = Vec::new();
    for query_word in &query.words {
        let matched = best_token_match(&query.chars[query_word.clone()], label)?;
        score += matched.score;
        positions.extend(matched.positions);
    }
    Some(TokenMatch { score, positions })
}

fn best_token_match(query: &[char], label: &Normalized) -> Option<TokenMatch> {
    let mut best: Option<TokenMatch> = None;
    for word_range in &label.words {
        let word = &label.chars[word_range.clone()];
        let candidate = if query == word {
            Some(TokenMatch {
                score: 0,
                positions: (word_range.start..word_range.end).collect(),
            })
        } else if word.starts_with(query) {
            Some(TokenMatch {
                score: 10 + word.len().saturating_sub(query.len()),
                positions: (word_range.start..word_range.start + query.len()).collect(),
            })
        } else if let Some(start) = find_subslice(word, query) {
            Some(TokenMatch {
                score: 30 + start,
                positions: (word_range.start + start..word_range.start + start + query.len())
                    .collect(),
            })
        } else {
            fuzzy_word_match(query, word, word_range.start)
        };
        if candidate.as_ref().is_some_and(|candidate| {
            best.as_ref()
                .is_none_or(|best| candidate.score < best.score)
        }) {
            best = candidate;
        }
    }
    best
}

fn fuzzy_word_match(query: &[char], word: &[char], offset: usize) -> Option<TokenMatch> {
    let max_edits = match query.len() {
        0..=2 => 0,
        3..=5 => 1,
        _ => 2,
    };
    let mut best: Option<TokenMatch> = None;
    if max_edits > 0 {
        let minimum = query.len().saturating_sub(max_edits).max(1);
        let maximum = (query.len() + max_edits).min(word.len());
        for length in minimum..=maximum {
            let (distance, positions) = edit_alignment(query, &word[..length]);
            if distance <= max_edits {
                let candidate = TokenMatch {
                    score: 70 + distance * 20 + length.abs_diff(query.len()),
                    positions: positions
                        .into_iter()
                        .map(|position| offset + position)
                        .collect(),
                };
                if best
                    .as_ref()
                    .is_none_or(|best| candidate.score < best.score)
                {
                    best = Some(candidate);
                }
            }
        }
    }
    if query.len() >= 3
        && let Some(positions) = subsequence_positions(query, word)
    {
        let gaps = positions.last().copied().unwrap_or(0) + 1 - positions.len();
        let candidate = TokenMatch {
            score: 110 + gaps,
            positions: positions
                .into_iter()
                .map(|position| offset + position)
                .collect(),
        };
        if best
            .as_ref()
            .is_none_or(|best| candidate.score < best.score)
        {
            best = Some(candidate);
        }
    }
    best
}

fn edit_alignment(query: &[char], candidate: &[char]) -> (usize, Vec<usize>) {
    let width = candidate.len() + 1;
    let mut distances = vec![0; (query.len() + 1) * width];
    for index in 0..=query.len() {
        distances[index * width] = index;
    }
    for (index, distance) in distances.iter_mut().take(candidate.len() + 1).enumerate() {
        *distance = index;
    }
    for query_index in 1..=query.len() {
        for candidate_index in 1..=candidate.len() {
            let substitution = distances[(query_index - 1) * width + candidate_index - 1]
                + usize::from(query[query_index - 1] != candidate[candidate_index - 1]);
            let deletion = distances[(query_index - 1) * width + candidate_index] + 1;
            let insertion = distances[query_index * width + candidate_index - 1] + 1;
            let mut distance = substitution.min(deletion).min(insertion);
            if query_index > 1
                && candidate_index > 1
                && query[query_index - 1] == candidate[candidate_index - 2]
                && query[query_index - 2] == candidate[candidate_index - 1]
            {
                distance =
                    distance.min(distances[(query_index - 2) * width + candidate_index - 2] + 1);
            }
            distances[query_index * width + candidate_index] = distance;
        }
    }

    let mut query_index = query.len();
    let mut candidate_index = candidate.len();
    let mut positions = Vec::new();
    while query_index > 0 || candidate_index > 0 {
        if query_index > 1
            && candidate_index > 1
            && query[query_index - 1] == candidate[candidate_index - 2]
            && query[query_index - 2] == candidate[candidate_index - 1]
            && distances[query_index * width + candidate_index]
                == distances[(query_index - 2) * width + candidate_index - 2] + 1
        {
            positions.push(candidate_index - 1);
            positions.push(candidate_index - 2);
            query_index -= 2;
            candidate_index -= 2;
        } else if query_index > 0
            && candidate_index > 0
            && query[query_index - 1] == candidate[candidate_index - 1]
            && distances[query_index * width + candidate_index]
                == distances[(query_index - 1) * width + candidate_index - 1]
        {
            positions.push(candidate_index - 1);
            query_index -= 1;
            candidate_index -= 1;
        } else if query_index > 0
            && candidate_index > 0
            && distances[query_index * width + candidate_index]
                == distances[(query_index - 1) * width + candidate_index - 1] + 1
        {
            query_index -= 1;
            candidate_index -= 1;
        } else if query_index > 0
            && distances[query_index * width + candidate_index]
                == distances[(query_index - 1) * width + candidate_index] + 1
        {
            query_index -= 1;
        } else {
            candidate_index -= 1;
        }
    }
    positions.reverse();
    (distances[query.len() * width + candidate.len()], positions)
}

fn subsequence_positions(query: &[char], candidate: &[char]) -> Option<Vec<usize>> {
    let mut positions = Vec::with_capacity(query.len());
    let mut query_index = 0;
    for (candidate_index, candidate_char) in candidate.iter().enumerate() {
        if query.get(query_index) == Some(candidate_char) {
            positions.push(candidate_index);
            query_index += 1;
            if query_index == query.len() {
                return Some(positions);
            }
        }
    }
    None
}

fn find_subslice(haystack: &[char], needle: &[char]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn non_space_positions(offset: usize, value: &[char]) -> Vec<usize> {
    value
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (*value != ' ').then_some(offset + index))
        .collect()
}

fn original_ranges(label: &Normalized, positions: Vec<usize>) -> Vec<[usize; 2]> {
    let mut original = positions
        .into_iter()
        .filter_map(|position| label.original_indices.get(position).copied())
        .collect::<Vec<_>>();
    original.sort_unstable();
    original.dedup();
    let mut ranges: Vec<[usize; 2]> = Vec::new();
    for position in original {
        if let Some(range) = ranges.last_mut()
            && range[1] == position
        {
            range[1] += 1;
        } else {
            ranges.push([position, position + 1]);
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search(query: &str, labels: &[&str]) -> Vec<GlobalSearchResult> {
        ranked_matches(
            query,
            labels
                .iter()
                .enumerate()
                .map(|(index, label)| Candidate {
                    kind: GlobalSearchResultKind::Industry,
                    key: index.to_string(),
                    label: (*label).to_owned(),
                })
                .collect(),
        )
    }

    #[test]
    fn ranks_exact_prefix_and_typo_matches() {
        let results = search("AAPL", &["AAPL", "AAPL Holdings", "APPL"]);
        assert_eq!(
            results
                .iter()
                .map(|result| result.label.as_str())
                .collect::<Vec<_>>(),
            ["AAPL", "AAPL Holdings", "APPL"]
        );
    }

    #[test]
    fn matches_case_insensitively_and_highlights_original_characters() {
        let result = search("semi", &["Semiconductors"]).remove(0);
        assert_eq!(result.matches, [[0, 4]]);
    }

    #[test]
    fn supports_missing_characters_and_multi_word_queries() {
        assert_eq!(
            search("semconductors", &["Semiconductors"])[0].label,
            "Semiconductors"
        );
        assert_eq!(
            search("soft appl", &["Software - Application"])[0].label,
            "Software - Application"
        );
        assert_eq!(search("AALP", &["AAPL"])[0].label, "AAPL");
    }

    #[test]
    fn does_not_apply_typo_matching_to_short_queries() {
        assert!(search("ax", &["AB"]).is_empty());
    }

    #[test]
    fn caps_each_result_collection_at_ten() {
        let labels = (0..20)
            .map(|index| format!("Tech {index}"))
            .collect::<Vec<_>>();
        let borrowed = labels.iter().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(search("tech", &borrowed).len(), RESULT_LIMIT);
    }

    #[test]
    fn maps_lowercase_expansion_back_to_original_character_positions() {
        let result = search("i", &["İndustry"]).remove(0);
        assert_eq!(result.matches, [[0, 1]]);
    }
}
