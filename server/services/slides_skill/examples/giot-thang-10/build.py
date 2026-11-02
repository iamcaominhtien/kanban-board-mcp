"""The example deck: Giọt's October report as a presentation, designed for the product (not from a theme).

What it shows, beside the themes: a face only this subject has (the month as 31 drops, each filled to what was drunk;
the day as a clock), a photo found on the web with its source and licence in the notes, a diagram drawn in HTML and
SVG, a cover animation made in HTML and recorded to MP4, a native chart with its point in colour, and everything made
from code that is kept, so a fix is one edit and one run.

    python build.py      # deck.html, assets/wave.mp4, deck.pptx, look/sheet.png

The data (the month's log) is worked out below before any slide is drawn.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parents[1] / "scripts"

DAYS = [1830, 1330, 1890, 750, 2470, 2230, 2910, 2730, 1980, 1250, 1900, 1230, 1310, 3580, 1000, 1910,
        1000, 1150, 2120, 1540, 1650, 2330, 2550, 500, 980, 2380, 1230, 1720, 2070, 2160, 1790]  # fmt: skip
FIRST_WEEKDAY = 3  # 1 October 2026 is a Thursday
GOAL = 2000
WEEKDAYS = {
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

INK, MUTED, WATER, LIGHT, PROBLEM, PAPER = (
    "#0B2233",
    "#5B6B78",
    "#2F7FD0",
    "#DCEBF7",
    "#E4572E",
    "#F7FAFC",
)


def vn(n: float, d: int = 0) -> str:
    """1.250 and 3,5: the reader's format."""
    return f"{n:,.{d}f}".replace(",", " ").replace(".", ",").replace(" ", ".")


def drop(ml: int, size: int = 64) -> str:
    """One day: a drop filled to what was drunk (full at the goal), its edge darker when the goal was met."""
    f = min(ml / GOAL, 1.0)
    h = 100 - 8 - 84 * f  # the water line, in the drop's 100-unit box
    met = ml >= GOAL
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 80 100"><defs><clipPath id="d{ml}{size}">'
        '<path d="M40 6 C40 6 10 48 10 66 a30 30 0 0 0 60 0 C70 48 40 6 40 6Z"/></clipPath></defs>'
        f'<path d="M40 6 C40 6 10 48 10 66 a30 30 0 0 0 60 0 C70 48 40 6 40 6Z" fill="{LIGHT}"/>'
        f'<rect x="0" y="{h:.1f}" width="80" height="100" fill="{WATER}" clip-path="url(#d{ml}{size})"/>'
        f'<path d="M40 6 C40 6 10 48 10 66 a30 30 0 0 0 60 0 C70 48 40 6 40 6Z" fill="none" '
        f'stroke="{INK if met else "#9DB4C6"}" stroke-width="{3 if met else 1.5}"/></svg>'
    )


def calendar() -> str:
    """The month as a calendar of drops, Monday first."""
    cells = []
    for c, name in enumerate(["T2", "T3", "T4", "T5", "T6", "T7", "CN"]):
        cells.append(f'<div class="wd{" we" if c >= 5 else ""}">{name}</div>')
    cells += ['<div class="day"></div>'] * FIRST_WEEKDAY
    for i, ml in enumerate(DAYS, 1):
        met = " met" if ml >= GOAL else ""
        cells.append(
            f'<div class="day{met}">{drop(ml)}<span class="d">{i}</span><span class="ml">{vn(ml)}</span></div>'
        )
    return '<div class="cal" data-pptx="picture">' + "".join(cells) + "</div>"


def dial() -> str:
    """The day as a 24-hour clock, midnight at the top: a bar per hour, as long as the month's total at that hour.
    The evening, from 19h, is shaded and its bars are red."""
    import math

    c, r0, longest = 280, 140, 118
    top = max(HOURS.values())

    def at(hour: float, r: float) -> tuple[float, float]:
        a = hour / 24 * 2 * math.pi - math.pi / 2
        return c + r * math.cos(a), c + r * math.sin(a)

    # the evening, 19h to midnight, as a pale band behind the bars
    x0, y0 = at(19, r0 + longest + 18)
    x1, y1 = at(24, r0 + longest + 18)
    xi, yi = at(24, r0 - 4)
    xj, yj = at(19, r0 - 4)
    R, r = r0 + longest + 18, r0 - 4
    parts = [
        f'<path d="M{x0:.1f} {y0:.1f} A{R} {R} 0 0 1 {x1:.1f} {y1:.1f} L{xi:.1f} {yi:.1f} A{r} {r} 0 0 0 {xj:.1f} '
        f'{yj:.1f}Z" fill="{PROBLEM}" fill-opacity=".08"/>',
        f'<circle cx="{c}" cy="{c}" r="{r0 - 4}" fill="none" stroke="#C9D9E6" stroke-width="2"/>',
    ]
    for h in range(24):  # a tick for every hour, so the empty night reads as empty
        a1, b1 = at(h + 0.5, r0 - 4)
        a2, b2 = at(h + 0.5, r0 + 4)
        parts.append(
            f'<line x1="{a1:.1f}" y1="{b1:.1f}" x2="{a2:.1f}" y2="{b2:.1f}" stroke="#C9D9E6" stroke-width="2"/>'
        )
    for h, ml in HOURS.items():
        a1, b1 = at(h + 0.5, r0 + 10)
        a2, b2 = at(h + 0.5, r0 + 10 + longest * ml / top)
        col = PROBLEM if h >= 19 else WATER
        parts.append(f'<line x1="{a1:.1f}" y1="{b1:.1f}" x2="{a2:.1f}" y2="{b2:.1f}" stroke="{col}" stroke-width="16" '
                     'stroke-linecap="round"/>')  # fmt: skip
    for h, label in ((0, "0h"), (6, "6h"), (12, "12h"), (18, "18h")):
        lx, ly = at(h, r0 - 30)
        parts.append(f'<text x="{lx:.1f}" y="{ly + 6:.1f}" text-anchor="middle" font-size="16" fill="{MUTED}" '
                     f'font-family="Be Vietnam Pro">{label}</text>')  # fmt: skip
    return f'<svg class="dial" width="560" height="560" viewBox="0 0 560 560">{"".join(parts)}</svg>'


