//! `xml.etree.ElementTree` as `defusedxml.ElementTree.fromstring(text, forbid_dtd=True)` and `ET.tostring(...,
//! encoding="unicode")` use it: a small expat-style reader and the ElementTree serializer.
//!
//! The reader is written by hand instead of on top of a general XML crate, because the server's answers carry
//! expat's own messages and positions (`mismatched tag: line 1, column 8`) and because ElementTree's tree shape
//! (`.text` and `.tail`, `{uri}local` names, attributes in document order, namespace declarations dropped from the
//! attributes) is what the code above it reads. A DOCTYPE is refused where `defusedxml` refuses it, and no entity
//! other than the five predefined ones and numeric references is ever resolved.
//!
//! Positions follow expat: the line counts `\n`, `\r\n` and `\r` once each, the column counts characters; each error
//! is placed where expat places it (the offending character, the start of the token, the start tag for namespace
//! errors). The known difference: a few exotic malformed prologs (a bad XML declaration, a misspelled `<!DOCTYPE`)
//! may be placed one token off.

use std::fmt;

use kb_base::pytext;

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";

/// One element: `tag` is `local` or `{uri}local`, as ElementTree names it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Element {
    /// `{uri}local` or `local`.
    pub tag: String,
    /// Attributes in document order, `xmlns` declarations left out; names are `{uri}local` or `local`.
    pub attrib: Vec<(String, String)>,
    /// The text before the first child (`None` when there is none).
    pub text: Option<String>,
    /// The text after the end tag, up to the next tag of the parent (`None` when there is none).
    pub tail: Option<String>,
    /// The child elements.
    pub children: Vec<Element>,
}

impl Element {
    /// A new element with a tag only (`ET.Element(tag)`).
    pub fn new(tag: &str) -> Self {
        Element { tag: tag.to_string(), ..Default::default() }
    }

    /// `ET.Element(tag, attrib)`.
    pub fn with_attrib(tag: &str, attrib: &[(&str, &str)]) -> Self {
        Element {
            tag: tag.to_string(),
            attrib: attrib.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    /// `el.get(name)`.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.attrib.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// The part of the tag after the last `}` (`_local` of the Python modules).
    pub fn local(&self) -> &str {
        local(&self.tag)
    }

    /// `el.iter()`: this element and every descendant, in document order.
    pub fn iter(&self) -> Vec<&Element> {
        let mut out = Vec::new();
        let mut stack = vec![self];
        while let Some(el) = stack.pop() {
            out.push(el);
            for child in el.children.iter().rev() {
                stack.push(child);
            }
        }
        out
    }
}

/// `tag.rsplit("}", 1)[-1]`.
pub fn local(tag: &str) -> &str {
    tag.rsplit_once('}').map_or(tag, |(_, l)| l)
}

/// What a read can fail with: expat's `ParseError`, or a `defusedxml` refusal. The text is `str(e)` of Python's
/// exception.
#[derive(Debug, Clone, PartialEq)]
pub enum XmlError {
    /// `ET.ParseError`: `message: line L, column C`.
    Parse(String),
    /// `DTDForbidden`.
    DtdForbidden {
        /// The doctype's name.
        name: String,
        /// The system identifier.
        sysid: Option<String>,
        /// The public identifier.
        pubid: Option<String>,
    },
}

impl fmt::Display for XmlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            XmlError::Parse(text) => f.write_str(text),
            XmlError::DtdForbidden { name, sysid, pubid } => {
                let repr = |v: &Option<String>| v.as_deref().map_or("None".to_string(), pytext::repr);
                write!(f, "DTDForbidden(name='{name}', system_id={}, public_id={})", repr(sysid), repr(pubid))
            }
        }
    }
}

impl std::error::Error for XmlError {}

// --- reading -----------------------------------------------------------------------------------------------------

/// `SafeET.fromstring(text, forbid_dtd=True)`.
pub fn fromstring(text: &str) -> Result<Element, XmlError> {
    Reader::new(text).read()
}

fn is_xml_char(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}

fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

fn is_name_start(c: char) -> bool {
    c == '_' || c.is_ascii_alphabetic() || (!c.is_ascii() && c.is_alphabetic())
}

fn is_name_char(c: char) -> bool {
    is_name_start(c)
        || c.is_ascii_digit()
        || c == '-'
        || c == '.'
        || c == '\u{b7}'
        || (!c.is_ascii() && (c.is_alphanumeric() || ('\u{300}'..='\u{36f}').contains(&c)))
}

struct Frame {
    el: Element,
    raw: String,
    ns_mark: usize,
}

