//! Renders the richdoc fixtures and a few hand-made pages to every format and checks the results.

use std::io::{Cursor, Read};
use std::path::PathBuf;

use kb_docexport::{
    Asset, AssetSource, Book, DocxOptions, DrawingKind, ExportFormat, ExportPage, Highlight, HighlightMode, HtmlLayout,
    HtmlLook, HtmlOptions, HtmlOutput, MarkdownEmbeds, MarkdownImages, MarkdownOptions, NoAssets, PageSetup, PageSize,
    PdfOptions, TableOfContents, estimate_size, find_browser, render_docx, render_html, render_markdown, render_pdf,
};
use serde_json::{Value, json};

/// Serves a small PNG for every upload that looks like a picture and for every drawing.
struct TestAssets;

fn tiny_png() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(4, 3, image::Rgb([200, 120, 40]));
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

impl AssetSource for TestAssets {
    fn fetch(&self, src: &str) -> Option<Asset> {
        if src.starts_with("/uploads/") {
            if src.ends_with(".png") || src.ends_with(".jpg") {
                return Some(Asset { bytes: tiny_png(), mime: "image/png".into() });
            }
            return Some(Asset { bytes: b"file bytes".to_vec(), mime: "application/octet-stream".into() });
        }
        None
    }

    fn drawing_png(&self, _kind: DrawingKind, _id: &str) -> Option<Vec<u8>> {
        Some(tiny_png())
    }
}

fn fixtures() -> Vec<(String, Value)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract/richdoc/fixtures");
    let mut out = Vec::new();
    for dir in ["json", "md"] {
        let mut files: Vec<PathBuf> = std::fs::read_dir(root.join(dir))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        for f in files {
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
            out.push((format!("{dir}/{}", f.file_name().unwrap().to_string_lossy()), doc));
        }
    }
    assert!(out.len() > 60, "fixtures not found");
    out
}

fn page(title: &str, doc: Value) -> ExportPage {
    ExportPage {
        title: title.into(),
        author: Some("An Nguyen".into()),
        updated_at: Some("Oct 5, 2026".into()),
        path: String::new(),
        doc,
        settings: json!({}),
        highlights: Vec::new(),
    }
}

