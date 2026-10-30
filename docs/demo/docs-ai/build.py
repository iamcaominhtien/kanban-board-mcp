"""Builds docs/demo/docs-ai-demo.pdf: the Docs AI demo (screenshots of the running app, real Claude Code answers).

    python3 docs/demo/docs-ai/build.py        # needs reportlab; reads images/ next to this file

The images are screenshots of the app running on a throwaway database with one AI member, "Reviewer", that is a real
Claude Code (Haiku) runner. The text is Vietnamese; button and page names stay in English as in the app.
"""

import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Frame, Image, KeepTogether, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle, Preformatted

HERE = Path(__file__).parent
IMG = HERE / "images"
OUT = HERE.parent / "docs-ai-demo.pdf"
VERSION = re.search(r'APP_VERSION = "([^"]+)"', (HERE.parents[2] / "server" / "version.py").read_text()).group(1)

FONTS = Path("/System/Library/Fonts/Supplemental")
pdfmetrics.registerFont(TTFont("Body", str(FONTS / "Arial.ttf")))
pdfmetrics.registerFont(TTFont("Body-Bold", str(FONTS / "Arial Bold.ttf")))
pdfmetrics.registerFont(TTFont("Body-Italic", str(FONTS / "Arial Italic.ttf")))
pdfmetrics.registerFont(TTFont("Body-BoldItalic", str(FONTS / "Arial Bold Italic.ttf")))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic", boldItalic="Body-BoldItalic")
try:
    pdfmetrics.registerFont(TTFont("Mono", "/System/Library/Fonts/Supplemental/Courier New.ttf"))
except Exception:  # noqa: BLE001
    pdfmetrics.registerFont(TTFont("Mono", str(FONTS / "Arial.ttf")))

GREEN = colors.HexColor("#2E6F40")
PURPLE = colors.HexColor("#6B5BD2")
INK = colors.HexColor("#1E2A22")
MUTED = colors.HexColor("#5B6B60")
PAGE_W, PAGE_H = landscape(A4)
M = 36

H1 = ParagraphStyle("h1", fontName="Body-Bold", fontSize=22, leading=26, textColor=INK, spaceAfter=4)
KICK = ParagraphStyle("kick", fontName="Body-Bold", fontSize=9, leading=11, textColor=PURPLE, spaceAfter=2)
P = ParagraphStyle("p", fontName="Body", fontSize=10.5, leading=15, textColor=INK, alignment=TA_LEFT, spaceAfter=5)
SMALL = ParagraphStyle("small", parent=P, fontSize=8.5, leading=11.5, textColor=MUTED)
CAP = ParagraphStyle("cap", parent=P, fontSize=8, leading=10.5, textColor=MUTED, spaceAfter=0)
B = ParagraphStyle("b", parent=P, leftIndent=11, bulletIndent=0, spaceAfter=3.5)
COVER = ParagraphStyle("cover", fontName="Body-Bold", fontSize=34, leading=38, textColor=INK)
MONO = ParagraphStyle("mono", fontName="Mono", fontSize=7.4, leading=9.2, textColor=INK)


def bullets(items):
    return [Paragraph(t, B, bulletText="•") for t in items]


def img(name, width):
    from PIL import Image as PI

    w, h = PI.open(IMG / name).size
    return Image(str(IMG / name), width=width, height=width * h / w)


def two_col(left, right, lw=520, rw=None):
    rw = rw or (PAGE_W - 2 * M - lw - 14)
    t = Table([[left, right]], colWidths=[lw + 8, rw + 6])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 14)]))
    return t