struct Reader {
    s: Vec<char>,
    i: usize,
    stack: Vec<Frame>,
    root: Option<Element>,
    bindings: Vec<(String, String)>,
    /// Text read since the last tag.
    data: String,
    /// Whether the last tree event was an end tag (the text is then a tail).
    after_end: bool,
    /// Where the start tag being read begins.
    tag_start: usize,
}

type Res<T> = Result<T, XmlError>;

impl Reader {
    fn new(text: &str) -> Self {
        let mut s: Vec<char> = text.chars().collect();
        // pyexpat hands over UTF-8: a byte order mark is skipped by expat
        if s.first() == Some(&'\u{feff}') {
            s.remove(0);
        }
        Reader { s, i: 0, stack: Vec::new(), root: None, bindings: Vec::new(), data: String::new(), after_end: false, tag_start: 0 }
    }

    fn at(&self, i: usize) -> Option<char> {
        self.s.get(i).copied()
    }

    fn peek(&self) -> Option<char> {
        self.at(self.i)
    }

    fn starts_with(&self, i: usize, text: &str) -> bool {
        text.chars().enumerate().all(|(k, c)| self.at(i + k) == Some(c))
    }

    /// The line and column expat reports for the character offset `pos`.
    fn position(&self, pos: usize) -> (usize, usize) {
        let (mut line, mut col, mut k) = (1, 0, 0);
        let pos = pos.min(self.s.len());
        while k < pos {
            match self.s[k] {
                '\n' => {
                    line += 1;
                    col = 0;
                }
                '\r' => {
                    line += 1;
                    col = 0;
                    if self.at(k + 1) == Some('\n') && k + 1 < pos {
                        k += 1;
                    }
                }
                _ => col += 1,
            }
            k += 1;
        }
        (line, col)
    }

    fn fail<T>(&self, message: &str, pos: usize) -> Res<T> {
        let (line, col) = self.position(pos);
        Err(XmlError::Parse(format!("{message}: line {line}, column {col}")))
    }

    fn invalid<T>(&self, pos: usize) -> Res<T> {
        self.fail("not well-formed (invalid token)", pos)
    }

    fn read(mut self) -> Res<Element> {
        self.prolog()?;
        loop {
            // content of the open elements
            self.content()?;
            if self.stack.is_empty() {
                break;
            }
            // the input ended inside an element
            return self.fail("no element found", self.s.len());
        }
        self.epilog()?;
        match self.root.take() {
            Some(root) => Ok(root),
            None => self.fail("no element found", self.s.len()),
        }
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(is_space) {
            self.i += 1;
        }
    }

    // prolog: the XML declaration, comments, processing instructions, a DOCTYPE (refused) and the root's start tag
    fn prolog(&mut self) -> Res<()> {
        if self.starts_with(0, "<?xml") && self.at(5).is_some_and(|c| is_space(c) || c == '?') {
            self.xml_decl()?;
        }
        loop {
            self.skip_space();
            let Some(c) = self.peek() else {
                return self.fail("no element found", self.s.len());
            };
            if c != '<' {
                // a name (or number, or quote...) is a syntax error; a character that cannot start anything is invalid
                return if c == '&' || c == '?' || c == '!' || (!is_xml_char(c) && self.i != 0) {
                    self.invalid(self.i)
                } else if c == ':' || !is_xml_char(c) {
                    self.invalid(self.i + 1)
                } else if c == '\'' || c == '"' {
                    // a quoted literal is one token; what follows it is what fails
                    match self.s[self.i + 1..].iter().position(|x| *x == c) {
                        Some(n) => self.invalid(self.i + 1 + n + 1),
                        None => self.fail("unclosed token", self.i),
                    }
                } else {
                    self.fail("syntax error", self.i)
                };
            }
            let start = self.i;
            match self.at(start + 1) {
                None => return self.fail("unclosed token", start),
                Some('?') => self.pi(start)?,
                Some('!') => {
                    if self.starts_with(start, "<!--") {
                        self.comment(start)?;
                    } else if self.starts_with(start, "<!DOCTYPE") {
                        return self.doctype(start);
                    } else {
                        return self.bad_declaration(start);
                    }
                }
                Some(ch) if is_name_start(ch) => {
                    self.start_tag()?;
                    return Ok(());
                }
                Some(_) => return self.invalid(start + 1),
            }
        }
    }

