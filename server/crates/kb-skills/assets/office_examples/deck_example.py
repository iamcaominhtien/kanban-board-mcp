"""An example deck for the `office-files` skill: Giọt's October water report, 5 slides, python-pptx only.

Copy the parts you need (the palette, the type sizes, `title()`, `bars()`), not the look: choose the subject's own.
What it shows: titles that state the point, one idea per slide, a chart that highlights its point and labels it on the
bars (no gridlines, no axis to read), numbers in the reader's format, a visual only this report has (the month as a
calendar), and no template furniture (no icons in circles, no cards, no gradients).

    pip install python-pptx && python deck_example.py   # writes deck_example.pptx
"""

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

# One palette, each colour with one meaning, kept on every slide
INK = RGBColor(0x10, 0x26, 0x33)  # text, the cover's ground
MUTED = RGBColor(0x5E, 0x6E, 0x78)  # secondary text
PAPER = RGBColor(0xFB, 0xFA, 0xF7)  # slide ground
REST = RGBColor(0xD5, 0xDB, 0xDF)  # data that is not the point
MET = RGBColor(0x1B, 0x6F, 0xA8)  # a day that met the goal
SHORT = RGBColor(0xD9, 0x5A, 0x3C)  # the problem the slide is about
FONT = "Calibri"  # a face every Office reader has; LibreOffice draws it with the metric twin Carlito

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.8)  # the same margin on every slide

# The data (Giọt, October 2026), worked out from the log before any slide is drawn
DAYS = [1830, 1330, 1890, 750, 2470, 2230, 2910, 2730, 1980, 1250, 1900, 1230, 1310, 3580, 1000, 1910,
        1000, 1150, 2120, 1540, 1650, 2330, 2550, 500, 980, 2380, 1230, 1720, 2070, 2160, 1790]  # fmt: skip
FIRST_WEEKDAY = 3  # 1 October 2026 is a Thursday (Monday = 0)
GOAL = 2000
WEEKDAY_AVG = {
    "T2": 2050,
    "T3": 1578,
    "T4": 2465,
    "T5": 1992,
    "T6": 1986,
    "T7": 1286,
    "CN": 1195,
}
HOURS = {8: 3860, 9: 7520, 10: 3540, 11: 7220, 12: 5970, 13: 4850, 14: 5460, 15: 4930, 16: 2540, 17: 3190,
         18: 2330, 19: 1150, 20: 2080, 21: 830}  # fmt: skip


def vn(n: float, decimals: int = 0) -> str:
    """A number as a Vietnamese reader writes it: 1.250 and 3,5."""
    s = f"{n:,.{decimals}f}"
    return s.replace(",", " ").replace(".", ",").replace(" ", ".")