/// The words (3+ ASCII letters or digits) of every text node of a doc.
fn words(doc: &Value) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        if v.get("type").and_then(Value::as_str) == Some("text") {
            let t = v.get("text").and_then(Value::as_str).unwrap_or("");
            for w in t.split(|c: char| !c.is_ascii_alphanumeric()) {
                if w.len() >= 3 {
                    out.push(w.to_string());
                }
            }
        }
        if let Some(arr) = v.get("content").and_then(Value::as_array) {
            for c in arr {
                walk(c, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    out
}

/// Removes tags, so text split over runs or marks reads as one.
fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn unzip(bytes: &[u8]) -> zip::ZipArchive<Cursor<&[u8]>> {
    zip::ZipArchive::new(Cursor::new(bytes)).expect("a valid zip")
}

fn zip_text(bytes: &[u8], name: &str) -> String {
    let mut z = unzip(bytes);
    let mut f = z.by_name(name).unwrap_or_else(|_| panic!("{name} in the docx"));
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    s
}

fn assert_has_words(name: &str, format: &str, doc: &Value, text: &str) {
    for w in words(doc) {
        assert!(text.contains(&w), "{name}: {format} lacks the word {w:?}");
    }
}

#[test]
fn every_fixture_renders_to_html() {
    for (name, doc) in fixtures() {
        let pages = [page("Fixture", doc.clone())];
        for (layout, look) in [(HtmlLayout::SingleFile, HtmlLook::PageTheme), (HtmlLayout::Folder, HtmlLook::Plain)] {
            let opts = HtmlOptions { layout, look, ..Default::default() };
            let out = render_html(&pages, &TestAssets, &opts);
            let html = out.index_html();
            assert!(html.starts_with("<!DOCTYPE html>"), "{name}");
            assert!(!html.to_ascii_lowercase().contains("<script"), "{name}: a script");
            assert_has_words(&name, "HTML", &doc, &strip_tags(html));
            if let HtmlOutput::Folder(files) = &out {
                for f in &files[1..] {
                    assert!(f.path.starts_with("assets/"), "{name}: {}", f.path);
                    assert!(html.contains(&f.path), "{name}: {} is not used", f.path);
                }
            }
        }
    }
}

#[test]
fn every_fixture_renders_to_docx() {
    for (name, doc) in fixtures() {
        let pages = [page("Fixture", doc.clone())];
        let bytes = render_docx(&pages, &TestAssets, &DocxOptions::default());
        assert!(bytes.starts_with(b"PK"), "{name}: not a zip");
        let xml = zip_text(&bytes, "word/document.xml");
        assert!(xml.contains(r#"w:val="Title""#), "{name}: the title has no Title style");
        assert_has_words(&name, "DOCX", &doc, &strip_tags(&xml));
        let styles = zip_text(&bytes, "word/styles.xml");
        for id in ["Title", "Heading1", "Heading6", "Quote", "Code", "Caption", "ListParagraph"] {
            assert!(styles.contains(&format!(r#"w:styleId="{id}""#)), "{name}: style {id} missing");
        }
        let text = serde_json::to_string(&doc).unwrap();
        if text.contains(r#""type":"heading""#) {
            assert!(xml.contains(r#"w:pStyle w:val="Heading"#), "{name}: no heading style used");
        }
        if text.contains(r#""type":"blockquote""#) {
            assert!(xml.contains(r#"w:pStyle w:val="Quote""#), "{name}: no Quote style used");
        }
        if text.contains(r#""type":"codeBlock""#) {
            assert!(xml.contains(r#"w:pStyle w:val="Code""#), "{name}: no Code style used");
        }
        if text.contains(r#""type":"image""#) && text.contains("/uploads/") {
            let z = unzip(&bytes);
            assert!(z.file_names().any(|n| n.starts_with("word/media/")), "{name}: no picture embedded");
        }
        if text.contains(r#""rowspan""#) {
            assert!(xml.contains("w:vMerge"), "{name}: rowspan not merged");
        }
        if text.contains(r#""colspan""#) {
            assert!(xml.contains("w:gridSpan"), "{name}: colspan not merged");
        }
    }
}

#[test]
fn every_fixture_renders_to_markdown() {
    for (name, doc) in fixtures() {
        let pages = [page("Fixture", doc.clone())];
        for (images, embeds) in [
            (MarkdownImages::Folder, MarkdownEmbeds::Link),
            (MarkdownImages::Inline, MarkdownEmbeds::Placeholder),
            (MarkdownImages::Link, MarkdownEmbeds::Placeholder),
        ] {
            let opts = MarkdownOptions { images, embeds, ..Default::default() };
            let files = render_markdown(&pages, &TestAssets, &opts);
            assert_eq!(files[0].path, "Fixture.md", "{name}");
            let md = String::from_utf8(files[0].bytes.clone()).unwrap();
            assert!(md.starts_with("# Fixture\n"), "{name}");
            let plain = md.replace('\\', "");
            assert_has_words(&name, "Markdown", &doc, &plain);
            for f in &files[1..] {
                assert!(f.path.starts_with("images/"), "{name}: {}", f.path);
                assert!(md.contains(&f.path), "{name}: {} is not used", f.path);
            }
            if images != MarkdownImages::Folder {
                assert_eq!(files.len(), 1, "{name}: pictures must not be files in {images:?}");
            }
        }
    }
}

#[test]
fn markdown_embeds_follow_the_option() {
    let doc = json!({"type":"doc","content":[
        {"type":"diagram","attrs":{"id":"dg_1","label":"Flow"}},
        {"type":"video","attrs":{"src":"https://v.example/x","title":"Demo"}},
        {"type":"htmlEmbed","attrs":{"html":"<script>x</script>","title":"Form"}}]});
    let pages = [page("Embeds", doc)];
    let link = render_markdown(
        &pages,
        &NoAssets,
        &MarkdownOptions {
            embeds: MarkdownEmbeds::Link,
            base_url: Some("https://board.example".into()),
            ..Default::default()
        },
    );
    let md = String::from_utf8(link[0].bytes.clone()).unwrap();
    assert!(md.contains("[Flow](https://board.example/diagrams/dg_1/svg)"), "{md}");
    assert!(md.contains("[Demo](https://v.example/x)"), "{md}");
    assert!(md.contains("[embed: HTML embed · Form]"), "{md}");
    let ph = render_markdown(
        &pages,
        &NoAssets,
        &MarkdownOptions { embeds: MarkdownEmbeds::Placeholder, ..Default::default() },
    );
    let md = String::from_utf8(ph[0].bytes.clone()).unwrap();
    assert!(md.contains("[embed: draw.io diagram · Flow]"), "{md}");
    assert!(md.contains("[embed: video · Demo]"), "{md}");
    assert!(!md.contains("<script"));
}

#[test]
fn markdown_pages_follow_the_tree_and_link_each_other() {
    let a = ExportPage {
        path: "Architecture".into(),
        ..page(
            "Architecture",
            json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"See "},{"type":"docRef","attrs":{"page":"API"}}]},
            {"type":"image","attrs":{"src":"/uploads/team.png","alt":"Team"}}]}),
        )
    };
    let b = ExportPage {
        path: "Architecture/API".into(),
        ..page(
            "API",
            json!({"type":"doc","content":[{"type":"pageCard","attrs":{"page":"Architecture"}},
            {"type":"image","attrs":{"src":"/uploads/team.png","alt":"Team"}}]}),
        )
    };
    let files = render_markdown(&[a, b], &TestAssets, &MarkdownOptions::default());
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["Architecture.md", "Architecture/API.md", "images/team.png"]);
    let first = String::from_utf8(files[0].bytes.clone()).unwrap();
    let second = String::from_utf8(files[1].bytes.clone()).unwrap();
    assert!(first.contains("[API](Architecture/API.md)"), "{first}");
    assert!(first.contains("![Team](images/team.png)"), "{first}");
    assert!(second.contains("[Architecture](../Architecture.md)"), "{second}");
    assert!(second.contains("![Team](../images/team.png)"), "{second}");
}

fn book_pages() -> Vec<ExportPage> {
    ["The Letter", "The Ferry", "The Long Tide"]
        .iter()
        .enumerate()
        .map(|(i, t)| {
            page(
                t,
                json!({"type":"doc","content":[
                    {"type":"heading","attrs":{"blockId":format!("b-00000{i}"),"level":1},"content":[{"type":"text","text":format!("Dusk {i}")}]},
                    {"type":"paragraph","attrs":{"dropCap":3,"textAlign":"justify"},"content":[{"type":"text","text":format!("Chapter body number {i} of the harbour.")}]}]}),
            )
        })
        .collect()
}

fn book() -> Book {
    Book {
        title: "The Harbour Lights".into(),
        subtitle: Some("Book one".into()),
        author: Some("Hoa Mai".into()),
        date: Some("November 2026".into()),
        cover_image: Some("/uploads/cover.png".into()),
        cover: true,
        title_page: true,
        contents: true,
        chapter_breaks: true,
        number_chapters: true,
    }
}

#[test]
fn a_book_of_three_pages() {
    let pages = book_pages();
    let html = render_html(
        &pages,
        &TestAssets,
        &HtmlOptions { book: Some(book()), print: Some(PageSetup::default()), ..Default::default() },
    );
    let html = html.index_html();
    assert!(html.contains("class=\"book-cover\""));
    assert!(html.contains("class=\"title-page\""));
    assert!(html.contains("November 2026"));
    assert!(html.contains("3. The Long Tide"), "contents with chapter numbers");
    assert!(html.contains("Chapter 3"));
    assert_eq!(html.matches("class=\"page chapter break\"").count(), 3, "every chapter starts a page");
    let (a, b, c) = (html.find("The Letter</h1>"), html.find("The Ferry</h1>"), html.find("The Long Tide</h1>"));
    assert!(a < b && b < c, "chapters in the given order");
    assert!(html.contains("<h2 id=\"h-b-000000\">Dusk 0</h2>"), "page headings move down one level");
    assert!(html.contains("@top-right { content: \"The Harbour Lights\""), "running header");

    let docx = render_docx(&pages, &TestAssets, &DocxOptions { book: Some(book()), ..Default::default() });
    let xml = zip_text(&docx, "word/document.xml");
    assert!(xml.contains("3. The Long Tide"));
    assert!(xml.contains("w:pageBreakBefore"), "chapters on new pages");
    assert!(xml.contains("TOC \\o"), "a Word contents field: {}", &xml[..xml.len().min(400)]);
    assert!(xml.contains(r#"w:val="Heading2""#), "page headings move down one level");
    let header = zip_text(&docx, "word/header1.xml");
    assert!(header.contains("The Harbour Lights"), "running header");
    let footer = zip_text(&docx, "word/footer1.xml");
    assert!(footer.contains("PAGE"), "page numbers");
    assert!(unzip(&docx).file_names().any(|n| n.starts_with("word/media/")), "cover picture");

    let md = render_markdown(&pages, &TestAssets, &MarkdownOptions { book: Some(book()), ..Default::default() });
    assert_eq!(md[0].path, "The Harbour Lights.md");
    let text = String::from_utf8(md[0].bytes.clone()).unwrap();
    assert!(text.starts_with("![The Harbour Lights](images/cover.png)\n\n# The Harbour Lights\n"), "{text}");
    assert!(text.contains("## 3. The Long Tide"));
    assert!(text.contains("### Dusk 2"));
    assert!(text.contains("- 1. The Letter"));
}

#[test]
fn hostile_text_and_attributes_are_escaped() {
    let doc = json!({"type":"doc","content":[
        {"type":"paragraph","attrs":{"blockId":"b-000001","textAlign":"center\" onmouseover=\"x"},"content":[
            {"type":"text","text":"<script>alert(1)</script> & <img src=x onerror=alert(1)>"},
            {"type":"text","text":"click","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]},
            {"type":"text","text":"tab","marks":[{"type":"link","attrs":{"href":" JaVa\tScRiPt:alert(1)"}}]},
            {"type":"text","text":"colour","marks":[{"type":"textStyle","attrs":{"color":"red;background:url(javascript:x)","fontFamily":"x\"><script>"}}]},
            {"type":"text","text":"ok","marks":[{"type":"link","attrs":{"href":"https://example.com/?a=\"><script>"}}]}]},
        {"type":"image","attrs":{"src":"javascript:alert(1)","alt":"\"><script>alert(1)</script>","href":"javascript:x"}},
        {"type":"image","attrs":{"src":"data:text/html,<script>alert(1)</script>"}},
        {"type":"htmlEmbed","attrs":{"html":"<script>alert(1)</script><iframe src=javascript:x>","title":"</p><script>x</script>","runScripts":true}},
        {"type":"callout","attrs":{"color":"red;}</style><script>x</script>","title":"<b>t</b>"},"content":[{"type":"paragraph","content":[{"type":"text","text":"in"}]}]},
        {"type":"codeBlock","attrs":{"language":"\"><script>","filename":"<script>"},"content":[{"type":"text","text":"</code><script>alert(1)</script>"}]},
        {"type":"linkEmbed","attrs":{"url":"javascript:alert(1)","title":"<script>"}},
        {"type":"video","attrs":{"src":"javascript:alert(1)","poster":"javascript:alert(2)","title":"<script>"}},
        {"type":"fileCard","attrs":{"src":"vbscript:x","name":"<script>.pdf"}},
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"background":"url(javascript:x)","colspan":"<script>"},"content":[{"type":"paragraph","content":[{"type":"text","text":"<script>"}]}]}]}]}]});
    let mut p = page("<script>alert('title')</script>", doc);
    p.author = Some("\"><script>alert(1)</script>".into());
    p.settings = json!({"eyebrow":"<script>","cover":{"src":"javascript:alert(1)"},"background":"</style><script>","bodyFont":"x'><script>"});
    p.highlights = vec![Highlight {
        block_id: "b-000001".into(),
        start: 0,
        end: 8,
        color: Some("\"><script>".into()),
        author: Some("\"><script>alert(1)</script>".into()),
    }];
    let pages = [p];
    for layout in [HtmlLayout::SingleFile, HtmlLayout::Folder] {
        let opts = HtmlOptions {
            layout,
            highlights: HighlightMode::Show,
            print: Some(PageSetup::default()),
            book: None,
            ..Default::default()
        };
        let html = render_html(&pages, &TestAssets, &opts).index_html().to_ascii_lowercase();
        assert!(!html.contains("<script"), "a script tag: {html}");
        assert!(!html.contains("javascript:"), "a javascript: url");
        assert!(!html.contains("vbscript:"), "a vbscript: url");
        assert!(!html.contains("<iframe"), "an iframe");
        assert!(!html.contains("<img src=x"), "a raw img");
        assert!(!html.contains("onmouseover=\""), "an event attribute");
        assert!(!html.contains("data:text/html"), "a data: html url");
        assert!(html.contains("html embed: &lt;/p&gt;&lt;script&gt;x&lt;/script&gt; (open the page to run it)"));
        assert!(html.contains("mark class=\"reader\""), "the reader highlight is drawn");
    }
    let book_opts = HtmlOptions {
        book: Some(Book { title: "</title><script>".into(), contents: true, cover: true, ..Default::default() }),
        print: Some(PageSetup::default()),
        ..Default::default()
    };
    let html = render_html(&pages, &TestAssets, &book_opts).index_html().to_ascii_lowercase();
    assert!(!html.contains("<script") && !html.contains("</title><"), "book title escaped");

    let md = render_markdown(&pages, &NoAssets, &MarkdownOptions::default());
    let md = String::from_utf8(md[0].bytes.clone()).unwrap().to_ascii_lowercase();
    assert!(!md.contains("](javascript:"), "a javascript: link in markdown: {md}");
    // Outside code fences (where it is code, shown as text), no raw HTML may survive.
    let outside_code: String = md.split("```").step_by(2).collect::<String>().replace("\\<", "");
    assert!(!outside_code.contains("<script"), "raw html in markdown: {md}");

    let docx = render_docx(&pages, &NoAssets, &DocxOptions::default());
    let xml = zip_text(&docx, "word/document.xml");
    assert!(!xml.contains("<script"), "unescaped text in the docx");
    let rels = zip_text(&docx, "word/_rels/document.xml.rels").to_ascii_lowercase();
    assert!(!rels.contains("javascript:"), "a javascript: hyperlink in the docx");
}

#[test]
fn page_theme_and_print_setup_reach_the_css() {
    let mut p = page(
        "Themed",
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Body"}]}]}),
    );
    p.settings = json!({"background":"sepia","bodyFont":"lora","width":"wide","cover":{"src":"/uploads/c.png","titleOnCover":true}});
    let pages = [p];
    let html = render_html(&pages, &TestAssets, &HtmlOptions::default());
    let html = html.index_html();
    assert!(html.contains("--page-bg:#F4ECD8"), "sepia background");
    assert!(html.contains("'Lora'"), "page font");
    assert!(html.contains("--page-width:880px"));
    assert!(html.contains("data:image/png;base64,"), "cover embedded");
    assert!(html.contains("cover-title"));
    assert!(!html.contains("@page"), "no print css for a web page");
    let plain = render_html(&pages, &TestAssets, &HtmlOptions { look: HtmlLook::Plain, ..Default::default() });
    assert!(!plain.index_html().contains("--page-bg"));
    let setup = PageSetup {
        size: PageSize::Letter,
        orientation: kb_docexport::Orientation::Landscape,
        margins: kb_docexport::Margins::Wide,
        contents: TableOfContents::Include,
        cover_page: true,
        ..Default::default()
    };
    let printed = render_html(&pages, &TestAssets, &HtmlOptions { print: Some(setup), ..Default::default() });
    let printed = printed.index_html();
    assert!(printed.contains("size: letter landscape; margin: 38.1mm"));
    assert!(printed.contains("counter(page)"));
    assert!(printed.contains("<nav class=\"toc\""));
    let fit = render_html(
        &pages,
        &TestAssets,
        &HtmlOptions {
            print: Some(PageSetup { size: PageSize::FitToContent, ..Default::default() }),
            ..Default::default()
        },
    );
    assert!(fit.index_html().contains("size: 794px"), "one long page");
    assert!(!fit.index_html().contains("counter(page)"), "no page numbers on one long page");
}

#[test]
fn size_estimates_grow_with_pictures() {
    let text =
        page("T", json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}));
    let pics = page(
        "P",
        json!({"type":"doc","content":[{"type":"image","attrs":{"src":"/uploads/a.png"}},{"type":"video","attrs":{"src":"/uploads/v.mp4"}}]}),
    );
    let small = estimate_size(std::slice::from_ref(&text), ExportFormat::Markdown);
    let big = estimate_size(std::slice::from_ref(&pics), ExportFormat::Html);
    assert!(small < 10_000, "{small}");
    assert!(big > 20 * 1024 * 1024, "the video counts for HTML: {big}");
    assert!(estimate_size(&[pics], ExportFormat::Docx) < big, "Word keeps a link to the video");
}

#[test]
fn pdf_prints_when_a_browser_is_found() {
    if find_browser().is_none() {
        println!("note: no Chromium/Chrome/Edge found (set KANBAN_CHROME); the PDF test is skipped");
        return;
    }
    let pages = book_pages();
    let html = render_html(
        &pages,
        &TestAssets,
        &HtmlOptions {
            print: Some(PageSetup { contents: TableOfContents::Include, ..Default::default() }),
            ..Default::default()
        },
    );
    let pdf = render_pdf(html.index_html(), &PdfOptions::default()).expect("a PDF");
    assert!(pdf.starts_with(b"%PDF"), "not a PDF");
    let book_html = render_html(
        &pages,
        &TestAssets,
        &HtmlOptions {
            book: Some(book()),
            print: Some(PageSetup { size: PageSize::Letter, ..Default::default() }),
            ..Default::default()
        },
    );
    let pdf = render_pdf(book_html.index_html(), &PdfOptions::default()).expect("a book PDF");
    assert!(pdf.starts_with(b"%PDF"));
    let pages_in_pdf = String::from_utf8_lossy(&pdf).matches("/Type /Page\n").count()
        + String::from_utf8_lossy(&pdf).matches("/Type /Page>").count()
        + String::from_utf8_lossy(&pdf).matches("/Type/Page/").count();
    println!("book PDF: {} bytes, page markers {pages_in_pdf}", pdf.len());
}

#[test]
fn a_missing_browser_is_a_clear_error() {
    let opts = PdfOptions { browser: Some(PathBuf::from("/nonexistent/chrome")), ..Default::default() };
    let err = render_pdf("<p>x</p>", &opts).unwrap_err();
    assert!(err.to_string().contains("KANBAN_CHROME"), "{err}");
}

#[test]
fn a_picture_keeps_its_line_colour_and_its_soft_shadow() {
    let doc = json!({"type":"doc","content":[
        {"type":"image","attrs":{"src":"/uploads/a.png","border":"medium","borderColor":"#2F6FB0","shadow":true,"shadowStyle":"soft"}},
        {"type":"image","attrs":{"src":"/uploads/b.png","border":"thin","borderColor":"red;x","shadow":true}}]});
    let pages = [page("Pictures", doc)];
    let out = render_html(&pages, &TestAssets, &HtmlOptions::default());
    let html = out.index_html();
    assert!(html.contains("border:2px solid #2F6FB0;"), "the medium line in its colour: {html}");
    assert!(html.contains("box-shadow:0 2px 8px rgba(0,0,0,.12);"), "the soft shadow");
    // a colour that is not #rrggbb falls back to the text colour; a shadow without a style is lifted
    assert!(html.contains("border:1px solid currentColor;"));
    assert!(html.contains("box-shadow:0 4px 16px rgba(0,0,0,.18);"));
}

fn cell(kind: &str, text: &str, attrs: Value) -> Value {
    json!({"type":kind,"attrs":attrs,"content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
}

fn html_of(doc: Value) -> String {
    render_html(&[page("Rich", doc)], &TestAssets, &HtmlOptions::default()).index_html().to_string()
}

fn docx_xml_of(doc: Value) -> String {
    zip_text(&render_docx(&[page("Rich", doc)], &TestAssets, &DocxOptions::default()), "word/document.xml")
}

fn rich_table() -> Value {
    json!({"type":"doc","content":[{"type":"table","attrs":{"banded":true,"borders":"outer","spacing":"roomy","align":"center","caption":"Totals <b>"},"content":[
        {"type":"tableRow","content":[cell("tableHeader","H1",json!({})),cell("tableHeader","H2",json!({}))]},
        {"type":"tableRow","content":[cell("tableCell","a1",json!({})),cell("tableCell","a2",json!({}))]},
        {"type":"tableRow","content":[cell("tableCell","b1",json!({"border":"top bottom","borderStyle":"dashed","borderColor":"red","padding":"tight"})),
            cell("tableCell","b2",json!({"border":"none","padding":"roomy","background":"yellow"})),
            cell("tableCell","b3",json!({"border":"left","borderStyle":"thick","borderColor":"#112233"}))]}]}]})
}

#[test]
fn a_rich_table_reaches_the_html() {
    let html = html_of(rich_table());
    assert!(html.contains("<table class=\"t-lined fit banded b-outer sp-roomy al-center\">"), "{html}");
    assert!(html.contains("<tr class=\"band\">"), "the second body row is banded, the header row is not");
    assert_eq!(html.matches("<tr class=\"band\">").count(), 1);
    assert!(html.contains("<div class=\"table-caption\">Totals &lt;b&gt;</div>"), "caption under the table");
    assert!(html.contains("border-color:transparent;border-top:1px dashed #C4432A;border-bottom:1px dashed #C4432A;"));
    assert!(html.contains("padding:2px 8px;"));
    assert!(html.contains("border-color:transparent;padding:10px 14px;"), "border none: no side is drawn");
    assert!(html.contains("table.banded tr.band td"), "the rules are written when used");
}

#[test]
fn a_page_without_rich_attributes_keeps_its_html() {
    let doc = json!({"type":"doc","content":[
        {"type":"table","content":[{"type":"tableRow","content":[cell("tableCell","x",json!({}))]}]},
        {"type":"paragraph","attrs":{"dropCap":3},"content":[{"type":"text","text":"Once"}]},
        {"type":"columns","attrs":{},"content":[{"type":"column","content":[{"type":"paragraph"}]},{"type":"column","content":[{"type":"paragraph"}]}]}]});
    let html = html_of(doc);
    assert!(html.contains("<table class=\"t-lined full\">"));
    assert!(html.contains("<p class=\"dropcap dropcap-3\">"));
    assert!(html.contains("<div class=\"columns\" "));
    assert!(!html.contains("EXTRA") && !html.contains("table.banded") && !html.contains(".dropcap-x"));
}

#[test]
fn a_rich_table_reaches_the_docx() {
    let xml = docx_xml_of(rich_table());
    assert!(xml.contains(r#"<w:jc w:val="center""#), "the table is centred");
    assert!(xml.contains(r#"w:fill="F6FAF7""#), "banded row shading");
    assert_eq!(xml.matches(r#"w:fill="F6FAF7""#).count(), 2, "only the banded row cells without its own background");
    assert!(xml.contains("tblCellMar"), "table spacing");
    assert!(xml.contains(r#"w:insideH w:val="nil""#) || xml.contains("insideH"), "outer borders only");
    assert!(xml.contains(r#"w:val="dashed""#) && xml.contains(r#"w:color="C4432A""#), "dashed red cell line");
    assert!(xml.contains(r#"w:color="112233""#) && xml.contains(r#"w:sz="12""#), "thick line in its colour");
    assert!(xml.contains(r#"w:val="nil""#), "sides without a line");
    assert!(xml.contains("tcMar"), "cell padding");
    assert!(xml.contains("Totals &lt;b&gt;") || xml.contains("Totals <b>"), "caption");
    assert!(xml.contains(r#"w:val="Caption""#));
}

#[test]
fn drop_caps_in_html_and_docx() {
    let doc = json!({"type":"doc","content":[
        {"type":"paragraph","attrs":{"dropCap":2,"dropCapStyle":"raised","dropCapColor":"blue","dropCapFont":"body"},"content":[{"type":"text","text":"Zebra crossing"}]},
        {"type":"paragraph","attrs":{"dropCap":4,"dropCapColor":"#ab12cd"},"content":[{"type":"text","text":"Quick fox"}]}]});
    let html = html_of(doc.clone());
    assert!(
        html.contains("class=\"dropcap dropcap-x dropcap-2 dropcap-raised dropcap-body\" style=\"--dc:#1F5A8E;\""),
        "{html}"
    );
    assert!(html.contains("class=\"dropcap dropcap-x dropcap-4\" style=\"--dc:#AB12CD;\""));
    assert!(html.contains(".dropcap-4::first-letter { font-size: 4.7em; }"));
    let xml = docx_xml_of(doc);
    // the first letter is its own large run (2.4 and 4.7 times 11 pt), in the colour, the rest follows
    assert!(xml.contains(r#"<w:sz w:val="53""#) && xml.contains(r#"<w:sz w:val="103""#), "{xml}");
    assert!(xml.contains(r#"w:color w:val="1F5A8E""#) && xml.contains(r#"w:color w:val="AB12CD""#));
    assert!(xml.contains(">ebra crossing<") && xml.contains(">uick fox<"));
}

#[test]
fn middle_aligned_columns() {
    let doc = json!({"type":"doc","content":[{"type":"columns","attrs":{"valign":"middle"},"content":[
        {"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"L"}]}]},
        {"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"R"}]}]}]}]});
    let html = html_of(doc.clone());
    assert!(html.contains("<div class=\"columns valign-middle\" "));
    assert!(html.contains(".columns.valign-middle { align-items: center; }"));
    assert_eq!(docx_xml_of(doc).matches(r#"<w:vAlign w:val="center""#).count(), 2);
}

#[test]
fn a_picture_border_in_docx_and_named_colours_in_html() {
    let doc = json!({"type":"doc","content":[
        {"type":"image","attrs":{"src":"/uploads/a.png","border":"medium","borderColor":"#2F6FB0"}}]});
    let xml = docx_xml_of(doc);
    assert!(xml.contains(r#"w:sz="12""#) && xml.contains(r#"w:color="2F6FB0""#), "{xml}");
    let html = html_of(json!({"type":"doc","content":[
        {"type":"image","attrs":{"src":"/uploads/a.png","border":"medium","borderColor":"blue"}}]}));
    assert!(html.contains("border:2px solid #1F5A8E;"));
}

/// A page that hides its title (`showTitle: false`, a newspaper whose nameplate is in its text) has none in the
/// export either, in HTML, PDF and Word.
#[test]
fn a_hidden_title_is_left_out() {
    let mut p = page(
        "Báo Sáng - số 12",
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Măng-sét"}]}]}),
    );
    p.settings = json!({"showTitle": false});
    let pages = [p];
    let html = render_html(&pages, &TestAssets, &HtmlOptions::default());
    let html = html.index_html();
    assert!(!html.contains("<h1 class=\"page-title\">") && html.contains("Măng-sét"), "{html}");
    let docx = render_docx(&pages, &TestAssets, &DocxOptions::default());
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(docx)).expect("a docx is a zip");
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").expect("its text"), &mut xml).expect("read");
    assert!(!xml.contains("Báo Sáng - số 12") && xml.contains("Măng-sét"), "the title is left out of Word");
}