def page() -> str:
    """The whole deck as one HTML file."""
    total, late = sum(HOURS.values()), sum(v for h, v in HOURS.items() if h >= 19)
    met = sum(d >= GOAL for d in DAYS)
    chart = {
        "type": "bar",
        "categories": list(WEEKDAYS),
        "series": {"ml mỗi ngày": list(WEEKDAYS.values())},
        "colors": ["C9D9E6"] * 5 + [PROBLEM[1:]] * 2,
        "labels": [vn(v) for v in WEEKDAYS.values()],
        "font": "Be Vietnam Pro",
        "size": 16,
        "muted": MUTED[1:],
        "gap": 40,
    }
    css = (HERE / "deck.css").read_text()
    return f"""<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Giọt · Tháng 10</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap">
<style>{css}</style></head><body>

<section class="slide cover">
  <div class="brand">giọt</div>
  <div class="eyebrow">Báo cáo tháng 10/2026</div>
  <h1>Tháng 10, cứ 3 ngày<br>mới có 1 ngày<br>uống đủ nước</h1>
  <p class="lede">{len(DAYS)} ngày, 184 lần uống, {vn(sum(DAYS))} ml. Mục tiêu {vn(GOAL)} ml mỗi ngày.</p>
  <video src="assets/wave.mp4" poster="assets/wave.png" autoplay loop muted></video>
  <aside class="notes">Mở bằng một câu: tháng này người dùng uống đủ nước được 11 trên 31 ngày. Giọt nước bên phải đầy
  một phần ba, đúng tỉ lệ đó.</aside>
</section>

<section class="slide month">
  <h2>Chỉ {met} trên {len(DAYS)} ngày đạt {vn(GOAL)} ml</h2>
  <p class="sub">Mỗi giọt là một ngày, đầy tới mức đã uống; viền đậm là ngày đạt mục tiêu.</p>
  {calendar()}
  <div class="side"><div class="big">{round(met / len(DAYS) * 100)}%</div><div class="cap">số ngày đạt mục tiêu</div>
  <p>Trung bình {vn(sum(DAYS) / len(DAYS))} ml mỗi ngày, thiếu {vn(GOAL - sum(DAYS) / len(DAYS))} ml.</p></div>
  <div class="footer"><span>Giọt · Tháng 10/2026</span><span>02</span></div>
</section>

<section class="slide week">
  <h2>Cuối tuần không ngày nào đạt mục tiêu</h2>
  <p class="sub">Trung bình mỗi ngày theo thứ, ml.</p>
  <div class="chart" data-pptx="chart" data-chart='{json.dumps(chart, ensure_ascii=False)}'></div>
  <div class="side"><div class="big problem">0/9</div><div class="cap">ngày cuối tuần đạt</div>
  <p>Thứ 7 và chủ nhật chỉ khoảng {vn(1240)} ml, thiếu gần {vn(800)} ml so với ngày thường.</p></div>
  <div class="footer"><span>Giọt · Tháng 10/2026</span><span>03</span></div>
</section>

<section class="slide clock">
  <h2>Sau 19 giờ, gần như không ai uống thêm nước</h2>
  {dial()}
  <div class="centre"><div class="big problem">{vn(late / total * 100)}%</div><div class="cap">lượng nước sau 19 giờ</div></div>
  <div class="side">
    <p><b>9h và 11h</b> là hai đỉnh: {vn(HOURS[9] + HOURS[11])} ml, gần 27% cả tháng.</p>
    <p><b>Từ 16h</b> lượng nước tụt một nửa, và không hồi lại.</p>
  </div>
  <div class="footer"><span>Giọt · Tháng 10/2026</span><span>04</span></div>
</section>

<section class="slide photo">
  <img class="pic" src="assets/glass.jpg" data-pptx="picture" alt="">
  <div class="eyebrow">Đề xuất</div>
  <h2>Thêm một ly lúc 17 giờ</h2>
  <p class="body">17 giờ là lúc lượng nước bắt đầu tụt và người dùng quên nhiều nhất. Một lần nhắc thêm, chỉ khi
  hôm đó còn thiếu, đủ kéo buổi chiều lên mà không làm phiền ai.</p>
  <aside class="notes">Ảnh: Unsplash, ảnh photo-1548839140-29a749e1cf4d (https://unsplash.com/photos/1548839140-29a749e1cf4d),
  giấy phép Unsplash: dùng miễn phí, kể cả thương mại.</aside>
</section>

<section class="slide flow">
  <h2>Giọt chỉ nhắc khi hôm đó còn thiếu</h2>
  <div class="steps">
    <div class="node"><div class="when">16:00</div><div class="what">Giọt xem hôm nay đã uống bao nhiêu</div></div>
    <div class="node ask"><div class="when">Kiểm tra</div><div class="what">Dưới 60% mục tiêu?</div></div>
    <div class="node act"><div class="when">17:00 · có</div><div class="what">Nhắc một ly 250 ml, kèm số còn thiếu</div></div>
  </div>
  <svg class="arrows" width="1104" height="60" viewBox="0 0 1104 60"><g stroke="{INK}" stroke-width="2" fill="none">
    <path d="M330 30 H380"/><path d="M372 22 L382 30 L372 38"/><path d="M714 30 H764"/><path d="M756 22 L766 30 L756 38"/></g></svg>
  <div class="no"><b>Không</b> Đã uống đủ 60%: hôm nay không nhắc thêm.</div>
  <div class="footer"><span>Giọt · Tháng 10/2026</span><span>06</span></div>
</section>

<section class="slide plan">
  <div class="eyebrow">Tháng 11</div>
  <h2>Thử hai thay đổi, đo bằng số ngày đạt mục tiêu</h2>
  <div class="cols">
    <div class="col"><h3>Nhắc lúc 17 giờ</h3><p>Chỉ khi hôm đó dưới 60% mục tiêu.</p>
      <div class="k"><b>12%</b>phần nước sau 19 giờ, từ {vn(late / total * 100)}% hôm nay</div></div>
    <div class="col"><h3>Lịch riêng cho cuối tuần</h3><p>Nhắc muộn hơn ngày thường 1 đến 2 giờ.</p>
      <div class="k"><b>3/8</b>ngày cuối tuần đạt, từ 0/9 tháng này</div></div>
  </div>
  <p class="foot">Còn chưa rõ: {vn(3450)} ml (6%) ghi là "khác". Cho người dùng chọn tên đồ uống thì tháng sau mới biết.</p>
  <div class="footer"><span>Giọt · Tháng 10/2026</span><span>07</span></div>
</section>
</body></html>"""