    /// `<!x` outside an element: expat's declaration scanner stops after the keyword.
    fn bad_declaration(&self, start: usize) -> Res<()> {
        let mut k = start + 2;
        if self.at(k) == Some('-') {
            return match self.at(k + 1) {
                None => self.fail("unclosed token", start),
                Some(_) => self.invalid(k + 1),
            };
        }
        match self.at(k) {
            None => return self.fail("unclosed token", start),
            Some(ch) if is_name_start(ch) => k += 1,
            Some(_) => return self.invalid(k),
        }
        while self.at(k).is_some_and(is_name_char) {
            k += 1;
        }
        match self.at(k) {
            None => self.fail("unclosed token", start),
            Some(c) if is_space(c) || c == '%' => self.fail("syntax error", start),
            Some(_) => self.invalid(k),
        }
    }

    fn xml_decl(&mut self) -> Res<()> {
        // the declaration is a processing instruction token first: unclosed or with a bad character it fails as one
        let mut end = 5;
        loop {
            match self.at(end) {
                None => return self.fail("unclosed token", 0),
                Some('?') if self.at(end + 1) == Some('>') => break,
                Some(c) if !is_xml_char(c) => return self.invalid(end),
                Some(_) => end += 1,
            }
        }
        let bad = |pos: usize| -> Res<()> { self.fail("XML declaration not well-formed", pos) };
        let mut k = 5;
        let mut seen_version = false;
        let mut expect: Vec<&str> = vec!["version"];
        loop {
            let had_space = k < end && is_space(self.s[k]);
            while k < end && is_space(self.s[k]) {
                k += 1;
            }
            if k >= end {
                if !seen_version {
                    return bad(k);
                }
                self.i = end + 2;
                return Ok(());
            }
            if !had_space {
                return bad(k);
            }
            let name_at = k;
            let mut name = String::new();
            while k < end && self.s[k].is_ascii_alphabetic() {
                name.push(self.s[k]);
                k += 1;
            }
            if !expect.contains(&name.as_str()) {
                return bad(name_at);
            }
            while k < end && is_space(self.s[k]) {
                k += 1;
            }
            if k >= end || self.s[k] != '=' {
                return bad(k);
            }
            k += 1;
            while k < end && is_space(self.s[k]) {
                k += 1;
            }
            if k >= end || !matches!(self.s[k], '\'' | '"') {
                return bad(k);
            }
            let quote = self.s[k];
            k += 1;
            let value_at = k;
            let mut value = String::new();
            loop {
                if k >= end {
                    return bad(k);
                }
                let c = self.s[k];
                if c == quote {
                    break;
                }
                let ok = match name.as_str() {
                    "version" => c.is_ascii_digit() || c == '.',
                    "encoding" => c.is_ascii_alphabetic() || (k > value_at && (c.is_ascii_digit() || "._-".contains(c))),
                    _ => c.is_ascii_alphabetic(),
                };
                if !ok {
                    return bad(k);
                }
                value.push(c);
                k += 1;
            }
            if name == "encoding" && value.is_empty() {
                return bad(k);
            }
            if name == "standalone" && value != "yes" && value != "no" {
                return bad(value_at);
            }
            k += 1;
            expect = match name.as_str() {
                "version" => {
                    seen_version = true;
                    vec!["encoding", "standalone"]
                }
                "encoding" => vec!["standalone"],
                _ => vec![],
            };
        }
    }

    fn doctype(&mut self, start: usize) -> Res<()> {
        let mut k = start + "<!DOCTYPE".len();
        if self.at(k).is_none() {
            return self.fail("unclosed token", start);
        }
        if !self.at(k).is_some_and(is_space) {
            return self.fail("syntax error", start);
        }
        while self.at(k).is_some_and(is_space) {
            k += 1;
        }
        let mut name = String::new();
        match self.at(k) {
            Some(c) if is_name_start(c) || c == ':' => {}
            None => return self.fail("unclosed token", start),
            Some(_) => return self.fail("syntax error", k),
        }
        while let Some(c) = self.at(k).filter(|c| is_name_char(*c) || *c == ':') {
            name.push(c);
            k += 1;
        }
        let (mut sysid, mut pubid) = (None, None);
        let literal = |s: &Reader, k: &mut usize| -> Res<String> {
            while s.at(*k).is_some_and(is_space) {
                *k += 1;
            }
            let Some(q) = s.at(*k).filter(|c| *c == '\'' || *c == '"') else {
                return if s.at(*k).is_none() { s.fail("no element found", s.s.len()) } else { s.fail("syntax error", *k) };
            };
            *k += 1;
            let mut out = String::new();
            loop {
                match s.at(*k) {
                    None => return s.fail("unclosed token", start),
                    Some(c) if c == q => break,
                    Some(c) => out.push(c),
                }
                *k += 1;
            }
            *k += 1;
            Ok(out)
        };
        let mut j = k;
        while self.at(j).is_some_and(is_space) {
            j += 1;
        }
        if self.starts_with(j, "SYSTEM") {
            j += 6;
            sysid = Some(literal(self, &mut j)?);
        } else if self.starts_with(j, "PUBLIC") {
            j += 6;
            pubid = Some(literal(self, &mut j)?);
            sysid = Some(literal(self, &mut j)?);
        }
        while self.at(j).is_some_and(is_space) {
            j += 1;
        }
        match self.at(j) {
            Some('[') | Some('>') => Err(XmlError::DtdForbidden { name, sysid, pubid }),
            None => self.fail("no element found", self.s.len()),
            Some(_) => self.fail("syntax error", j),
        }
    }

