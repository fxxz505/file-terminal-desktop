pub fn extract_search_terms(question: &str) -> Vec<String> {
    let normalized = question.trim().to_lowercase();
    let mut terms = Vec::new();

    if normalized.contains("游戏") || normalized.contains("玩") {
        terms.extend(["游戏", "game", "steam"].into_iter().map(String::from));
    }

    for word in normalized
        .split(|character: char| !character.is_alphanumeric() && !('\u{4e00}'..='\u{9fff}').contains(&character))
        .filter(|word| word.chars().count() >= 2)
    {
        let candidate = word.to_string();
        if !terms.contains(&candidate) {
            terms.push(candidate);
        }
    }

    if terms.is_empty() && !normalized.is_empty() {
        terms.push(normalized);
    }

    terms.truncate(8);
    terms
}

pub fn matches_terms(haystack: &str, terms: &[String]) -> usize {
    let normalized = haystack.to_lowercase();
    terms
        .iter()
        .filter(|term| normalized.contains(term.as_str()))
        .count()
}

pub fn parse_model_terms(output: &str) -> Vec<String> {
    let candidate = output
        .rsplit_once('[')
        .and_then(|(_, tail)| tail.split_once(']').map(|(inside, _)| inside))
        .unwrap_or(output);
    let mut terms = Vec::new();
    for raw in candidate.split([',', '\n', '，', '、']) {
        let value = raw.trim().trim_matches(['"', '\'', ' ']);
        if value.chars().count() < 2 || value.chars().count() > 48 {
            continue;
        }
        let value = value.to_lowercase();
        if !terms.contains(&value) {
            terms.push(value);
        }
    }
    terms.truncate(6);
    terms
}
