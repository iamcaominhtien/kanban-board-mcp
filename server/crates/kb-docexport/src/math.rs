//! LaTeX math as MathML, which browsers (and so the PDF printer) typeset themselves: an export shows the equation,
//! not its source.

use pulldown_latex::config::DisplayMode;
use pulldown_latex::{Parser, RenderConfig, Storage, push_mathml};

/// STIX Two Math (SIL Open Font License, `assets/fonts/STIXTwoMath-OFL.txt`): an OpenType math font, so that an
/// equation is typeset the same on any machine, a phone or a server without math fonts included.
const FONT: &[u8] = include_bytes!("../assets/fonts/STIXTwoMath-Regular.woff2");

/// Returns the CSS that loads the math font from the file itself and sets equations in it.
pub(crate) fn font_css() -> String {
    use base64::Engine as _;
    format!(
        "@font-face {{ font-family: \"STIX Two Math\"; src: url(data:font/woff2;base64,{}) format(\"woff2\"); }}\n",
        base64::engine::general_purpose::STANDARD.encode(FONT)
    )
}

/// Returns a page that shows one equation typeset on white (with the math font), for a browser to draw as the
/// picture Word gets; `None` for an empty one.
pub fn equation_page(latex: &str) -> Option<String> {
    let math = mathml(latex, MathLayout::Block)?;
    // a numbered equation keeps its number at the right edge, as in the text
    let tag = split_tag(latex)
        .1
        .map(|t| {
            format!("<span style=\"position:absolute;right:16px;top:50%;transform:translateY(-50%)\">({t})</span>")
        })
        .unwrap_or_default();
    Some(format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>{}body {{ margin: 0; background: #fff; text-align: center; \
         position: relative; }} div {{ display: inline-block; padding: 6px 10px; font-size: 26px; }} span {{ font-size: 22px; }} \
         math {{ font-family: \"STIX Two Math\", math; }}</style></head><body><div>{math}</div>{tag}</body></html>",
        font_css()
    ))
}

/// Returns an equation as plain text, for where neither MathML nor a picture fits (inline math in Word): its
/// symbols in order (`\\mu_t` gives `μt`), or the LaTeX when it cannot be read.
pub(crate) fn equation_text(latex: &str) -> String {
    let Some(math) = mathml(latex, MathLayout::Inline) else { return latex.to_string() };
    // the text between the tags, without the annotation that repeats the source
    let body = math.split("<annotation").next().unwrap_or(&math);
    let mut out = String::new();
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let text = out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
    if text.trim().is_empty() { latex.to_string() } else { text }
}

/// How an equation sits in the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MathLayout {
    /// Inside a sentence (`$x^2$`).
    Inline,
    /// On its own line, centred (`$$…$$`, a math block).
    Block,
}

/// Returns the MathML of a LaTeX equation, with the source kept as its annotation; `None` for an empty one or when
/// it cannot be written (a command the renderer does not know is drawn in red inside the equation, not refused).
pub(crate) fn mathml(latex: &str, layout: MathLayout) -> Option<String> {
    if latex.trim().is_empty() {
        return None;
    }
    let (latex, _) = split_tag(latex);
    let latex = latex.as_str();
    let storage = Storage::new();
    let parser = Parser::new(latex, &storage);
    let config = RenderConfig {
        display_mode: match layout {
            MathLayout::Inline => DisplayMode::Inline,
            MathLayout::Block => DisplayMode::Block,
        },
        annotation: Some(latex),
        ..RenderConfig::default()
    };
    let mut out = String::new();
    push_mathml(&mut out, parser, config).ok()?;
    // the renderer escapes the entity it writes for `\ ` (a hard space) once too often
    Some(out.replace("&amp;nbsp;", "&#160;"))
}

/// Splits an equation's number from it: `\tag{3}` (or `\tag*{3}`) gives `Some("3")`; `\label{…}`, `\notag` and
/// `\nonumber`, which only matter to LaTeX's own numbering, are dropped. The renderer knows none of them.
pub(crate) fn split_tag(latex: &str) -> (String, Option<String>) {
    let mut rest = latex.to_string();
    let mut tag = None;
    for command in [r"\tag*{", r"\tag{", r"\label{"] {
        while let Some(start) = rest.find(command) {
            let open = start + command.len();
            let Some(len) = rest[open..].find('}') else { break };
            if command != r"\label{" {
                tag = Some(rest[open..open + len].trim().to_string());
            }
            rest.replace_range(start..open + len + 1, "");
        }
    }
    for word in [r"\nonumber", r"\notag"] {
        rest = rest.replace(word, "");
    }
    (rest, tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_equation_becomes_mathml() {
        let block = mathml(r"\mu = \frac{\ln W_t - \ln W_0}{t}", MathLayout::Block).expect("mathml");
        assert!(
            block.starts_with("<math") && block.contains("display=\"block\"") && block.contains("<mfrac>"),
            "{block}"
        );
        let inline = mathml("x^2", MathLayout::Inline).expect("mathml");
        assert!(inline.contains("<msup>") && !inline.contains("display=\"block\""), "{inline}");
        assert_eq!(mathml("  ", MathLayout::Inline), None);
        let text = equation_text(r"\mu_t");
        // the renderer writes mu as the micro sign
        assert_eq!(text, "µt");
        // a hard space is a space, not the text "&nbsp;"
        let spaced = mathml(r"a\ b", MathLayout::Inline).expect("mathml");
        assert!(spaced.contains("<mtext>&#160;</mtext>") && !spaced.contains("&amp;nbsp;"), "{spaced}");
        // a numbered equation: the number apart, the equation without it
        assert_eq!(split_tag(r"x = 1 \tag{2} \label{eq:x}"), ("x = 1  ".to_string(), Some("2".to_string())));
        assert_eq!(split_tag(r"y \notag"), ("y ".to_string(), None));
        assert!(!mathml(r"x = 1 \tag{2}", MathLayout::Block).expect("mathml").contains("merror"));
    }
}