    fn comment(&mut self, start: usize) -> Res<()> {
        let mut k = start + 4;
        loop {
            match self.at(k) {
                None => return self.fail("unclosed token", start),
                Some('-') if self.at(k + 1) == Some('-') => {
                    return match self.at(k + 2) {
                        Some('>') => {
                            self.i = k + 3;
                            Ok(())
                        }
                        None => self.fail("unclosed token", start),
                        Some(_) => self.invalid(k + 2),
                    };
                }
                Some(c) if !is_xml_char(c) => return self.invalid(k),
                Some(_) => k += 1,
            }
        }
    }

    fn name_at(&self, k: &mut usize) -> Option<String> {
        let mut out = String::new();
        if !self.at(*k).is_some_and(|c| is_name_start(c) || c == ':') {
            return None;
        }
        while let Some(c) = self.at(*k).filter(|c| is_name_char(*c) || *c == ':') {
            out.push(c);
            *k += 1;
        }
        Some(out)
    }

    fn pi(&mut self, start: usize) -> Res<()> {
        let mut k = start + 2;
        if self.at(k).is_none() {
            return self.fail("unclosed token", start);
        }
        // the target is a name without colons
        if !self.at(k).is_some_and(is_name_start) {
            return self.invalid(k);
        }
        let target_start = k;
        while self.at(k).is_some_and(is_name_char) {
            k += 1;
        }
        let target: String = self.s[target_start..k].iter().collect();
        let ends_here = match self.at(k) {
            None => return self.fail("unclosed token", start),
            Some(c) if is_space(c) => true,
            Some('?') if self.at(k + 1) == Some('>') => true,
            Some(_) => false,
        };
        if !ends_here {
            return self.invalid(k);
        }
        if target == "xml" {
            return self.fail("XML or text declaration not at start of entity", start);
        }
        if target.eq_ignore_ascii_case("xml") {
            return self.invalid(k);
        }
        loop {
            match self.at(k) {
                None => return self.fail("unclosed token", start),
                Some('?') if self.at(k + 1) == Some('>') => {
                    self.i = k + 2;
                    return Ok(());
                }
                Some(c) if !is_xml_char(c) => return self.invalid(k),
                Some(_) => k += 1,
            }
        }
    }

    fn epilog(&mut self) -> Res<()> {
        loop {
            self.skip_space();
            let Some(c) = self.peek() else { return Ok(()) };
            if c == '<' {
                let start = self.i;
                if self.starts_with(start, "<!--") {
                    self.comment(start)?;
                    continue;
                }
                if self.at(start + 1) == Some('?') {
                    self.pi(start)?;
                    continue;
                }
                if self.at(start + 1).is_none() {
                    return self.fail("unclosed token", start);
                }
                if self.at(start + 1) == Some('!') {
                    return self.bad_declaration(start);
                }
                if !self.at(start + 1).is_some_and(|c| is_name_start(c) || c == '/') {
                    return self.invalid(start + 1);
                }
            }
            if c == '&' || !is_xml_char(c) {
                return self.invalid(self.i);
            }
            return self.fail("junk after document element", self.i);
        }
    }