def shot(name, caption, width=520):
    box = Table([[img(name, width)], [Paragraph(caption, CAP)]], colWidths=[width])
    box.setStyle(TableStyle([("BOX", (0, 0), (0, 0), 0.6, colors.HexColor("#D5DDD8")), ("TOPPADDING", (0, 1), (0, 1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (0, 0), 0), ("TOPPADDING", (0, 0), (0, 0), 0)]))
    return box


def page(kicker, title, shots, text):
    """A page: kicker, title, screenshot(s) on the left, the explanation on the right."""
    out = [Paragraph(kicker.upper(), KICK), Paragraph(title, H1), Spacer(1, 6)]
    left = [shot(*s) for s in shots[:1]]
    right = text
    out.append(two_col(left[0], right))
    for extra in shots[1:]:
        out += [Spacer(1, 8), shot(*extra, width=380)]
    out.append(PageBreak())
    return out


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Body", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(M, 20, f"Kanban Board · Docs AI · v{VERSION} · demo chạy trên app thật với Claude Code (Haiku)")
    canvas.drawRightString(PAGE_W - M, 20, f"{doc.page}")
    canvas.restoreState()


story = []

# ---------------------------------------------------------------- cover
story += [
    Spacer(1, 70),
    Paragraph("DOCS AI · ISSUE #209", KICK),
    Paragraph("AI ở khắp Docs, và AI nhớ được cuộc trò chuyện", COVER),
    Spacer(1, 14),
    Paragraph(
        f"Phiên bản {VERSION}. Hỏi docs có trích dẫn, menu AI trên mỗi trang, Viết bằng AI, đề xuất từ AI member, @AI trong comment, "
        "giữ docs đúng với board, tạo ticket từ trang, và một tool MCP duy nhất cho đội AI.",
        ParagraphStyle("lead", parent=P, fontSize=13, leading=19, textColor=MUTED),
    ),
    Spacer(1, 18),
]
story += bullets(
    [
        "<b>Nguyên tắc xuyên suốt:</b> AI không bao giờ sửa trang đã xuất bản. Kết quả là khối viền đứt, bản nháp riêng, đề xuất hoặc danh sách để bạn duyệt; chỉ người mới xuất bản.",
        "<b>Mặc định tắt:</b> Docs AI chỉ bật khi admin bật cho project. Khi tắt, không có menu, tab Ask hay Docs health.",
        "<b>Riêng tư:</b> trang bị ẩn khỏi AI thì không AI nào đọc được: không phải Ask, không phải chat Board AI, không phải AI chạy trên ticket, không phải MCP.",
        "<b>Bộ nhớ:</b> hỏi lại về cùng một trang hoặc ticket thì chat tiếp tục, không mở chat mới; chat bằng API key tự tóm tắt tin cũ; tag AI lần hai trong cùng thread là tiếp tục cuộc trò chuyện.",
    ]
)
story += [Spacer(1, 16), Paragraph("Đây là bản demo của PR thêm Docs AI. Tất cả ảnh là ảnh chụp app đang chạy; câu trả lời của AI là thật, nên lần chạy sau có thể khác chữ.", SMALL), PageBreak()]

# ---------------------------------------------------------------- how
story += [
    Paragraph("CÁCH LÀM DEMO", KICK),
    Paragraph("Chạy thật, không dựng sẵn", H1),
    Spacer(1, 8),
]
story += bullets(
    [
        "Backend và UI chạy thật trên một cơ sở dữ liệu tạm, tách khỏi dữ liệu thật. Một project <b>Kanban Board</b> với 3 người, 4 ticket và 7 trang (Overview, Requirements › Auth, Architecture › API, Data model, Decision log, Meeting notes).",
        "Một AI member tên <b>Reviewer</b> là <b>Claude Code thật (Haiku)</b>, chạy qua CLI trên máy này. Vì dùng gói đăng ký nên mục chi phí ghi <i>Not metered</i>. Câu trả lời, trích dẫn, lý do 'lỗi thời' và bản nháp đều do mô hình viết.",
        "Dữ liệu được cài có chủ ý để lộ từng tính năng: trang API vẫn ghi 'Rate limits are not enforced yet' trong khi KAN-1 đã Done; Auth ghi token hết hạn sau 30 ngày còn Decision log ghi 90 ngày; Meeting notes có việc chưa tick.",
        "Khi chạy thử mình tìm thấy <b>2 lỗi thật</b> và đã sửa trước khi chụp: menu AI bị lệch trái và bị che sau cây trang; hộp thoại Create tickets treo ở 'Looking for unchecked items…' trong chế độ phát triển của React (StrictMode).",
        "Test tự động: 841 test server pass, 1 test fail sẵn trên nhánh gốc (<font name='Mono'>test_pause_stops_the_run_and_resume_continues_it</font>, không liên quan); 65 test UI; lint, typecheck và build sạch.",
    ]
)
story += [PageBreak()]

# ---------------------------------------------------------------- pages
story += page(
    "1 · Bật và kiểm soát",
    "Docs AI tắt cho đến khi admin bật",
    [("01-settings.jpg", "Settings › Docs › AI: công tắc, AI trả lời, AI được đọc gì, trang style guide, kiểm tra độ mới, cách xử lý sửa đổi của AI member.")],
    [Paragraph("<b>Settings › Docs › AI</b> nằm ngay dưới cài đặt Docs. Mặc định <b>Off</b>; khi tắt, mọi dòng bên dưới mờ đi và Docs không hiện dấu vết AI nào.", P)]
    + bullets(
        [
            "<b>AI that answers:</b> một AI member của project (Claude Code hoặc API key), nếu không chọn thì dùng Board AI.",
            "<b>What AI may read:</b> tất cả / trừ trang ẩn / chỉ trang được chọn.",
            "<b>Edits by AI members:</b> thành <i>Proposal to review</i> hoặc <i>Draft only</i>; đề xuất hết hạn sau 3 đến 30 ngày, hết hạn thì không đổi gì.",
            "Chỉ admin của project đổi được các cài đặt này; công tắc chung 'Docs AI' ở Settings › AI › Features vẫn là công tắc tổng.",
        ]
    ),
)
story += page(
    "1 · Bật và kiểm soát",
    "Ẩn một trang khỏi AI, hoặc dùng làm hướng dẫn",
    [("03-page-flags.jpg", "Thông tin trang › AI: Hide from AI và Use as AI guidance.")],
    [Paragraph("Trong <b>Page info</b> có hai ô, cho người có quyền sửa trang:", P)]
    + bullets(
        [
            "<b>Hide from AI:</b> Ask, tóm tắt, chat Board AI, AI chạy trên ticket và MCP đều bỏ qua trang này. Cây trang hiện ổ khóa. Một trang đã ẩn không thể là trang hướng dẫn.",
            "<b>Use as AI guidance:</b> mọi lần AI member chạy trong project đều đọc trang này (kiến trúc, quy ước). Mặc định giới hạn 8.000 token; trang dài bị cắt ở ranh giới mục. Trang được đọc hiện trong bước <i>Read</i> của lần chạy.",
        ]
    )
    + [Paragraph("Quy tắc được ép ở <b>một chỗ</b> (<font name='Mono'>services/docs_ai/access.py</font>); có test cho Ask, chat, run và MCP.", SMALL)],
)
story += page(
    "2 · Menu AI trên mỗi trang",
    "Một nút AI, nằm cạnh Comments và Share",
    [("02-ai-menu.jpg", "Menu AI: liệt kê việc AI làm được, nói rõ nó đọc gì và tốn bao nhiêu, chưa chạy gì cho đến khi bạn chọn.")],
    [Paragraph("Menu chỉ xuất hiện khi Docs AI bật. Mỗi dòng nói rõ việc nó làm; chân menu ghi <b>Reads</b> (trang này, 3 ticket, 1 trang liên kết) và chi phí dự kiến.", P)]
    + bullets(
        [
            "Người chỉ xem vẫn dùng được Ask, Summarise, Check và Translate; các dòng ghi (Edit with AI, Create tickets) bị ẩn.",
            "Trang bị ẩn khỏi AI: hiện ổ khóa và một dòng lý do. Chưa có AI member nào đọc được space: một dòng mở danh sách AI members.",
            "Dòng lỗi lúc đầu: menu bị lệch trái và bị che. Đã sửa (neo mép trái của nút).",
        ]
    ),
)
story += page(
    "3 · Hỏi docs",
    "Ask: câu trả lời có nguồn, kiểm tra được",
    [("07-ask-answer.jpg", "Tab Ask trong palette tìm kiếm: câu trả lời, SOURCES, chân trang 'Read 2 pages, cited 1'.")],
    [Paragraph("Tab <b>Ask</b> nằm trong palette tìm kiếm quen thuộc (Search vẫn là mặc định, Ask không bao giờ tự chạy). Phạm vi: <b>This space / This page / All my projects</b>.", P)]
    + bullets(
        [
            "AI chỉ đọc trang <b>đã xuất bản</b> mà người hỏi thấy được, và trích dẫn từng mục. Server <b>kiểm tra lại</b> mọi trích dẫn: trang có đọc không, mục có tồn tại không, câu trích có thật nằm trong mục đó không. Trích dẫn sai bị bỏ.",
            "Câu hỏi không khớp trang nào thì <b>không gọi mô hình</b>, nên không tốn phí.",
            "Chân trang: số trang đã đọc, số trang được trích, độ mới của chỉ mục, chi phí. Nút <i>Open as chat</i>, <i>Copy</i>, <i>Was this right?</i>.",
        ]
    ),
)
story += page(
    "3 · Hỏi docs",
    "Khi hai trang mâu thuẫn, nó nói rõ và không chọn bên nào",
    [("08-ask-disagree.jpg", "Hỏi 'How long does a token last?' trên cả space: Decision log nói 90 ngày, Requirements › Auth nói 30 ngày.")],
    [Paragraph("Dữ liệu mẫu cố ý có hai con số khác nhau. Claude Code thật phát hiện ra:", P)]
    + bullets(
        [
            "Kết quả <b>Two pages disagree</b> với cả hai nguồn và ngày sửa, kèm câu 'The docs do not say which one is current'.",
            "Nút <b>Report Auth as out of date</b> thêm vào Docs health, không sửa gì.",
            "Nếu không có trang nào trả lời, kết quả là <i>the docs do not say</i> kèm các trang gần nhất, và có nút soạn một trang từ câu hỏi đó.",
        ]
    ),
)
story += page(
    "3 · Hỏi docs",
    "Trang ẩn thì AI không đọc, và câu trả lời đổi theo",
    [("16-hidden-ask.jpg", "Sau khi bật Hide from AI cho Decision log, cùng câu hỏi chỉ còn Auth; Decision log có ổ khóa trong cây.")],
    [Paragraph("Cùng câu hỏi như trang trước, nhưng sau khi ẩn <b>Decision log</b>:", P)]
    + bullets(
        [
            "Số trang đã đọc giảm (4 xuống 3) và câu trả lời chỉ còn dựa trên Auth. Không có dấu hiệu nào cho thấy một trang ẩn đã bị đọc.",
            "Cũng đúng với chat Board AI, AI chạy trên ticket (kể cả trang liên kết) và <font name='Mono'>docs_read</font> của MCP khi chạy trong một AI run.",
        ]
    ),
)
story += page(
    "4 · Giữ docs đúng",
    "Banner: 'trang này có thể đã lỗi thời', mỗi lý do nêu rõ đã so sánh gì",
    [("04-freshness-banner.jpg", "Trang API sau khi KAN-1 chuyển sang Done: hai lý do, mỗi lý do trích câu trên trang và nêu đã so với ticket nào.")],
    [Paragraph("Kiểm tra độ mới so sánh trang đã xuất bản với <b>ticket và trang nó liên kết</b>: trạng thái, tiêu đề, comment gần đây.", P)]
    + bullets(
        [
            "Chỉ hỏi mô hình khi thứ trang phụ thuộc <b>đã đổi sau khi xuất bản</b>. Một trang không bao giờ bị đánh dấu chỉ vì cũ.",
            "Mỗi lý do phải trích một câu thật sự có trên trang, và ticket nó nêu phải tồn tại; lý do không kiểm chứng được bị bỏ.",
            "Banner chỉ hiện cho người có quyền sửa. <i>Still correct</i> ẩn 30 ngày, và chỉ hiện lại khi thứ trang phụ thuộc đổi.",
        ]
    ),
)
story += page(
    "4 · Giữ docs đúng",
    "Docs health: một danh sách cho cả space",
    [("13-docs-health.jpg", "Out of date, Missing docs, Broken links, Overlaps. Kèm 'How it decides' và 'What it never does'.")],
    [Paragraph("Dòng <b>Docs health</b> trong cây có số đếm. Bốn mục:", P)]
    + bullets(
        [
            "<b>Out of date:</b> từ các lần kiểm tra độ mới (Review mở đề xuất; Dismiss: lần này, 30 ngày hoặc không bao giờ).",
            "<b>Missing docs:</b> ticket Done mà không trang nào nhắc tới.",
            "<b>Broken links</b> và <b>Overlaps:</b> tính xác định, không gọi mô hình.",
            "Chạy mỗi ngày và khi bấm Run now; bản tin thứ Hai dùng chung bản tin sức khỏe board.",
        ]
    ),
)
story += page(
    "5 · Đề xuất của AI member",
    "'Review suggested edits' tạo đề xuất, không sửa trang",
    [("05-suggested-edits.jpg", "Banner độ mới đã mở 'Suggested edits' và banner tím 'Reviewer proposed 2 changes'. Chấm tím trên trang API trong cây.")],
    [Paragraph("Đề xuất tạo từ kiểm tra độ mới (hoặc từ một AI member gọi <font name='Mono'>docs_write</font>) <b>không chạm vào trang đã xuất bản</b>.", P)]
    + bullets(
        [
            "Banner: 'Reviewer (Claude Code) proposed 2 changes to this page · asked by the board owner · expires in 7 days'.",
            "Chấm tím trong cây, một dòng trong Approvals và một thông báo.",
            "AI không tự duyệt đề xuất của mình; người xem không duyệt được.",
        ]
    ),
)
story += page(
    "5 · Đề xuất của AI member",
    "Duyệt từng thay đổi; chấp nhận chỉ đi vào bản nháp của bạn",
    [("06-proposal-review.jpg", "Panel 'Proposed changes · 2': Accept, Reject, Edit từng thay đổi; Accept all, Reject all.")],
    [Paragraph("Mỗi thay đổi hiện chữ cũ gạch đỏ, chữ mới xanh, và lý do.", P)]
    + bullets(
        [
            "<b>Accept</b> ghi vào <b>bản nháp của người duyệt</b>. Mình đã thử: sau khi nhận thay đổi 1, bản nháp có câu mới còn trang đã xuất bản giữ nguyên; việc xuất bản vẫn là của người.",
            "Nếu trang đã đổi (vN → vM) mà đoạn cũ không còn thì thay đổi bị đánh dấu <i>Needs a new look</i> và không nhận được.",
            "Đề xuất chưa được đánh dấu trực tiếp trong thân trang: hiện là danh sách cũ → mới ở panel bên phải.",
        ]
    ),
)
story += page(
    "6 · @AI trong comment",
    "Tag AI trong thread Docs, nó trả lời ngay trong thread",
    [("09-thread-ai.jpg", "Thread gắn vào câu 'Rate limits are not enforced yet.': người hỏi, Reviewer (nhãn AI) trả lời.")],
    [Paragraph("Trước đây tag AI trong comment Docs chỉ gửi thông báo. Giờ AI trả lời trong thread, có nhãn AI, nguồn và chi phí.", P)]
    + bullets(
        [
            "Lần tag đầu: 'No, it is out of date…', có nút <i>Suggest an edit</i> biến câu trả lời thành đề xuất.",
            "<b>Tag lần hai trong cùng thread là tiếp tục</b>: mình hỏi 'Which ticket did I ask about in my first message?' và nó trả lời đúng KAN-1. Hai lần chạy dùng <b>cùng một session id</b> của Claude Code.",
            "AI không bao giờ resolve thread, và không trả lời trả lời của một AI khác (không vòng lặp).",
            "Khi gửi comment có tag AI, hộp thoại hỏi: Ask / Ask and suggest an edit / Just notify.",
        ]
    ),
)
story += page(
    "7 · Viết bằng AI",
    "Trang mới từ ticket, mở ra là bản nháp riêng với chỗ thiếu được đánh dấu",
    [("11-write-editor.jpg", "Bản nháp 'Drafted with AI from KAN-4 · only you see it': marker Needs input, GAPS · 9, SOURCES.")],
    [Paragraph("Viết từ <b>KAN-4</b> (Export activity log to CSV), loại Spec. AI chỉ viết từ nguồn bạn chọn (mô tả ticket và 1 comment).", P)]
    + bullets(
        [
            "Hộp thoại có danh sách <b>What will be sent</b> và chi phí trước khi viết; thay đổi code mặc định tắt.",
            "Chỗ nguồn không nói thì AI để <b>[Needs input: …]</b> (9 chỗ) thay vì đoán, và liệt kê trong GAPS. Câu nào có nguồn đều có [n].",
            "Trang chỉ là bản nháp của riêng bạn, chưa xuất bản (version 0).",
        ]
    ),
)
story += page(
    "7 · Viết bằng AI",
    "Xuất bản cảnh báo khi còn marker",
    [("12-publish-warning.jpg", "Hộp thoại Publish: gợi ý ghi chú thay đổi, và '9 Needs input markers are still in this draft'.")],
    [Paragraph("Hộp thoại Publish có <b>Suggest a note</b> (gợi ý ghi chú từ thay đổi của bạn) và cảnh báo khi bản nháp còn marker:", P)]
    + bullets(
        [
            "<i>Go to marker</i> nhảy tới chỗ còn thiếu; <i>Publish anyway</i> vẫn cho xuất bản.",
            "Phiên bản xuất bản từ một bản nháp có chữ AI được đánh dấu <b>with AI</b> trong History; bản thân trang không bị đóng dấu.",
            "Import Markdown có tuỳ chọn dọn khi import (tách theo heading, sửa cấp heading, gợi ý 'see X' → [[link]] để bạn xem lại).",
        ]
    ),
)
story += page(
    "8 · Từ trang sang ticket",
    "Việc chưa tick thành bản nháp ticket để duyệt",
    [("14-tickets-from-page.jpg", "Meeting notes: hai việc chưa tick thành hai ticket nháp; 'Drop the v1 export' đã tick nên bị bỏ.")],
    [Paragraph("Chưa có gì được tạo trước khi bạn bấm nút.", P)]
    + bullets(
        [
            "Người được nhắc tên trong dòng chỉ được <b>gợi ý</b> làm người nhận (Hoa Mai, Tuan Vo), không bao giờ tự gán. Hạn 'due Friday' được hiểu thành Fri, Oct 30.",
            "Việc đã tick hoặc đã có ticket bị bỏ và hộp thoại nói rõ lý do.",
            "Ticket vào cột Backlog (chọn được), liên kết với trang, và mã ticket được thêm vào <b>bản nháp</b> của bạn.",
        ]
    ),
)
story += page(
    "8 · Từ trang sang ticket",
    "Tạo xong có Undo; trang đã liên kết hai ticket",
    [("15-tickets-created.jpg", "'2 tickets created in Backlog · Undo'; mục Referenced by liệt kê KAN-5 và KAN-6.")],
    [Paragraph("Sau khi bấm <b>Create 2 tickets</b>:", P)]
    + bullets(
        [
            "Toast có <b>Undo</b>; Undo xoá hai ticket và khôi phục bản nháp nếu bạn chưa sửa thêm.",
            "Trang hiện 'Unpublished changes': các mã ticket nằm trong bản nháp, trang đã xuất bản không đổi.",
            "Giới hạn: Undo giữ trong bộ nhớ 30 phút, mất khi server khởi động lại. Mã ticket được <i>thêm vào cuối dòng</i> chứ không thay thế dòng.",
        ]
    ),
)
story += page(
    "9 · Khi đọc và khi soạn",
    "Tóm tắt là khối viền đứt, không thuộc về trang",
    [("17-summary-block.jpg", "SUMMARY · AI · not part of the page · not metered; Hide, Copy.")],
    [Paragraph("<b>Summarise</b> hiện khối viền đứt phía trên trang. Nó không được lưu; chỉ khi sửa trang mới có <i>Insert at top</i>.", P)]
    + bullets(
        [
            "Bôi chọn chữ khi đọc cho <b>Explain / Summarise / Ask…</b>; Explain từ chối đoạn không có trên trang.",
            "Kết quả thật của Claude Code với câu 'Every route requires a bearer token': giải thích và nói 'The page does not say what happens if a request is made without a token'.",
        ]
    ),
)
story += page(
    "9 · Khi đọc và khi soạn",
    "Translate view: đổi ngôn ngữ để đọc, trang không đổi",
    [("18-translate-view.jpg", "'Showing a Vietnamese translation by AI. The page is not changed.' Show original.")],
    [Paragraph("Bản dịch chỉ là cách xem. Code, link, <font name='Mono'>[[Auth#Rotation]]</font> và mã ticket giữ nguyên từng byte: server che chúng trước khi gửi và kiểm tra lại sau khi nhận; khối nào mất thì dùng lại chữ gốc.", P)]
    + bullets(
        [
            "Trang dài được cắt theo mục (Choose a section).",
            "Lần dịch trong demo: 0 khối phải quay về bản gốc.",
        ]
    ),
)
story += page(
    "9 · Khi đọc và khi soạn",
    "Check this page trong editor",
    [("19-check-this-page.jpg", "/ai › Check this page: 4 findings (Unclear, Missing) trên trang Auth, mỗi cái có Fix as draft và Ignore.")],
    [Paragraph("Đọc trang và trang style guide của project, chỉ liệt kê vấn đề. 'Nothing is changed.'", P)]
    + bullets(
        [
            "Link không tồn tại được tìm <b>không cần mô hình</b> và gợi ý trang hoặc mục gần nhất.",
            "Phát hiện của mô hình chỉ giữ lại nếu câu trích thật sự có trong trang.",
            "<b>Fix as draft</b> hiện một diff nhỏ (Tab chấp nhận, Esc bỏ) và chỉ thay chữ trong bản nháp; Ignore ẩn phát hiện cho trang đó.",
            "Chưa làm: 'Draw a diagram' chưa vẽ được; dòng này báo chưa có.",
        ]
    ),
)

# ---------------------------------------------------------------- memory
story += [
    Paragraph("10 · BỘ NHỚ HỘI THOẠI", KICK),
    Paragraph("Mỗi lần hỏi không còn là một lần 'mới'", H1),
    Spacer(1, 6),
    Paragraph("Bạn từng phải yêu cầu sửa lại vì mỗi lần tag hay hỏi AI là một cuộc trò chuyện mới, và chat không có nén. Đây là cái đã kiểm tra trong code và cái đã sửa:", P),
]
rows = [
    ["Tình huống", "Trước", "Bây giờ"],
    ["Chat Board AI bằng API key", "Chỉ dán 14 tin cuối (mỗi tin cắt 1.500 ký tự), tin cũ mất, câu hỏi bị gửi hai lần, tin lỗi lẫn vào", "Tin cũ được tóm tắt vào chat (hiện 'Earlier messages summarised'), câu hỏi gửi một lần, tin lỗi/dừng bị loại"],
    ["'Ask this page', hỏi về ticket", "Luôn mở chat mới (fresh:true)", "Tiếp tục chat gần nhất về trang/ticket đó (không giới hạn thời gian, tóm tắt tự động giữ cho gọn); nút '+' mới bắt đầu chat mới; đổi phạm vi thì có dòng ngăn cách"],
    ["Thread comment Docs", "Tag AI chỉ gửi thông báo", "AI trả lời; thread là bộ nhớ; thread dài được tóm tắt; Claude Code dùng lại session theo (thread, AI)"],
    ["AI member bằng API key trên ticket", "Mỗi lần chạy bắt đầu từ đầu, không có khối Activity, trả lời câu hỏi xong thì mất việc đã làm", "Có khối 'Activity since your last run'; giữ việc đã làm khi được trả lời; nén khi run dài (bước 'Long session compacted')"],
    ["Claude Code", "Đã có phiên theo ticket và auto-compact (3.11.0)", "Không đổi; chat Board AI và thread Docs dùng thêm session"],
]
t = Table([[Paragraph(c, ParagraphStyle("c", parent=P, fontSize=8.8, leading=12, spaceAfter=0, fontName="Body-Bold" if i == 0 else "Body")) for c in r] for i, r in enumerate(rows)], colWidths=[150, 300, 300])
t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF3EF")), ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D5DDD8")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
story += [Spacer(1, 6), t, Spacer(1, 8)]
names = [
    "test_summary_kicks_in_and_the_question_is_sent_once",
    "test_summary_is_fenced_and_reused_on_the_next_turn",
    "test_failed_stopped_and_empty_turns_are_not_sent_again",
    "test_chat_about_a_page_or_ticket_continues_and_fresh_starts_over",
    "test_switching_scope_adds_a_divider_and_it_reaches_the_prompt",
    "test_claude_code_keeps_its_session_and_is_not_summarised",
    "test_a_second_tag_continues_the_conversation  (thread)",
    "test_a_long_thread_is_summarised  (thread)",
]
story += [Paragraph("Bằng chứng: các test này pass trên bản này (<font name='Mono'>test_ai_chat_memory.py</font>, <font name='Mono'>test_docs_ai_threads.py</font>, <font name='Mono'>test_ai_api_continuity.py</font>). Trong demo thật, lần tag thứ hai trong thread dùng đúng session id của lần đầu và trả lời đúng điều đã hỏi trước đó.", SMALL), Preformatted("\n".join(names), MONO), PageBreak()]