def text(
    slide,
    x,
    y,
    w,
    h,
    s,
    size,
    color=INK,
    bold=False,
    align=PP_ALIGN.LEFT,
    anchor=MSO_ANCHOR.TOP,
    spacing=None,
):
    """A text box with no inner margins, one run per line, in the deck's face."""
    box = slide.shapes.add_textbox(x, y, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    for i, line in enumerate(s.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if spacing:
            p.line_spacing = spacing
        r = p.add_run()
        r.text = line
        r.font.name, r.font.size, r.font.bold = FONT, Pt(size), bold
        r.font.color.rgb = color
    return box


def plain(shape):
    """A flat shape: without its theme style it has no shadow and no outline (LibreOffice draws the style's shadow
    even with `shadow.inherit = False`)."""
    style = shape._element.find(
        "{http://schemas.openxmlformats.org/presentationml/2006/main}style"
    )
    if style is not None:
        shape._element.remove(style)
    shape.line.fill.background()


def slide(prs, ground=PAPER):
    """A blank slide (no placeholder boxes to fight) on a plain ground."""
    s = prs.slides.add_slide(
        prs.slide_layouts[6]
    )  # blank: no placeholder boxes to fight
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = ground
    return s


def title(s, point, note=None):
    """The point of the slide as a sentence, 32 pt, and one line under it that says what the evidence is."""
    text(s, M, Inches(0.6), W - 2 * M, Inches(1.2), point, 32, bold=True, spacing=1.05)
    if note:
        text(s, M, Inches(1.75), W - 2 * M, Inches(0.4), note, 16, MUTED)


def bars(s, x, y, w, h, labels, values, colors, label_size=14, fmt=vn):
    """A column chart that reads at a glance: the point in colour, the rest grey, values on the bars, no axis or
    gridlines to read. A native chart, so the person can still edit its data in PowerPoint."""
    data = CategoryChartData()
    data.categories = labels
    data.add_series("ml", values)
    chart = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, w, h, data).chart
    chart.has_legend = False
    chart.has_title = False  # a one-series chart gets its series name as a title otherwise; the slide title says it
    chart.font.name, chart.font.size = FONT, Pt(label_size)
    va = chart.value_axis
    va.visible = False
    va.has_major_gridlines = False
    va.minimum_scale = 0
    ca = chart.category_axis
    ca.format.line.fill.background()
    ca.tick_labels.font.size = Pt(label_size)
    ca.tick_labels.font.color.rgb = MUTED
    plot = chart.plots[0]
    plot.gap_width = 45
    series = plot.series[0]
    for i, (v, c) in enumerate(zip(values, colors)):
        pt = series.points[i]
        pt.format.fill.solid()
        pt.format.fill.fore_color.rgb = c
        dl = pt.data_label
        dl.position = XL_LABEL_POSITION.OUTSIDE_END
        dl.text_frame.text = fmt(
            v
        )  # the reader's format, whatever the machine's locale
        run = dl.text_frame.paragraphs[0].runs[0]
        run.font.size, run.font.color.rgb = Pt(label_size), INK if c != REST else MUTED
        run.font.bold = c != REST
    return chart


def build(path="deck_example.pptx"):
    """Write the five slides to ``path``."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    met = sum(d >= GOAL for d in DAYS)

    # 1. Cover: the whole report in one sentence
    s = slide(prs, INK)
    text(
        s,
        M,
        Inches(0.8),
        Inches(8),
        Inches(0.4),
        "GIỌT  ·  BÁO CÁO THÁNG 10/2026",
        14,
        RGBColor(0x8F, 0xB8, 0xD4),
        True,
    )
    text(s, M, Inches(1.9), Inches(7.6), Inches(3.0), "Tháng 10, cứ 3 ngày\nmới có 1 ngày\nuống đủ nước", 54,
         RGBColor(0xFF, 0xFF, 0xFF), True, spacing=1.0)  # fmt: skip
    text(s, M, Inches(5.2), Inches(9), Inches(0.9),
         f"{len(DAYS)} ngày, 184 lần uống, {vn(sum(DAYS))} ml. Mục tiêu {vn(GOAL)} ml mỗi ngày.", 20,
         RGBColor(0xB9, 0xC8, 0xD1))  # fmt: skip
    text(s, Inches(8.6), Inches(2.3), Inches(3.93), Inches(1.6), f"{met}/{len(DAYS)}", 96, RGBColor(0x5F, 0xA3, 0xD3), True,
         PP_ALIGN.RIGHT)  # fmt: skip
    text(s, Inches(8.6), Inches(3.95), Inches(3.93), Inches(0.5), "ngày đạt mục tiêu", 18, RGBColor(0xB9, 0xC8, 0xD1),
         align=PP_ALIGN.RIGHT)  # fmt: skip

    # 2. The month as a calendar: the visual only this report has
    s = slide(prs)
    title(
        s,
        f"Chỉ {met} trên {len(DAYS)} ngày đạt {vn(GOAL)} ml",
        "Mỗi ô là một ngày tháng 10: xanh là đạt mục tiêu, số là ml uống trong ngày.",
    )
    cell, gap = Inches(0.98), Inches(0.1)
    x0, y0 = M, Inches(2.55)
    for c, name in enumerate(["T2", "T3", "T4", "T5", "T6", "T7", "CN"]):
        text(s, x0 + c * (cell + gap), y0 - Inches(0.4), cell, Inches(0.3), name, 14, SHORT if c >= 5 else MUTED, c >= 5,
             PP_ALIGN.CENTER)  # fmt: skip
    for i, v in enumerate(DAYS):
        pos = FIRST_WEEKDAY + i
        cx, cy = x0 + (pos % 7) * (cell + gap), y0 + (pos // 7) * (Inches(0.78) + gap)
        box = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, cx, cy, cell, Inches(0.78))
        box.fill.solid()
        box.fill.fore_color.rgb = MET if v >= GOAL else REST
        plain(box)
        tf = box.text_frame
        tf.margin_left = tf.margin_top = Inches(0.08)
        tf.vertical_anchor = MSO_ANCHOR.TOP
        for j, (t, size, bold) in enumerate(
            [(str(i + 1), 12, False), (vn(v), 16, True)]
        ):
            p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
            p.alignment = PP_ALIGN.LEFT  # a shape centres its text by default
            r = p.add_run()
            r.text = t
            r.font.name, r.font.size, r.font.bold = FONT, Pt(size), bold
            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF) if v >= GOAL else INK
    rx = Inches(9.1)
    text(
        s,
        rx,
        Inches(2.4),
        Inches(3.5),
        Inches(1.6),
        f"{round(met / len(DAYS) * 100)}%",
        96,
        MET,
        True,
    )
    text(
        s, rx, Inches(3.95), Inches(3.4), Inches(0.9), "số ngày đạt mục tiêu", 18, MUTED
    )
    text(s, rx, Inches(4.9), Inches(3.4), Inches(1.6),
         f"Trung bình {vn(sum(DAYS) / len(DAYS))} ml mỗi ngày, thiếu {vn(GOAL - sum(DAYS) / len(DAYS))} ml so với mục tiêu.", 18)  # fmt: skip

    # 3. Weekends: the point in colour, the rest grey
    s = slide(prs)
    weekend = round((WEEKDAY_AVG["T7"] + WEEKDAY_AVG["CN"]) / 2)
    title(s, "Cuối tuần không ngày nào đạt mục tiêu",
          f"Trung bình mỗi ngày theo thứ, ml. Thứ 7 và chủ nhật chỉ khoảng {vn(round(weekend, -1))} ml.")  # fmt: skip
    names = list(WEEKDAY_AVG)
    bars(s, M, Inches(2.4), Inches(8.2), Inches(4.5), names, list(WEEKDAY_AVG.values()),
         [SHORT if n in ("T7", "CN") else REST for n in names], label_size=16)  # fmt: skip
    text(s, Inches(9.6), Inches(2.8), Inches(3.0), Inches(3.5),
         "0/9", 80, SHORT, True)  # fmt: skip
    text(
        s,
        Inches(9.6),
        Inches(4.15),
        Inches(3.0),
        Inches(0.5),
        "ngày cuối tuần đạt mục tiêu",
        18,
        MUTED,
    )
    text(s, Inches(9.6), Inches(5.0), Inches(3.0), Inches(1.6),
         f"Ngày thường trung bình {vn(2012)} ml; cuối tuần thiếu gần {vn(800)} ml mỗi ngày.", 18, spacing=1.15)  # fmt: skip

    # 4. Evenings
    s = slide(prs)
    total = sum(HOURS.values())
    late = sum(v for h, v in HOURS.items() if h >= 19)
    title(s, f"Sau 19 giờ chỉ {vn(late / total * 100)}% lượng nước của cả tháng",
          "Tổng ml theo giờ trong ngày, cả tháng 10.")  # fmt: skip
    hours = list(HOURS)
    bars(s, M, Inches(2.4), W - 2 * M, Inches(4.6), [f"{h}h" for h in hours], list(HOURS.values()),
         [SHORT if h >= 19 else REST for h in hours], label_size=13)  # fmt: skip

    # 5. What to do: two changes, each with how it is measured (no numbered circles)
    s = slide(prs)
    title(s, "Tháng 11: thử hai thay đổi, đo bằng số ngày đạt mục tiêu")
    col = (W - 2 * M - Inches(0.6)) / 2
    for i, (head, what, measure) in enumerate([
        ("Cuối tuần", "Nhắc theo giờ sinh hoạt cuối tuần, muộn hơn ngày thường 1 đến 2 giờ.", "Đạt khi cuối tuần có ít nhất 3 trên 8 ngày đủ nước."),
        ("Sau 16 giờ", "Thêm một lần nhắc lúc 17 giờ, khi lượng nước bắt đầu tụt.", "Đạt khi phần sau 19 giờ lên trên 12%."),
    ]):  # fmt: skip
        x = M + i * (col + Inches(0.6))
        rule = s.shapes.add_shape(
            MSO_SHAPE.RECTANGLE, x, Inches(2.2), col, Inches(0.06)
        )
        rule.fill.solid()
        rule.fill.fore_color.rgb = SHORT
        plain(rule)
        text(s, x, Inches(2.5), col, Inches(0.7), head, 32, bold=True)
        text(s, x, Inches(3.35), col, Inches(1.4), what, 22, spacing=1.15)
        text(s, x, Inches(4.75), col, Inches(0.4), "ĐO BẰNG", 13, MUTED, True)
        text(s, x, Inches(5.1), col, Inches(1.0), measure, 20, spacing=1.15)
    text(s, M, Inches(6.4), W - 2 * M, Inches(0.5),
         f"Còn chưa rõ: {vn(3450)} ml (6%) ghi là \"khác\". Cho người dùng chọn tên đồ uống thì tháng sau mới biết đó là gì.", 14, MUTED)  # fmt: skip

    prs.save(path)
    return path


if __name__ == "__main__":
    print(build())
