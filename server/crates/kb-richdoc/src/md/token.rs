//! The tokens of the Markdown reader: marked's block and inline tokens plus the ones the Docs editor's
//! extensions add (callout, drawings, math, task list, the ordered-list tokenizer, highlight, page and ticket
//! references).

/// A block token. Inline text is kept as source (`text`) and tokenized when the document is built.
#[derive(Debug, Clone)]
pub enum Block {
    /// Blank lines (`raw` holds them).
    Space { raw: String },
    /// A fenced or indented code block; `fenced_at_col0` is false for a fence with leading spaces (the editor
    /// drops those) and `indented` marks an indented block.
    Code { raw: String, text: String, lang: Option<String>, indented: bool, fenced_at_col0: bool },
    /// An ATX or setext heading.
    Heading { raw: String, depth: u8, text: String },
    /// A thematic break.
    Hr { raw: String },
    /// A quote with its blocks.
    Blockquote { raw: String, tokens: Vec<Block> },
    /// A marked list (bullets, or ordered markers the editor's own tokenizer did not take).
    List(List),
    /// The editor's ordered list (`1.`, `a)`, `iv.`…).
    OrderedList(OrderedList),
    /// The editor's task list.
    TaskList { raw: String, items: Vec<TaskItem> },
    /// A block of HTML.
    Html { raw: String },
    /// A link reference definition (writes nothing).
    Def { raw: String },
    /// A GFM table.
    Table { raw: String, align: Vec<Option<&'static str>>, header: Vec<String>, rows: Vec<Vec<String>> },
    /// A paragraph (top level).
    Paragraph { raw: String, text: String },
    /// A paragraph whose inline text the editor's tokenizer reads at once (an ordered-list item): only the first
    /// `defs` link definitions of the page are known to it.
    EarlyParagraph { raw: String, text: String, defs: usize },
    /// A text line inside a tight list item.
    Text { raw: String, text: String },
    /// `> [!KIND]` callout.
    Callout { raw: String, kind: &'static str, tokens: Vec<Block> },
    /// `[Label](diagram:dg_…)`.
    Diagram { raw: String, label: String, id: String },
    /// `![Label](sketch:sk_…)`.
    Sketch { raw: String, label: String, id: String },
    /// `![Label](canvas:cv_…#frag)`.
    Canvas { raw: String, label: String, id: String, fragment: String },
    /// `$$ … $$`.
    Math { raw: String, latex: String },
}

impl Block {
    /// The source text the token was read from.
    pub fn raw(&self) -> &str {
        match self {
            Block::Space { raw }
            | Block::Code { raw, .. }
            | Block::Heading { raw, .. }
            | Block::Hr { raw }
            | Block::Blockquote { raw, .. }
            | Block::TaskList { raw, .. }
            | Block::Html { raw }
            | Block::Def { raw }
            | Block::Table { raw, .. }
            | Block::Paragraph { raw, .. }
            | Block::EarlyParagraph { raw, .. }
            | Block::Text { raw, .. }
            | Block::Callout { raw, .. }
            | Block::Diagram { raw, .. }
            | Block::Sketch { raw, .. }
            | Block::Canvas { raw, .. }
            | Block::Math { raw, .. } => raw,
            Block::List(l) => &l.raw,
            Block::OrderedList(l) => &l.raw,
        }
    }

    /// Mutable access to the source text.
    pub fn raw_mut(&mut self) -> &mut String {
        match self {
            Block::Space { raw }
            | Block::Code { raw, .. }
            | Block::Heading { raw, .. }
            | Block::Hr { raw }
            | Block::Blockquote { raw, .. }
            | Block::TaskList { raw, .. }
            | Block::Html { raw }
            | Block::Def { raw }
            | Block::Table { raw, .. }
            | Block::Paragraph { raw, .. }
            | Block::EarlyParagraph { raw, .. }
            | Block::Text { raw, .. }
            | Block::Callout { raw, .. }
            | Block::Diagram { raw, .. }
            | Block::Sketch { raw, .. }
            | Block::Canvas { raw, .. }
            | Block::Math { raw, .. } => raw,
            Block::List(l) => &mut l.raw,
            Block::OrderedList(l) => &mut l.raw,
        }
    }
}

/// A marked list.
#[derive(Debug, Clone)]
pub struct List {
    /// The source.
    pub raw: String,
    /// Whether the markers are numbers.
    pub ordered: bool,
    /// The first number of an ordered list.
    pub start: f64,
    /// The items.
    pub items: Vec<ListItem>,
}

/// One item of a marked list.
#[derive(Debug, Clone)]
pub struct ListItem {
    /// The item's source lines.
    pub raw: String,
    /// The item's content without the marker.
    pub text: String,
    /// The item's blocks.
    pub tokens: Vec<Block>,
}

/// The editor's ordered list token.
#[derive(Debug, Clone)]
pub struct OrderedList {
    /// The source.
    pub raw: String,
    /// The first number.
    pub start: f64,
    /// `a`, `A`, `i`, `I` for letter and roman markers.
    pub type_marker: Option<String>,
    /// The items: their blocks.
    pub items: Vec<Vec<Block>>,
}

/// One item of the editor's task list.
#[derive(Debug, Clone)]
pub struct TaskItem {
    /// Whether it is ticked.
    pub checked: bool,
    /// The first line's text (inline Markdown).
    pub text: String,
    /// How many link definitions were known when the editor read the text (`usize::MAX`: all).
    pub defs: usize,
    /// Blocks nested under it.
    pub nested: Vec<Block>,
}

/// An inline token: its source and what it is.
#[derive(Debug, Clone)]
pub struct ITok {
    /// The source text.
    pub raw: String,
    /// The token.
    pub kind: Inline,
}

/// The kinds of inline token.
#[derive(Debug, Clone)]
pub enum Inline {
    /// Text (entities decoded when built).
    Text(String),
    /// A backslash escape: the character.
    Escape(String),
    /// Inline HTML.
    Html,
    /// A link.
    Link { href: String, title: Option<String>, tokens: Vec<ITok> },
    /// An image.
    Image { href: String, title: Option<String>, text: String },
    /// `**…**`.
    Strong(Vec<ITok>),
    /// `*…*`.
    Em(Vec<ITok>),
    /// `` `…` ``.
    Codespan(String),
    /// A hard line break.
    Br,
    /// `~~…~~`.
    Del(Vec<ITok>),
    /// `==…==`.
    Highlight(Vec<ITok>),
    /// `[[Page#Section|label]]` (annotated: `{page-id=… target=… target-label=…}` after it).
    DocRef {
        page: String,
        section: Option<String>,
        label: Option<String>,
        page_id: Option<String>,
        target: Option<String>,
        target_label: Option<String>,
    },
    /// An annotated span `[text]{.underline color=teal}`: the marks it adds.
    Span { marks: Vec<serde_json::Value>, tokens: Vec<ITok> },
    /// `KAN-12`.
    TicketRef(String),
    /// `$…$`.
    Math(String),
}
