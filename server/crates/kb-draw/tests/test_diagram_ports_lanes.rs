//! The plain diagram picture honours the fixed link points of a style (`exitX`, `entryX`, ...) and draws the header
//! band and label of a swimlane.

use kb_draw::diagram_model::render_svg;

fn drawing(cells: &str) -> String {
    format!("<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>{cells}</root></mxGraphModel>")
}

fn vertex(id: &str, label: &str, style: &str, (x, y, w, h): (i32, i32, i32, i32)) -> String {
    format!(
        "<mxCell id=\"{id}\" value=\"{label}\" style=\"{style}\" vertex=\"1\" parent=\"1\">\
         <mxGeometry x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" as=\"geometry\"/></mxCell>"
    )
}

fn edge(style: &str) -> String {
    format!(
        "<mxCell id=\"e\" style=\"{style}\" edge=\"1\" parent=\"1\" source=\"a\" target=\"b\">\
         <mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>"
    )
}

fn first_link(svg: &str) -> Vec<(f64, f64)> {
    let points = svg.split("<polyline points=\"").nth(1).expect("a link");
    points
        .split('"')
        .next()
        .expect("points")
        .split(' ')
        .map(|p| {
            let (x, y) = p.split_once(',').expect("a point");
            (x.parse().expect("x"), y.parse().expect("y"))
        })
        .collect()
}

#[test]
fn an_orthogonal_link_starts_and_ends_at_the_named_points() {
    let src = drawing(&format!(
        "{}{}{}{}",
        vertex("lane", "Customer", "swimlane;startSize=30;", (0, 0, 600, 240)),
        vertex("a", "A", "rounded=1;", (50, 70, 100, 60)),
        vertex("b", "B", "rounded=1;", (300, 150, 100, 60)),
        edge("edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;entryX=0.5;entryY=0;")
    ));
    let pts = first_link(&render_svg(&src).expect("svg"));
    // the picture's left/top edge is page (-20, -20): out of A's right side middle, into B's top middle
    assert_eq!(pts.first(), Some(&(170.0, 120.0)));
    assert_eq!(pts.last(), Some(&(370.0, 170.0)));
    assert!(pts.windows(2).all(|w| w[0].0 == w[1].0 || w[0].1 == w[1].1), "{pts:?}");
    // it leaves sideways, so the first segment is horizontal
    assert_eq!(pts[0].1, pts[1].1);
}

#[test]
fn offsets_and_the_perimeter_move_the_point() {
    let src = drawing(&format!(
        "{}{}{}",
        vertex("a", "A", "rounded=1;", (0, 0, 100, 60)),
        vertex("b", "B", "ellipse;", (300, 0, 100, 100)),
        edge("exitX=0.25;exitY=1;exitDy=10;entryX=1;entryY=0.5;")
    ));
    let pts = first_link(&render_svg(&src).expect("svg"));
    assert_eq!(pts.len(), 2);
    assert_eq!(pts[0], (45.0, 90.0));
    assert_eq!(pts[1], (420.0, 70.0));
}

#[test]
fn the_same_side_loops_around_and_waypoints_are_kept() {
    let src = drawing(&format!(
        "{}{}{}",
        vertex("a", "A", "rounded=1;", (0, 0, 100, 60)),
        vertex("b", "B", "rounded=1;", (200, 0, 100, 60)),
        edge("edgeStyle=orthogonalEdgeStyle;exitX=0.5;exitY=1;entryX=0.5;entryY=1;")
    ));
    let pts = first_link(&render_svg(&src).expect("svg"));
    // both leave downwards: the link dips below both shapes
    assert!(pts.len() >= 4);
    assert!(pts.iter().any(|p| p.1 > 60.0 + 20.0 + 10.0), "{pts:?}");
    assert!(pts.windows(2).all(|w| w[0].0 == w[1].0 || w[0].1 == w[1].1), "{pts:?}");
}

#[test]
fn a_swimlane_has_a_header_band_with_its_label() {
    let src = drawing(&vertex("lane", "Customer", "swimlane;startSize=30;fillColor=#dae8fc;", (0, 0, 400, 200)));
    let svg = render_svg(&src).expect("svg");
    assert!(svg.contains(">Customer</tspan>"), "{svg}");
    // the band is 30 high, across the top
    assert!(svg.contains("width=\"400.0\" height=\"30.0\" fill=\"#dae8fc\""), "{svg}");
    assert!(!svg.contains("rotate"));
}

#[test]
fn a_pool_with_a_vertical_header_turns_its_label() {
    let src = drawing(&vertex("pool", "Billing", "shape=swimlane;horizontal=0;startSize=40;", (0, 0, 400, 200)));
    let svg = render_svg(&src).expect("svg");
    assert!(svg.contains(">Billing</tspan>"), "{svg}");
    assert!(svg.contains("width=\"40.0\" height=\"200.0\""), "{svg}");
    assert!(svg.contains("rotate(-90 40.0 120.0)"), "{svg}");
}

/// A preview the editor wrote for both themes is served in its light colours (it showed dark on a dark-mode computer).
#[test]
fn a_preview_for_both_themes_is_shown_light() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" style="background: transparent; color-scheme: light dark;"><rect style="fill: light-dark(#ffffff, #121212)"/></svg>"##;
    let out = kb_draw::diagrams::light_only(svg);
    assert!(out.contains("color-scheme: light;") && !out.contains("light dark"), "{out}");
    assert!(out.contains("light-dark(#ffffff, #121212)"), "the colours stay; the scheme picks the light one");
    let plain = r##"<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>"##;
    assert_eq!(kb_draw::diagrams::light_only(plain), plain);
}
