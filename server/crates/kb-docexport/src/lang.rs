//! The language of the exported pages, for the few words an export writes itself (the contents heading) and the
//! HTML `lang`: Vietnamese when the pages are written in it, else English (the board's own language).

use serde_json::Value;

use crate::model::ExportPage;

/// The language of an export's own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Lang {
    /// English: the board's language, and the default.
    #[default]
    En,
    /// Vietnamese.
    Vi,
}

/// The characters read to tell the language: enough for a page or two.
const SAMPLE: usize = 20_000;

/// Whether a letter is one only Vietnamese uses among the languages a board is written in: the letters with a
/// breve, horn or stroke, and the vowels with a tone mark below or a hook (the Latin Extended Additional block).
fn vietnamese_letter(c: char) -> bool {
    matches!(c, 'ă' | 'Ă' | 'đ' | 'Đ' | 'ơ' | 'Ơ' | 'ư' | 'Ư') || ('\u{1EA0}'..='\u{1EF9}').contains(&c)
}

/// Collects the text of a page body into `out`, until it holds [`SAMPLE`] characters.
fn text_of(node: &Value, out: &mut String) {
    if out.len() >= SAMPLE {
        return;
    }
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        out.push_str(text);
        out.push(' ');
    }
    for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        text_of(child, out);
    }
}

impl Lang {
    /// Returns the language the pages are written in: Vietnamese when at least one letter in a hundred of their
    /// titles and text is a Vietnamese one, else English.
    pub(crate) fn of(pages: &[ExportPage]) -> Self {
        let mut text = String::new();
        for page in pages {
            text.push_str(&page.title);
            text.push(' ');
            text_of(&page.doc, &mut text);
        }
        let letters = text.chars().filter(|c| c.is_alphabetic()).count();
        let marked = text.chars().filter(|c| vietnamese_letter(*c)).count();
        if letters > 0 && marked * 100 >= letters { Self::Vi } else { Self::En }
    }

    /// Returns the language's code for the HTML `lang` attribute.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Vi => "vi",
        }
    }

    /// Returns the line above a chapter's title in a book ("Chapter 3").
    pub(crate) fn chapter(self, number: usize) -> String {
        match self {
            Self::En => format!("Chapter {number}"),
            Self::Vi => format!("Chương {number}"),
        }
    }

    /// Returns the heading of a table of contents.
    pub(crate) fn contents(self) -> &'static str {
        match self {
            Self::En => "Contents",
            Self::Vi => "Mục lục",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page(title: &str, text: &str) -> ExportPage {
        ExportPage {
            title: title.into(),
            doc: json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}),
            ..Default::default()
        }
    }

    #[test]
    fn vietnamese_pages_get_vietnamese_words() {
        let vi = [page("Tổng quan", "Nhiều người biết mình cần uống đủ nước nhưng lại quên.")];
        assert_eq!(Lang::of(&vi), Lang::Vi);
        assert_eq!((Lang::Vi.code(), Lang::Vi.contents()), ("vi", "Mục lục"));
        // a French or English page keeps the board's English
        assert_eq!(Lang::of(&[page("Résumé", "Les règles du café sont élégantes.")]), Lang::En);
        assert_eq!(Lang::of(&[page("Overview", "The API is REST.")]), Lang::En);
        assert_eq!(Lang::of(&[]), Lang::En);
    }
}