def record_wave(seconds: float = 6, fps: int = 30) -> None:
    """The cover's animation: wave.html drawn frame by frame at fixed times (smooth whatever the machine's speed),
    each frame a screenshot, then ffmpeg makes a looping MP4 and the first frame is its poster."""
    from playwright.sync_api import sync_playwright

    frames = HERE / ".frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir()
    with sync_playwright() as pw:
        b = (
            pw.chromium.launch(executable_path=_browser())
            if _browser()
            else pw.chromium.launch()
        )
        page = b.new_page(viewport={"width": 800, "height": 1040})
        page.goto((HERE / "assets" / "wave.html").as_uri() + "?record")
        for i in range(int(seconds * fps)):
            page.evaluate(f"drawAt({i * 1000 / fps})")
            page.screenshot(path=str(frames / f"{i:04d}.png"))
        b.close()
    shutil.copy(frames / "0000.png", HERE / "assets" / "wave.png")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames / "%04d.png"),
                    "-vf", "scale=400:520", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    str(HERE / "assets" / "wave.mp4")], check=True)  # fmt: skip
    shutil.rmtree(frames)


def _browser() -> str | None:
    import os

    return os.environ.get("CHROMIUM")


def main() -> None:
    """Build everything, in order."""
    (HERE / "deck.html").write_text(page())
    record_wave()
    sys.path.insert(0, str(SCRIPTS))
    import html_to_pptx
    import render

    html_to_pptx.convert(HERE / "deck.html", HERE / "deck.pptx", _browser())
    html_to_pptx.convert(HERE / "deck.html", HERE / "deck-office-fonts.pptx", _browser(),
                         swap={"Be Vietnam Pro": "Segoe UI"})  # fmt: skip
    way, pages = render.render(HERE / "deck.pptx", HERE / ".look")
    render.sheet(pages, HERE / "preview.jpg")
    print(way, len(pages))


if __name__ == "__main__":
    main()