# ---------------------------------------------------------------- MCP
mcp_text = (HERE / "mcp-ai-team-output.txt").read_text()
mcp_text = mcp_text.split("### ai_team usage")[0].strip()
lines = [ln for ln in mcp_text.splitlines() if ln.strip()]
mcp_text = "\n".join((ln if len(ln) <= 96 else ln[:93] + "...") for ln in lines[:34]) + "\n  …"
story += [
    Paragraph("11 · MCP", KICK),
    Paragraph("Một tool duy nhất cho đội AI: <font name='Mono'>ai_team</font>", H1),
    Spacer(1, 6),
]
left = [Preformatted(mcp_text, MONO)]
right = [Paragraph("Bạn không muốn nhiều tool MCP, nên chỉ thêm <b>một</b> tool (tool thứ 12, mô tả ngắn, giới hạn kích thước danh sách tool chỉ nâng đúng bằng phần của nó: 2.612 ký tự).", P)] + bullets(
    [
        "<b>Đọc:</b> <font name='Mono'>members</font> (trạng thái, chi tiêu), <font name='Mono'>member</font>, <font name='Mono'>usage</font>, <font name='Mono'>runs</font>, <font name='Mono'>run</font> (các bước, file, câu hỏi, chi phí), <font name='Mono'>approvals</font> (chỉ đọc), <font name='Mono'>docs_jobs</font>.",
        "<b>Làm:</b> <font name='Mono'>ask</font> (ticket, trang Docs hoặc thread; Ask hoặc Work), <font name='Mono'>cancel / retry / answer</font>, <font name='Mono'>pause / resume</font>, <font name='Mono'>create_member / update_member</font>.",
        "Qua MCP không đặt được API key, thư mục, Bypass permissions hay mức ceiling trên Review. Bên trong một AI run chỉ đọc được; duyệt approval chỉ trong giao diện.",
        "Bên trái là kết quả thật: một lệnh <font name='Mono'>ask</font> trên KAN-2 đã chạy bằng Claude Code thật (xem <font name='Mono'>run</font> với các bước). @mention trong comment gửi qua MCP vẫn <b>không</b> đánh thức AI; dùng <font name='Mono'>ai_team ask</font>.",
    ]
)
story += [two_col(left, right, lw=470), PageBreak()]