    fn flush(&mut self) {
        if self.data.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.data);
        if self.after_end {
            if let Some(last) = self.stack.last_mut().and_then(|f| f.el.children.last_mut()) {
                last.tail = Some(text);
            }
        } else if let Some(top) = self.stack.last_mut() {
            top.el.text = Some(text);
        }
    }

    /// Everything inside the open elements: reads until the root element is closed or the input ends.
    fn content(&mut self) -> Res<()> {
        // the root's start tag was consumed by the prolog
        while !self.stack.is_empty() {
            let Some(c) = self.peek() else {
                return Ok(());
            };
            match c {
                '<' => self.markup()?,
                '&' => self.reference(false).map(|text| self.data.push_str(&text))?,
                ']' if self.starts_with(self.i, "]]>") => return self.invalid(self.i + 2),
                '\r' => {
                    self.data.push('\n');
                    self.i += 1;
                    if self.peek() == Some('\n') {
                        self.i += 1;
                    }
                }
                c if !is_xml_char(c) => return self.invalid(self.i),
                c => {
                    self.data.push(c);
                    self.i += 1;
                }
            }
        }
        Ok(())
    }

    fn markup(&mut self) -> Res<()> {
        let start = self.i;
        match self.at(start + 1) {
            None => self.fail("unclosed token", start),
            Some('/') => self.end_tag(start),
            Some('!') => {
                if self.starts_with(start, "<!--") {
                    return self.comment(start);
                }
                if self.at(start + 2) == Some('[') {
                    return self.cdata(start);
                }
                if self.at(start + 2) == Some('-') {
                    return match self.at(start + 3) {
                        None => self.fail("unclosed token", start),
                        Some(_) => self.invalid(start + 3),
                    };
                }
                match self.at(start + 2) {
                    None => self.fail("unclosed token", start),
                    Some(_) => self.invalid(start + 2),
                }
            }
            Some('?') => self.pi(start),
            Some(c) if is_name_start(c) => self.start_tag(),
            Some(_) => self.invalid(start + 1),
        }
    }

    fn cdata(&mut self, start: usize) -> Res<()> {
        let head = "<![CDATA[";
        for (k, c) in head.chars().enumerate() {
            match self.at(start + k) {
                None => return self.fail("unclosed token", start),
                Some(x) if x == c => {}
                Some(_) => return self.invalid(start + k),
            }
        }
        let mut k = start + head.len();
        loop {
            match self.at(k) {
                None => {
                    // a trailing `]` or `]]` is a token of its own that is cut off
                    let trailing = self.s[start..].iter().rev().take_while(|c| **c == ']').count().min(2);
                    return self.fail("unclosed CDATA section", self.s.len() - trailing);
                }
                Some(']') if self.starts_with(k, "]]>") => {
                    self.i = k + 3;
                    return Ok(());
                }
                Some('\r') => {
                    self.data.push('\n');
                    if self.at(k + 1) == Some('\n') {
                        k += 1;
                    }
                }
                Some(c) if !is_xml_char(c) => return self.invalid(k),
                Some(c) => self.data.push(c),
            }
            k += 1;
        }
    }

    /// `&...;` at the cursor: the text it stands for.
    fn reference(&mut self, in_attribute: bool) -> Res<String> {
        let start = self.i;
        let unclosed = if in_attribute { self.tag_start } else { start };
        let mut k = start + 1;
        match self.at(k) {
            None => return self.fail("unclosed token", unclosed),
            Some('#') => {
                k += 1;
                let hex = matches!(self.at(k), Some('x'));
                if hex {
                    k += 1;
                }
                let digits_at = k;
                let mut value: u32 = 0;
                let mut overflow = false;
                while let Some(d) = self.at(k).and_then(|c| c.to_digit(if hex { 16 } else { 10 })) {
                    match value.checked_mul(if hex { 16 } else { 10 }).and_then(|v| v.checked_add(d)) {
                        Some(v) if v <= 0x10ffff => value = v,
                        _ => overflow = true,
                    }
                    k += 1;
                }
                if k == digits_at {
                    return match self.at(k) {
                        None => self.fail("unclosed token", unclosed),
                        Some(_) => self.invalid(k),
                    };
                }
                match self.at(k) {
                    None => return self.fail("unclosed token", unclosed),
                    Some(';') => {}
                    Some(_) => return self.invalid(k),
                }
                self.i = k + 1;
                let ch = if overflow { None } else { char::from_u32(value).filter(|c| is_xml_char(*c)) };
                match ch {
                    Some(c) => Ok(c.to_string()),
                    None => self.fail("reference to invalid character number", start),
                }
            }
            Some(c) if is_name_start(c) => {
                let mut name = String::new();
                while let Some(c) = self.at(k).filter(|c| is_name_char(*c) || *c == ':') {
                    name.push(c);
                    k += 1;
                }
                match self.at(k) {
                    None => return self.fail("unclosed token", unclosed),
                    Some(';') => {}
                    Some(_) => return self.invalid(k),
                }
                self.i = k + 1;
                match name.as_str() {
                    "amp" => Ok("&".into()),
                    "lt" => Ok("<".into()),
                    "gt" => Ok(">".into()),
                    "quot" => Ok("\"".into()),
                    "apos" => Ok("'".into()),
                    _ => self.fail("undefined entity", start),
                }
            }
            Some(_) => self.invalid(k),
        }
    }

    fn end_tag(&mut self, start: usize) -> Res<()> {
        let mut k = start + 2;
        let name_at = k;
        if self.at(k).is_none() {
            return self.fail("unclosed token", start);
        }
        let Some(name) = self.name_at(&mut k) else {
            return self.invalid(k);
        };
        while self.at(k).is_some_and(is_space) {
            k += 1;
        }
        match self.at(k) {
            None => return self.fail("unclosed token", start),
            Some('>') => {}
            Some(_) => return self.invalid(k),
        }
        let Some(frame) = self.stack.last() else {
            return self.fail("mismatched tag", name_at);
        };
        if frame.raw != name {
            return self.fail("mismatched tag", name_at);
        }
        self.flush();
        let Some(frame) = self.stack.pop() else {
            return self.fail("mismatched tag", name_at);
        };
        self.bindings.truncate(frame.ns_mark);
        self.i = k + 1;
        self.after_end = true;
        match self.stack.last_mut() {
            Some(parent) => parent.el.children.push(frame.el),
            None => self.root = Some(frame.el),
        }
        Ok(())
    }

    fn start_tag(&mut self) -> Res<()> {
        let start = self.i;
        self.tag_start = start;
        let mut k = start + 1;
        let raw = self.qname(&mut k, start)?;
        let mut attrs: Vec<(String, String, usize)> = Vec::new();
        let empty;
        loop {
            let before = k;
            while self.at(k).is_some_and(is_space) {
                k += 1;
            }
            match self.at(k) {
                None => return self.fail("unclosed token", start),
                Some('>') => {
                    k += 1;
                    empty = false;
                    break;
                }
                Some('/') => match self.at(k + 1) {
                    Some('>') => {
                        k += 2;
                        empty = true;
                        break;
                    }
                    None => return self.fail("unclosed token", start),
                    Some(_) => return self.invalid(k + 1),
                },
                Some(c) if k > before && (is_name_start(c) || c == ':') => {
                    let at = k;
                    let name = self.qname(&mut k, start)?;
                    while self.at(k).is_some_and(is_space) {
                        k += 1;
                    }
                    match self.at(k) {
                        None => return self.fail("unclosed token", start),
                        Some('=') => k += 1,
                        Some(_) => return self.invalid(k),
                    }
                    while self.at(k).is_some_and(is_space) {
                        k += 1;
                    }
                    let quote = match self.at(k) {
                        None => return self.fail("unclosed token", start),
                        Some(q @ ('\'' | '"')) => q,
                        Some(_) => return self.invalid(k),
                    };
                    k += 1;
                    let value = self.attribute_value(&mut k, quote, start)?;
                    if attrs.iter().any(|(n, _, _)| *n == name) {
                        return self.fail("duplicate attribute", at);
                    }
                    attrs.push((name, value, at));
                }
                Some(_) => return self.invalid(k),
            }
        }
        self.flush();
        self.i = k;
        // namespaces: declarations first, then the names
        let mark = self.bindings.len();
        let mut plain: Vec<(String, String)> = Vec::new();
        for (name, value, _) in &attrs {
            if name == "xmlns" {
                if value == XML_NS || value == XMLNS_NS {
                    return self.fail("prefix must not be bound to one of the reserved namespace names", start);
                }
                self.bindings.push((String::new(), value.clone()));
            } else if let Some(prefix) = name.strip_prefix("xmlns:") {
                if prefix == "xmlns" {
                    return self.fail("reserved prefix (xmlns) must not be declared or undeclared", start);
                }
                if prefix == "xml" && value != XML_NS {
                    return self.fail(
                        "reserved prefix (xml) must not be undeclared or bound to another namespace name",
                        start,
                    );
                }
                if value == XML_NS && prefix != "xml" || value == XMLNS_NS {
                    return self.fail("prefix must not be bound to one of the reserved namespace names", start);
                }
                if value.is_empty() {
                    return self.fail("must not undeclare prefix", start);
                }
                self.bindings.push((prefix.to_string(), value.clone()));
            } else {
                plain.push((name.clone(), value.clone()));
            }
        }
        let tag = match self.expand(&raw, true) {
            Some(tag) => tag,
            None => return self.fail("unbound prefix", start),
        };
        let mut attrib: Vec<(String, String)> = Vec::new();
        for (name, value) in plain {
            let Some(expanded) = self.expand(&name, false) else {
                return self.fail("unbound prefix", start);
            };
            if attrib.iter().any(|(n, _)| *n == expanded) {
                return self.fail("duplicate attribute", start);
            }
            attrib.push((expanded, value));
        }
        let el = Element { tag, attrib, text: None, tail: None, children: Vec::new() };
        self.after_end = false;
        if empty {
            self.bindings.truncate(mark);
            self.after_end = true;
            match self.stack.last_mut() {
                Some(parent) => parent.el.children.push(el),
                None => self.root = Some(el),
            }
        } else {
            self.stack.push(Frame { el, raw, ns_mark: mark });
        }
        Ok(())
    }

    /// A name with at most one colon, each side a name.
    fn qname(&self, k: &mut usize, tag_start: usize) -> Res<String> {
        let mut out = String::new();
        let mut colons = 0;
        loop {
            match self.at(*k) {
                Some(':') => {
                    colons += 1;
                    if colons > 1 || out.is_empty() {
                        return self.invalid(*k);
                    }
                    out.push(':');
                    *k += 1;
                    if !self.at(*k).is_some_and(is_name_start) {
                        return if self.at(*k).is_none() { self.fail("unclosed token", tag_start) } else { self.invalid(*k) };
                    }
                }
                Some(c) if (out.is_empty() && is_name_start(c)) || (!out.is_empty() && is_name_char(c)) => {
                    out.push(c);
                    *k += 1;
                }
                Some(c) if out.is_empty() => {
                    let _ = c;
                    return self.invalid(*k);
                }
                _ => return Ok(out),
            }
        }
    }

    fn attribute_value(&mut self, k: &mut usize, quote: char, start: usize) -> Res<String> {
        let mut out = String::new();
        loop {
            match self.at(*k) {
                None => return self.fail("unclosed token", start),
                Some(c) if c == quote => {
                    *k += 1;
                    return Ok(out);
                }
                Some('<') => return self.invalid(*k),
                Some('&') => {
                    let saved = self.i;
                    self.i = *k;
                    let text = self.reference(true);
                    *k = self.i;
                    self.i = saved;
                    match text {
                        Ok(text) => out.push_str(&text),
                        // expat places an undefined entity of an attribute at the start tag
                        Err(XmlError::Parse(m)) if m.starts_with("undefined entity") => {
                            return self.fail("undefined entity", start);
                        }
                        Err(e) => return Err(e),
                    }
                }
                Some('\r') => {
                    out.push(' ');
                    *k += 1;
                    if self.at(*k) == Some('\n') {
                        *k += 1;
                    }
                }
                Some('\n') | Some('\t') => {
                    out.push(' ');
                    *k += 1;
                }
                Some(c) if !is_xml_char(c) => return self.invalid(*k),
                Some(c) => {
                    out.push(c);
                    *k += 1;
                }
            }
        }
    }

    /// `{uri}local` for a raw name (`None` for an unbound prefix). Attributes without a prefix are in no namespace.
    fn expand(&self, raw: &str, is_element: bool) -> Option<String> {
        let lookup = |prefix: &str| -> Option<String> {
            if prefix == "xml" {
                return Some(XML_NS.to_string());
            }
            self.bindings.iter().rev().find(|(p, _)| p == prefix).map(|(_, u)| u.clone())
        };
        match raw.split_once(':') {
            Some((prefix, local)) => lookup(prefix).map(|uri| format!("{{{uri}}}{local}")),
            None if is_element => match lookup("") {
                Some(uri) if !uri.is_empty() => Some(format!("{{{uri}}}{raw}")),
                _ => Some(raw.to_string()),
            },
            None => Some(raw.to_string()),
        }
    }
}

