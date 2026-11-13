//! `rapidfuzz.process`.

/// A scorer: similarity between two strings, 0 to 100, higher is better.
pub type Scorer = fn(&str, &str) -> f64;

/// `process.extractOne(query, choices, scorer=scorer, score_cutoff=score_cutoff)` for a similarity scorer (one
/// where 100 is the optimum). Returns `(choice, score, index)` of the best choice with `score >= score_cutoff`;
/// on equal scores the first choice wins, and the search stops at the first score of 100.
pub fn extract_one<'a, S: AsRef<str>>(
    query: &str,
    choices: &'a [S],
    scorer: Scorer,
    score_cutoff: Option<f64>,
) -> Option<(&'a str, f64, usize)> {
    let mut cutoff = score_cutoff.unwrap_or(0.0);
    let mut result: Option<(&'a str, f64, usize)> = None;
    for (index, choice) in choices.iter().enumerate() {
        let choice = choice.as_ref();
        let score = scorer(query, choice);
        if score >= cutoff && result.is_none_or(|(_, best, _)| score > best) {
            cutoff = score;
            result = Some((choice, score, index));
        }
        if score == 100.0 {
            break;
        }
    }
    result
}
