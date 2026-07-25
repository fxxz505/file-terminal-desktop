pub mod assistant;

#[cfg(test)]
mod tests {
    use crate::assistant::{extract_search_terms, parse_model_terms};

    #[test]
    fn game_intent_expands_to_game_terms() {
        let terms = extract_search_terms("现在想要玩游戏");
        assert!(terms.contains(&"游戏".to_string()));
    }

    #[test]
    fn model_terms_accept_a_small_json_like_list() {
        assert_eq!(parse_model_terms("[\"游戏\", \"steam\"]"), vec!["游戏", "steam"]);
    }
}