// --- writing -----------------------------------------------------------------------------------------------------

/// The prefixes `ET.register_namespace` and the standard table give a namespace (`_namespace_map`).
fn default_prefix(uri: &str, registered: &[(&str, &str)]) -> Option<String> {
    if let Some((_, prefix)) = registered.iter().find(|(u, _)| *u == uri) {
        return Some(prefix.to_string());
    }
    let standard = [
        (XML_NS, "xml"),
        ("http://www.w3.org/1999/xhtml", "html"),
        ("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf"),
        ("http://schemas.xmlsoap.org/wsdl/", "wsdl"),
        ("http://www.w3.org/2001/XMLSchema", "xs"),
        ("http://www.w3.org/2001/XMLSchema-instance", "xsi"),
        ("http://purl.org/dc/elements/1.1/", "dc"),
    ];
    standard.iter().find(|(u, _)| *u == uri).map(|(_, p)| p.to_string())
}

fn escape_cdata(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_attrib(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\r', "&#13;")
        .replace('\n', "&#10;")
        .replace('\t', "&#09;")
}

/// `ET.tostring(el, encoding="unicode")`. `registered` is what `ET.register_namespace(prefix, uri)` was called with,
/// as `(uri, prefix)` pairs.
pub fn tostring(root: &Element, registered: &[(&str, &str)]) -> String {
    // identify the namespaces used in the tree: qname -> serialized name, uri -> prefix
    let mut qnames: Vec<(String, String)> = Vec::new();
    let mut namespaces: Vec<(String, String)> = Vec::new();
    let add = |qname: &str, qnames: &mut Vec<(String, String)>, namespaces: &mut Vec<(String, String)>| {
        if qnames.iter().any(|(q, _)| q == qname) {
            return;
        }
        let name = match qname.strip_prefix('{').and_then(|r| r.rsplit_once('}')) {
            Some((uri, tag)) => {
                let prefix = match namespaces.iter().find(|(u, _)| u == uri) {
                    Some((_, p)) => p.clone(),
                    None => {
                        let p = default_prefix(uri, registered).unwrap_or_else(|| format!("ns{}", namespaces.len()));
                        if p != "xml" {
                            namespaces.push((uri.to_string(), p.clone()));
                        }
                        p
                    }
                };
                if prefix.is_empty() { tag.to_string() } else { format!("{prefix}:{tag}") }
            }
            None => qname.to_string(),
        };
        qnames.push((qname.to_string(), name));
    };
    for el in root.iter() {
        add(&el.tag, &mut qnames, &mut namespaces);
        for (key, _) in &el.attrib {
            add(key, &mut qnames, &mut namespaces);
        }
    }
    let mut out = String::new();
    serialize(&mut out, root, &qnames, Some(&namespaces));
    out
}

fn serialize(out: &mut String, el: &Element, qnames: &[(String, String)], namespaces: Option<&[(String, String)]>) {
    let name_of = |q: &str| qnames.iter().find(|(k, _)| k == q).map_or(q.to_string(), |(_, n)| n.clone());
    let tag = name_of(&el.tag);
    out.push('<');
    out.push_str(&tag);
    if let Some(namespaces) = namespaces {
        let mut sorted: Vec<&(String, String)> = namespaces.iter().collect();
        sorted.sort_by(|a, b| a.1.cmp(&b.1));
        for (uri, prefix) in sorted {
            let k = if prefix.is_empty() { String::new() } else { format!(":{prefix}") };
            out.push_str(&format!(" xmlns{k}=\"{}\"", escape_attrib(uri)));
        }
    }
    for (k, v) in &el.attrib {
        out.push_str(&format!(" {}=\"{}\"", name_of(k), escape_attrib(v)));
    }
    let text = el.text.as_deref().filter(|t| !t.is_empty());
    if text.is_some() || !el.children.is_empty() {
        out.push('>');
        if let Some(text) = text {
            out.push_str(&escape_cdata(text));
        }
        for child in &el.children {
            serialize(out, child, qnames, None);
        }
        out.push_str("</");
        out.push_str(&tag);
        out.push('>');
    } else {
        out.push_str(" />");
    }
    if let Some(tail) = el.tail.as_deref().filter(|t| !t.is_empty()) {
        out.push_str(&escape_cdata(tail));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_tail_attributes_and_namespaces() {
        let el = fromstring("<a x='1' y=\"2\">hi<b/>tail<!-- c -->more<c xmlns='u'>&amp;&#65;</c></a>").unwrap();
        assert_eq!(el.attrib, vec![("x".into(), "1".into()), ("y".into(), "2".into())]);
        assert_eq!(el.text.as_deref(), Some("hi"));
        assert_eq!(el.children[0].tail.as_deref(), Some("tailmore"));
        assert_eq!(el.children[1].tag, "{u}c");
        assert_eq!(el.children[1].text.as_deref(), Some("&A"));
    }

    #[test]
    fn expat_messages() {
        let msg = |t: &str| fromstring(t).unwrap_err().to_string();
        assert_eq!(msg(""), "no element found: line 1, column 0");
        assert_eq!(msg("<a><b></a>"), "mismatched tag: line 1, column 8");
        assert_eq!(msg("<a/><b/>"), "junk after document element: line 1, column 4");
        assert_eq!(msg("<!DOCTYPE a SYSTEM 'x'><a/>"), "DTDForbidden(name='a', system_id='x', public_id=None)");
    }

    #[test]
    fn writes_like_elementtree() {
        let el = fromstring("<a x=\"1&amp;2\"><b/>t<c>x&lt;</c></a>").unwrap();
        assert_eq!(tostring(&el, &[]), "<a x=\"1&amp;2\"><b />t<c>x&lt;</c></a>");
    }
}