# ---------------------------------------------------------------- limits
story += [
    Paragraph("12 · TRUNG THỰC VỀ GIỚI HẠN", KICK),
    Paragraph("Đã kiểm tra gì, chưa làm gì", H1),
    Spacer(1, 6),
    Paragraph("<b>Đã xem chạy thật trong giao diện (ảnh ở trên):</b> Settings, cờ trang, menu AI, Ask (3 trường hợp), banner độ mới, đề xuất, @AI trong thread, Viết bằng AI, cảnh báo xuất bản, Docs health, tạo ticket từ trang, tóm tắt, dịch, Check this page.", P),
    Paragraph("<b>Chỉ kiểm tra bằng test server và API (chưa xem trong giao diện):</b> import có dọn, tóm tắt lịch sử, digest 'changes since you last viewed', danh sách chọn @AI và hộp thoại chọn ý định trong comment, dấu nén trong dock chat, chat bằng API key (dùng mô hình giả trong test), proposals từ <font name='Mono'>docs_write</font> của AI member, hết hạn đề xuất.", P),
    Spacer(1, 4),
]
story += bullets(
    [
        "<b>Chưa làm:</b> 'Draw a diagram' (dòng báo chưa có); đánh dấu đề xuất trực tiếp trong thân trang; liên kết 'Review on page' trong danh sách Approvals; hiển thị các dòng Docs trong bản tin tuần của Board trên giao diện; Undo tạo ticket sống qua lần khởi động lại server.",
        "<b>Khác thiết kế:</b> mã ticket được thêm vào cuối dòng việc chứ không thay dòng; các ô tuỳ chọn dọn khi import mặc định không tick (thiết kế tick sẵn 3 ô); [n] trong bản nháp là chữ thường chứ chưa là chỉ số trên.",
        "<b>Quyết định cần bạn xem:</b> <font name='Mono'>answer</font> được mở qua MCP cho người đang hỏi (đổi thành chỉ giao diện nếu muốn); người chỉ xem không chạy được kiểm tra độ mới.",
        "<b>PR:</b> theo yêu cầu của bạn đây là PR mới, nhắm vào nhánh của #208 (thiết kế) để diff chỉ có code; issue #209 ghi 'code vào cùng PR #208'.",
        "Hai test fail sẵn trên nhánh gốc (<font name='Mono'>test_ai_cost…ranges…</font> phụ thuộc giờ trong ngày, <font name='Mono'>test_pause_stops_the_run…</font>) không liên quan; lần chạy cuối chỉ còn lại test thứ hai.",
    ]
)

doc = BaseDocTemplate(str(OUT), pagesize=landscape(A4), leftMargin=M, rightMargin=M, topMargin=M, bottomMargin=36, title="Docs AI demo", author="Kanban Board")
doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(M, 36, PAGE_W - 2 * M, PAGE_H - M - 36, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)], onPage=footer)])
doc.build(story)
print("wrote", OUT)
