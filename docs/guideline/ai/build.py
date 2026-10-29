"""Builds the AI guideline PDF (Vietnamese).

    python3 build.py        # writes huong-dan-dung-ai.pdf next to this file

Text, prompt samples and tables are in this file; screenshots are in images/ (JPEG or PNG, named as in fig()).
The version on the cover and in the footer comes from server/version.py. See ../README.md before editing.
"""
import base64
import html
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PDF = HERE / "huong-dan-dung-ai.pdf"
VERSION = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', (ROOT / "server" / "version.py").read_text(encoding="utf-8")).group(1)

_img_cache: dict[str, str] = {}


def img(name: str) -> str:
    """Screenshot images/<name>.jpg (or .png) as a data URI, so the HTML is one file."""
    if name not in _img_cache:
        for ext, mime in ((".jpg", "image/jpeg"), (".png", "image/png")):
            path = HERE / "images" / (name + ext)
            if path.exists():
                _img_cache[name] = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
                break
        else:
            raise FileNotFoundError(f"images/{name}.jpg is missing")
    return _img_cache[name]


def fig(key: str, caption: str, width: str = "86%") -> str:
    return (
        f'<figure style="width:{width}"><img src="{img(key)}" alt=""/>'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def prompt(label: str, text: str, limit: int | None = None) -> str:
    n = len(text)
    if limit is not None:
        assert n <= limit, (label, n, limit)
    meta = f"{n} ký tự" + (f" / tối đa {limit}" if limit else "")
    return (
        f'<div class="prompt"><div class="prompt-h"><span>{html.escape(label)}</span>'
        f"<span>{meta}</span></div><pre>{html.escape(text)}</pre></div>"
    )


def callout(kind: str, title: str, body: str) -> str:
    return f'<div class="callout {kind}"><b>{title}</b><div>{body}</div></div>'


def table(head: list[str], rows: list[list[str]], cls: str = "") -> str:
    th = "".join(f"<th>{h}</th>" for h in head)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'


def section(num: str, title: str, lead: str, body: str) -> str:
    cls = "sec newpage" if num == "12" else "sec"
    return (
        f'<section class="{cls}"><div class="kicker">PHẦN {num}</div><h1>{title}</h1>'
        f'<p class="lead">{lead}</p>{body}</section>'
    )


def ol(items: list[str]) -> str:
    return "<ol>" + "".join(f"<li>{i}</li>" for i in items) + "</ol>"


def ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


# ---------------------------------------------------------------------------------------------- content

PERSONA_DEV = """Bạn là Backend Dev của dự án này. Làm đúng phạm vi ticket, thay đổi nhỏ và có chủ đích.
Quy trình: đọc ticket và file liên quan, viết hoặc sửa test trước nếu được, sửa code, chạy test, rồi đối chiếu từng acceptance criteria.
Không sửa file ngoài thư mục /server trừ khi ticket nói rõ. Không đổi tên hay xoá API đang dùng.
Thiếu thông tin hoặc có hai cách hiểu: hỏi lại, đừng đoán.
Kết thúc bằng một comment ngắn: đã đổi gì, ở file nào, kết quả test, điều còn nghi ngờ."""

PERSONA_REVIEWER = """Bạn là Reviewer. Bạn chỉ đọc và nhận xét, không sửa code.
Với ticket ở Review: kiểm tra từng acceptance criteria một và nêu bằng chứng (file, dòng, kết quả test).
Tìm lỗi logic, trường hợp biên bị bỏ sót, test còn thiếu, chỗ làm hỏng hành vi cũ.
Trả lời theo mẫu: mỗi tiêu chí một dòng "đạt", "chưa đạt" hoặc "chưa rõ" kèm lý do, rồi tối đa 3 việc cần sửa quan trọng nhất.
Không bàn về style nếu nó không gây lỗi."""

PERSONA_TRIAGE = """Bạn là Triage của dự án. Với mỗi ticket được giao:
1) Đọc ticket. Nếu mô tả mơ hồ, comment 2 đến 3 câu hỏi cụ thể cho người tạo.
2) Đề xuất priority và estimate, mỗi cái kèm một dòng lý do.
3) Nếu ticket trùng ý với ticket khác, nêu mã ticket đó.
Chỉ comment. Không đổi trạng thái, không đổi người được giao, không sửa nội dung ticket."""

INSTR_SAMPLE = """# Quy ước dự án
- Backend: FastAPI trong /server. UI: React + Vite trong /ui.
- Chạy test backend: `cd server && uv run pytest -q`
- Kiểm tra UI: `cd ui && npx tsc --noEmit`
- Không đụng vào file .env, thư mục /docs và các migration đã có.
- Commit message theo dạng `fix(phạm-vi): mô tả ngắn`. Chỉ commit khi ticket yêu cầu.
- Khi làm xong, comment tóm tắt trên ticket bằng tiếng Việt."""

TICKET_BAD = """Tiêu đề: Fix login
Mô tả: Login bị lỗi, sửa giúp."""

TICKET_GOOD = """Tiêu đề: Đăng nhập trả lỗi 500 khi email có chữ hoa

## Bối cảnh
Người dùng nhập Test@Mail.com thì nhận lỗi 500, nhập test@mail.com thì vào bình thường.
Log: "KeyError: 'test@mail.com'" ở server/services/auth.py, hàm find_user.

## Việc cần làm
- So sánh email không phân biệt hoa thường khi tìm user (chuẩn hoá về chữ thường).
- Giữ nguyên định dạng email đã lưu trong DB.

## Ngoài phạm vi
- Không đổi schema DB, không đụng tới luồng đăng ký.

## Cách kiểm tra
- `uv run pytest tests/test_auth.py -q`

Acceptance criteria (ô riêng của ticket):
[ ] Đăng nhập với Test@Mail.com và test@mail.com đều thành công
[ ] Có test mới cho email viết hoa
[ ] Toàn bộ tests/test_auth.py vẫn xanh"""

EXTRA_EXAMPLES = [
    ("Giới hạn phạm vi", "Chỉ sửa server/services/orders.py và test tương ứng. Chạy `pytest tests/test_orders.py -q` trước khi báo cáo."),
    ("Làm theo mẫu có sẵn", "Làm giống cách ticket KAN-12 đã phân trang bằng cursor (xem file server/api/tickets.py). Đừng thêm thư viện mới."),
    ("Xin xác nhận trước khi sửa", "Trước khi sửa, hãy hỏi mình hướng làm: nêu 2 phương án, nói bạn khuyên phương án nào và vì sao. Chờ mình chọn rồi mới làm."),
    ("Chỉ phân tích, chưa làm", "Chưa sửa gì cả. Đọc code và viết vào comment: nguyên nhân có khả năng nhất, file liên quan, và kế hoạch sửa 3 bước."),
    ("Sửa theo nhận xét (sau Request changes)", "Làm lại theo nhận xét của mình ở comment mới nhất. Giữ nguyên phần đã đạt, chỉ sửa chỗ mình nêu."),
]

MENTION_EXAMPLES = [
    ("Ask", "@Reviewer hàm apply_discount có xử lý số lượng âm không? Chỉ trả lời, đừng sửa gì."),
    ("Do the work", "@Backend Dev làm tiếp phần phân trang theo mô tả ở trên, nhớ chạy test."),
    ("Just notify", "@Backend Dev FYI: mình đã đổi tên cột email thành contact_email ở migration mới."),
]

BOARD_PROMPTS = [
    ("Toàn dự án", "Ticket nào đang bị chặn (blocked) và đang chờ ai? Xếp theo mức ưu tiên."),
    ("Toàn dự án", "Tóm tắt tiến độ cho buổi họp sáng mai: đã xong tuần này, đang làm, rủi ro."),
    ("Toàn dự án", "Ticket nào ở In Progress hơn 3 ngày mà chưa có cập nhật?"),
    ("Một ticket", "Giải thích ticket này cho người mới vào: mục tiêu, file hoặc module liên quan, việc còn lại."),
    ("Một ticket", "Acceptance criteria đã đủ chưa? Còn thiếu trường hợp biên nào cần thêm?"),
    ("Một trang Docs", "Tóm tắt trang này thành 5 gạch đầu dòng, nêu rõ quyết định đã chốt và việc còn mở."),
]

STYLE_GUIDE = """Trả lời bằng tiếng Việt, ngắn gọn.
Mã ticket viết dạng KAN-12. Tiêu đề ticket bắt đầu bằng động từ.
Mô tả ticket có 3 mục: Bối cảnh, Việc cần làm, Cách kiểm tra.
Không dùng emoji."""

SCHED_RECIPES = [
    ("Dọn test đỏ mỗi đêm",
     "Ticket: “Sửa các test đang đỏ”. Lặp lại thứ 2 đến thứ 6 lúc 02:00. AI: Backend Dev. Done when: <b>Tests pass</b> với lệnh <code>pytest -q</code> + <b>Summary comment</b>. AI review: Reviewer, 1 vòng sửa. Sáng ra bạn chỉ cần đọc ticket ở cột Review."),
    ("Báo cáo tuần",
     "Ticket: “Báo cáo tiến độ tuần”. Lặp lại thứ 6 lúc 16:00. AI: Triage (chỉ đọc + comment). Done when: <b>Summary comment</b>. Hợp với việc tổng hợp, không đụng vào code."),
    ("Một lần, ngoài giờ",
     "Chạy một lần tối nay 22:00 cho ticket refactor dài. Cho phép chạy trong khung 22:00 đến 06:00, đặt giới hạn thời gian và số lần chạy, chọn AI dự phòng (backup) phòng khi AI chính đang bận."),
]

body_parts: list[str] = []

# ---- Cover
cover = f"""
<section class="cover">
  <div class="cover-badge">Kanban Board · phiên bản {VERSION}</div>
  <h1 class="cover-title">Hướng dẫn dùng AI</h1>
  <p class="cover-sub">Cài đặt từ đầu, viết prompt cho chuẩn, giao việc cho AI an toàn.</p>
  <div class="cover-grid">
    <div><b>Phần 1–3</b><span>Cài đặt: CLI, thêm AI member, chọn Board AI</span></div>
    <div><b>Phần 4–7</b><span>Prompt: persona, instructions, ticket, giao việc</span></div>
    <div><b>Phần 8–9</b><span>Board AI (Ask AI) và lịch chạy tự động</span></div>
    <div><b>Phần 10–12</b><span>An toàn, chi phí, xử lý sự cố, checklist</span></div>
  </div>
  <p class="cover-note">Ảnh chụp là dữ liệu demo. Giao diện app bằng tiếng Anh nên tên nút, tên mục được giữ nguyên tiếng Anh trong <b>chữ đậm</b>.</p>
</section>
"""
body_parts.append(cover)

# ---- Overview
overview = f"""
<section class="sec first">
<div class="kicker">TỔNG QUAN</div>
<h1>Chọn đúng tính năng, rồi đi đúng lộ trình</h1>
<p class="lead">Có ba thứ cùng gọi là “AI” trong app. Chúng dùng chung phần cài đặt, nhưng làm việc khác nhau.</p>
{table(
    ["Tính năng", "Nó làm gì", "Nó sửa dữ liệu không?", "Cần gì"],
    [
        ["<b>AI member</b><br/>thành viên AI", "Nhận ticket như một đồng nghiệp: đọc ticket, sửa code trong thư mục dự án, chạy test, báo cáo. Dừng ở cột <b>Review</b>.", "Có, theo quyền bạn cấp. Mọi hành động đi qua kiểm soát quyền và ghi nhật ký.", "Claude Code CLI đã đăng nhập, hoặc một API key"],
        ["<b>Board AI</b><br/>nút <b>Ask AI</b>", "Trả lời câu hỏi về board / ticket / tài liệu. Soạn nháp ticket, cải thiện mô tả, chia nhỏ việc, gợi ý test case, báo cáo sức khoẻ board.", "Không tự sửa. Đề xuất ở dạng <b>bản nháp</b>, bạn xem rồi bấm áp dụng.", "Chọn một AI member làm Board AI"],
        ["<b>AI schedules</b><br/>lịch chạy", "AI tự làm một ticket vào giờ đặt sẵn (một lần hoặc lặp lại), rồi kiểm tra kết quả theo điều kiện “xong khi”.", "Có, giống AI member. Đạt thì chuyển ticket sang Review, không đi xa hơn.", "Một AI member + app đang mở lúc đến giờ"],
    ],
    "wide",
)}
<h2>Lộ trình 15 phút cho lần đầu</h2>
<div class="roadmap">
  <div><i>1</i><b>Chuẩn bị</b><span>Cài và đăng nhập Claude Code CLI. Xác định thư mục dự án.</span><em>Phần 1</em></div>
  <div><i>2</i><b>Thêm AI member</b><span>Members → tab AI → Add AI member. Chạy thử kết nối.</span><em>Phần 2</em></div>
  <div><i>3</i><b>Chọn Board AI</b><span>Settings → AI → Change. Bật tính năng ở Board assistant.</span><em>Phần 3</em></div>
  <div><i>4</i><b>Viết persona</b><span>Vài dòng cho vai trò của AI. Có mẫu copy-paste.</span><em>Phần 4–5</em></div>
  <div><i>5</i><b>Giao ticket đầu tiên</b><span>Chọn ticket nhỏ, có tiêu chí rõ. Xem AI làm. Duyệt kết quả.</span><em>Phần 6–7</em></div>
</div>
{callout("tip", "Quy tắc để bắt đầu êm", "Ticket đầu tiên nên <b>nhỏ, có thể kiểm tra bằng một lệnh test</b>, trong một thư mục git đã commit sạch. Mục tiêu của lần đầu là hiểu cách AI làm việc, chưa phải giao việc lớn.")}
</section>
"""
body_parts.append(overview)

# ---- Part 1: preparation
p1 = f"""
<h2>1.1 Cài Claude Code CLI và đăng nhập</h2>
{ol([
    "Cài Node.js (bản LTS mới nhất) nếu máy chưa có.",
    "Mở terminal (Windows: PowerShell hoặc CMD) và chạy: <code>npm install -g @anthropic-ai/claude-code</code>",
    "Chạy <code>claude</code> một lần và đăng nhập theo hướng dẫn trên màn hình (tài khoản của bạn).",
    "Kiểm tra: <code>claude auth status</code> phải báo là đã đăng nhập.",
])}
<p>Sau khi cài và đăng nhập, <b>tắt hẳn rồi mở lại app</b> để nó nhận PATH mới. App chỉ khởi chạy CLI y như bạn gõ tay. <b>App không đọc và không lưu thông tin đăng nhập của CLI</b>; chỉ hiển thị tên tài khoản mà <code>claude auth status</code> in ra.</p>
<h2>1.2 Chọn model</h2>
{table(
    ["Model", "Hợp với", "Lưu ý"],
    [
        ["<b>Sonnet</b> (mặc định)", "Sửa code, viết test, refactor vừa, review kỹ.", "Chậm hơn và tốn hơn Haiku."],
        ["<b>Haiku</b>", "Việc nhỏ và nhanh: triage, tóm tắt, sửa lỗi chính tả, ticket rất rõ ràng.", "Dễ sót với việc cần suy luận nhiều bước."],
    ],
)}
<p>Với Claude Code, app chỉ cho chọn Sonnet hoặc Haiku. Với API key bạn chọn model của nhà cung cấp (Anthropic, OpenAI, Gemini hoặc một endpoint tương thích OpenAI).</p>
<h2>1.3 Thư mục dự án (working folder)</h2>
<p>AI chạy trong một thư mục, thường là thư mục gốc repo của bạn. Nên là <b>repo git</b> để xem được thay đổi và hoàn tác bằng git. Trước khi giao việc, commit hoặc stash code đang viết dở.</p>
{callout("warn", "Quy tắc vị trí thư mục (quan trọng trên Windows)", "Vì an toàn, thư mục dự án phải nằm <b>trong thư mục home</b> của bạn (ví dụ <code>C:\\Users\\ten\\code\\app</code>, nhưng không phải chính thư mục home), hoặc nằm trên <b>ổ đĩa khác ổ hệ thống</b> (ví dụ <code>D:\\code\\app</code>). Thư mục như <code>C:\\Projects</code> sẽ bị từ chối với thông báo “Choose a project folder inside your home folder…”.<br/><b>Cách xử lý:</b> đặt biến môi trường người dùng <code>KANBAN_AI_ROOTS</code> = <code>C:\\Projects</code> (nhiều thư mục cách nhau dấu <code>;</code>), rồi tắt hẳn và mở lại app.")}
<h2>1.4 Không có Claude Code? Dùng API key</h2>
<p>AI dùng API key chạy ngay trong board, không cần CLI. Nó dùng được các <b>công cụ của board</b> (đọc và sửa ticket, comment, docs…) nên rất hợp với triage, viết lại mô tả, review ticket, và làm Board AI. Nó <b>không</b> sửa file code trên máy bạn. Key được mã hoá; chỉ 4 ký tự cuối được hiển thị.</p>
{table(
    ["Bạn muốn", "Chọn loại AI"],
    [
        ["AI sửa code thật trên máy, chạy test", "Claude Code (CLI đã đăng nhập)"],
        ["AI đọc và quản lý ticket, không đụng code", "API key (Anthropic / OpenAI / Gemini / Custom) hoặc Claude Code với template Read only"],
        ["Chỉ dùng Ask AI để hỏi đáp và soạn nháp", "Một AI member bất kỳ đang online, chọn làm Board AI"],
    ],
)}
"""
body_parts.append(section("1", "Chuẩn bị", "Năm phút để máy sẵn sàng: CLI, model và thư mục dự án.", p1))

# ---- Part 2: add AI member
p2 = f"""
<h2>2.1 Mở màn hình thêm AI</h2>
<p>Bấm <b>Members</b> ở sidebar, chọn tab <b>AI</b>, rồi <b>Add AI member</b>. Hoặc vào <b>Settings → AI → Manage AI members</b>.</p>
{fig("a03-ai-empty-state", "Trang AI members khi chưa có AI. Ba lối bắt đầu nhanh: Claude Code, Antigravity, hoặc API key.")}
<h2>2.2 Bốn bước trong hộp thoại</h2>
{ol([
    "<b>Type</b>: chọn loại. Với người mới: <b>Claude Code</b>.",
    "<b>Connect</b>: app tự dò CLI, phiên bản và tài khoản đã đăng nhập (không thấy thì xem Phần 11). Chọn model (Sonnet hoặc Haiku), chọn <b>Working folder</b>, bấm <b>Run test</b> và chờ <b>Connection OK</b>.",
    "<b>Identity &amp; limits</b>: đặt tên, mô tả, <b>Role / persona</b> (Phần 4–5), số run song song và giới hạn chi phí.",
    "<b>Permissions &amp; review</b>: chọn template quyền và trần trạng thái (<b>May move tickets up to</b>).",
])}
{fig("a05-add-step2-connect", "Bước Connect: app thấy Claude Code CLI, phiên bản và tài khoản. Bấm Run test để chạy thử một lệnh thật.")}
{fig("a06-add-step3-identity", "Bước Identity &amp; limits: tên không được trùng người hay AI khác; persona tối đa 1000 ký tự; giới hạn chạy.")}
{fig("a07-add-step4-permissions", "Bước Permissions &amp; review: template quyền, trần trạng thái và các hành động cần người duyệt.")}
<h2>2.3 Cấu hình khuyên dùng cho người mới</h2>
{table(
    ["", "Dev AI", "Reviewer AI", "Triage AI"],
    [
        ["Loại và model", "Claude Code · Sonnet", "Claude Code · Sonnet hoặc Haiku", "API key (model nhỏ) hoặc Claude Code · Haiku"],
        ["Template quyền", "Developer", "Reviewer", "Read only"],
        ["Trần trạng thái", "Review (mặc định)", "Review", "—"],
        ["Run song song", "<b>1</b>", "1–2", "2"],
        ["Giới hạn chạy", "10 run mỗi ngày", "10 run mỗi ngày", "Daily budget thấp (ví dụ $1)"],
    ],
)}
{callout("note", "Vì sao Dev AI chỉ nên chạy 1 run song song?", "Hai run cùng sửa <b>một thư mục</b> dễ đè lên nhau. Giữ một run mỗi lần cho mỗi thư mục dự án; muốn song song, tạo thêm AI hoặc dùng thư mục khác.")}
<p><b>Mặc định của app:</b> 2 run song song, 20 run mỗi ngày (runner trên máy) hoặc daily budget $5 (API key), trần trạng thái là Review. Với runner trên máy, app giới hạn bằng <b>số run mỗi ngày</b> (chi phí tính theo tài khoản Claude bạn đã đăng nhập); với API key, app ước tính bằng đô la.</p>
"""
body_parts.append(section("2", "Thêm AI member đầu tiên", "Một hộp thoại bốn bước. Sau bước cuối app chạy thử kết nối ngay.", p2))

# ---- Part 3: Board AI
p3 = f"""
<h2>3.1 Chọn AI nào trả lời cho Ask AI</h2>
<p>Mở <b>Settings</b> ở sidebar, chọn trang <b>AI</b> (nhóm <i>Project settings</i>). Ở thẻ <b>BOARD AI</b>, bấm <b>Change</b> và chọn một AI member. AI đó phải đang online (không báo lỗi key, chưa đăng nhập hay đang tạm dừng). Việc chọn này <b>không ảnh hưởng ai được giao ticket</b>; nó chỉ chọn AI nào trả lời các yêu cầu toàn board.</p>
<p>Cùng trang có <b>Library</b> (kho skill và snippet dùng chung), <b>Manage AI members</b>, và phần <b>AI members · safety and limits</b> (Phần 10).</p>
{fig("t01-settings-ai", "Settings → AI: thẻ BOARD AI với nút Change, lối vào Library và Manage AI members, cùng phần an toàn và giới hạn chung.")}
<h2>3.2 Công tắc tính năng và cách “dạy” Board AI</h2>
<p>Trang <b>Board assistant</b> (ngay dưới trang AI) là nơi bật tắt tính năng và đặt “prompt” cho Board AI:</p>
{table(
    ["Công tắc", "Dùng để"],
    [
        ["<b>Chatbot</b>", "Nút Ask AI (Ctrl/Cmd + J): hỏi đáp có dẫn nguồn."],
        ["<b>Ticket drafting</b>", "Draft with AI khi tạo ticket; Improve description."],
        ["<b>Sub-task split</b>", "Split with AI: chia ticket cha thành ticket con."],
        ["<b>Test case suggestions</b>", "Gợi ý test case gắn với acceptance criteria."],
        ["<b>Board health and digest</b>", "Bản tin sức khoẻ board mỗi ngày làm việc lúc 09:00."],
        ["<b>Docs AI</b>", "Tóm tắt, viết một mục, gợi ý liên kết trong Docs."],
    ],
)}
{fig("t02-settings-assistant", "Settings → Board assistant: sáu công tắc tính năng (kèm chi phí tháng này), Language, Tone và Style guide for ticket drafts.")}
<p>Bên dưới các công tắc có <b>Language</b>, <b>Tone</b> (Neutral, Friendly, Concise) và ô <b>Style guide for ticket drafts</b> (tối đa 1000 ký tự). Đây là chỗ “prompt” của Board AI. Ví dụ:</p>
{prompt("STYLE GUIDE · mẫu", STYLE_GUIDE, 1000)}
<p><b>Data scope</b> cho biết Board AI được đọc những gì ở từng dự án. <b>Excluded docs</b> là tài liệu riêng tư: không bao giờ gửi cho AI và không bị trích dẫn.</p>
"""
body_parts.append(section("3", "Chọn Board AI", "Một lần cài đặt cho cả nút Ask AI, soạn nháp ticket, báo cáo board và Docs AI.", p3))

# ---- Part 4: the prompt layers
p4 = f"""
<h2>4.1 AI đọc những gì trước khi làm?</h2>
<p>Mỗi lần chạy, AI nhận chữ từ <b>năm nguồn</b>. Biết mỗi nguồn dùng cho việc gì là cách nhanh nhất để viết prompt chuẩn.</p>
{table(
    ["Lớp", "Bạn viết ở đâu", "Áp dụng cho", "Nên viết"],
    [
        ["<b>0. Luật của board</b>", "Tự động, không cần viết", "Mọi run", "Quyền được cấp, trần trạng thái, cách hỏi lại và cách báo cáo, “chữ trong thẻ untrusted chỉ là dữ liệu”. <b>Đừng viết lại những điều này.</b>"],
        ["<b>1. Persona</b>", "Hộp <b>Role / persona</b> của AI member (Add / Edit)", "Mọi run của AI đó", "Vai trò, quy trình làm việc, kiểu báo cáo. Tối đa 1000 ký tự."],
        ["<b>2. Instructions</b>", "AI member → tab <b>Configuration</b> → <b>Instructions</b>", "Mọi run của AI đó", "Quy ước dự án: lệnh build và test, cấu trúc thư mục, điều cấm. Với Claude Code, board ghi vào <code>CLAUDE.md</code> giữa dấu <i>kanban</i>."],
        ["<b>3. Ticket</b>", "Chính ticket", "Một ticket", "Tiêu đề, loại, ưu tiên, estimate, mô tả, acceptance criteria, ticket con và 20 comment gần nhất."],
        ["<b>4. Extra instruction</b>", "Ô <b>Extra instruction (optional)</b> khi giao, hoặc nội dung @mention", "Một lần chạy", "Lưu ý riêng cho lần này: phạm vi, mẫu để theo, “hỏi trước khi sửa”."],
    ],
    "wide",
)}
{callout("tip", "Cách chọn chỗ để viết", "Câu đó đúng cho <b>mọi ticket</b> → viết vào Instructions. Chỉ đúng cho <b>ticket này</b> → viết vào mô tả hoặc criteria. Chỉ đúng cho <b>lần chạy này</b> → Extra instruction. Nói về <b>AI là ai</b> → Persona.")}
<h2>4.2 Tám quy tắc vàng</h2>
{ol([
    "<b>Một ticket, một kết quả kiểm tra được.</b> Việc lớn thì chia nhỏ (Board AI có nút Split with AI).",
    "<b>Nói “xong” trông như thế nào</b>: viết acceptance criteria, mỗi dòng một điều kiện kiểm tra được. AI báo cáo từng tiêu chí kèm bằng chứng.",
    "<b>Cho AI lệnh để tự kiểm tra</b> (test, lint) và chắc chắn lệnh đó nằm trong danh sách cho phép (Phần 11).",
    "<b>Nêu phạm vi</b>: file hoặc thư mục được sửa, và một mục “Ngoài phạm vi”.",
    "<b>Cho ví dụ</b> hoặc trỏ tới mẫu có sẵn: “làm giống ticket KAN-12”.",
    "<b>Cho phép hỏi lại</b>: “thiếu thông tin thì hỏi, đừng đoán”. AI sẽ dừng và hiện thẻ câu hỏi cho bạn trả lời.",
    "<b>Viết câu khẳng định</b>: “Chỉ sửa trong /server” tốt hơn “đừng sửa lung tung”. Khi cấm điều gì, nói luôn nên làm gì thay thế.",
    "<b>Tránh từ mơ hồ</b> như “tối ưu”, “làm tốt hơn”. Thay bằng số hoặc hành vi: “giảm thời gian trả về dưới 200 ms”, “trả 20 bản ghi mỗi trang”.",
])}
{callout("warn", "Đừng dán bí mật vào prompt", "Không đưa API key, mật khẩu, token vào ticket, persona hay instructions. Board che các chuỗi trông giống key khi lưu bước chạy và nhật ký, nhưng cách an toàn nhất là không viết chúng ở đây.")}
"""
body_parts.append(section("4", "Prompt: AI đọc những gì", "Prompt chuẩn không phải một đoạn dài. Nó là năm lớp chữ, mỗi lớp viết một chỗ.", p4))

# ---- Part 5: templates
p5 = f"""
<h2>5.1 Persona mẫu (dán vào Role / persona)</h2>
<p>Persona nói AI <b>là ai và làm việc theo quy trình nào</b>. Giữ dưới 1000 ký tự. Viết bằng ngôn ngữ bạn muốn AI trả lời (comment và báo cáo sẽ theo ngôn ngữ đó).</p>
{prompt("PERSONA · Backend Dev · template quyền Developer", PERSONA_DEV, 1000)}
{prompt("PERSONA · Reviewer · template quyền Reviewer", PERSONA_REVIEWER, 1000)}
{prompt("PERSONA · Triage · template quyền Read only", PERSONA_TRIAGE, 1000)}
<h2>5.2 Instructions mẫu (Configuration → Instructions)</h2>
<p>Đây là “sổ tay dự án” cho AI. Thay các lệnh bằng lệnh của dự án bạn.</p>
{prompt("INSTRUCTIONS · mẫu", INSTR_SAMPLE)}
{callout("note", "Lệnh shell: viết dạng một lệnh đơn", "Claude Code trong board chỉ chạy lệnh <b>khớp hoàn toàn</b> một luật cho phép. Hãy dặn và tự viết lệnh test dạng đơn giản như <code>pytest -q</code>, tránh nối bằng <code>&amp;&amp;</code>, <code>;</code>, đường ống <code>|</code>, <code>echo</code> hay <code>cd</code> (AI đã đứng sẵn trong thư mục dự án).")}
<h2>5.3 Extra instruction mẫu (ô khi giao việc)</h2>
{''.join(prompt(t, x) for t, x in EXTRA_EXAMPLES)}
"""
body_parts.append(section("5", "Mẫu persona và instructions", "Bản copy-paste cho ba vai quen thuộc. Sửa vài chữ cho hợp dự án là dùng được.", p5))

# ---- Part 6: tickets
p6 = f"""
<h2>6.1 Ticket là prompt quan trọng nhất</h2>
<p>AI nhìn thấy: <b>tiêu đề, loại, ưu tiên, trạng thái, estimate, mô tả, acceptance criteria</b>, ticket con (nếu bật) và các comment gần nhất. Vì vậy chất lượng ticket quyết định chất lượng kết quả.</p>
<div class="bad"><span class="tag">Chưa tốt</span> AI phải đoán lỗi ở đâu, thế nào là xong, kiểm tra ra sao, nên thường hỏi lại nhiều hoặc sửa sai chỗ.{prompt("TICKET · chưa tốt", TICKET_BAD)}</div>
<div class="good"><span class="tag">Tốt</span> Có bối cảnh, việc cần làm, ngoài phạm vi, lệnh kiểm tra và tiêu chí nghiệm thu.{prompt("TICKET · mẫu tốt (mô tả + acceptance criteria)", TICKET_GOOD)}</div>
<h2>6.2 Khung mô tả dùng lại được</h2>
{table(
    ["Mục", "Viết gì", "Ví dụ"],
    [
        ["<b>Bối cảnh</b>", "Vì sao cần làm. Triệu chứng, log, đường dẫn file nếu có.", "Lỗi 500 ở find_user khi email có chữ hoa."],
        ["<b>Việc cần làm</b>", "Thay đổi cụ thể, ở đâu.", "Chuẩn hoá email về chữ thường khi so sánh."],
        ["<b>Ngoài phạm vi</b>", "Điều không được đụng.", "Không đổi schema DB."],
        ["<b>Cách kiểm tra</b>", "Lệnh và hành vi mong đợi.", "<code>pytest tests/test_auth.py -q</code>"],
        ["<b>Acceptance criteria</b>", "Mỗi dòng một điều kiện kiểm tra được (ô riêng của ticket).", "Có test mới cho email viết hoa."],
    ],
)}
{callout("tip", "Dùng Board AI để viết ticket tốt hơn", "Gõ ý thô trong <b>New Ticket → Draft with AI</b>, hoặc bấm <b>Improve description</b> trên ticket có sẵn. Board AI trả về bản nháp có tiêu đề, mô tả, tiêu chí và ưu tiên; bạn chấp nhận từng phần (Phần 8). Rồi mới giao cho AI member.")}
<h2>6.3 Comment cũng là prompt</h2>
<p>AI đọc 20 comment gần nhất. Comment của thành viên dự án được tin cậy; comment của AI khác chỉ là dữ liệu; người ngoài dự án không được hiển thị cho AI (trừ khi bạn bật cho AI đó đọc nguồn ngoài). Khi AI làm sai hướng, <b>viết một comment rõ ràng</b> rồi Request changes sẽ hiệu quả hơn mở lại từ đầu.</p>
"""
body_parts.append(section("6", "Viết ticket để AI làm đúng", "Hai ticket cùng một lỗi, kết quả khác hẳn nhau tuỳ cách viết.", p6))

# ---- Part 7: assign and review
p7 = f"""
<h2>7.1 Hai cách giao việc</h2>
<p><b>Cách 1: Assignee.</b> Mở ticket, chọn AI trong nhóm <b>AI</b> của ô Assignee. Hộp <b>How to start</b> hiện ra:</p>
{table(
    ["Lựa chọn", "Làm gì"],
    [
        ["<b>Start now</b>", "Chạy ngay (nếu AI còn chỗ). Ticket To Do chuyển sang In Progress."],
        ["<b>Queue</b>", "Xếp hàng, chạy sau khi việc hiện tại xong."],
        ["<b>Assign without running</b>", "Chỉ giao. Chạy sau bằng nút Run trên ticket."],
    ],
)}
{fig("b03-how-to-start", "Hộp How to start: chọn cách bắt đầu và nhập Extra instruction (không bắt buộc).")}
<p><b>Cách 2: @mention trong comment.</b> Gõ <code>@</code> và chọn AI, rồi chọn ý định:</p>
{table(
    ["Ý định", "AI làm gì", "Ví dụ"],
    [[f"<b>{a}</b>", {"Ask": "Trả lời bằng một comment. Không đổi file, trường hay trạng thái.", "Do the work": "Giao việc và bắt đầu run.", "Just notify": "Chỉ báo cho AI, không chạy."}[a], f'<span class="ex">{html.escape(t)}</span>'] for a, t in MENTION_EXAMPLES],
    "wide",
)}
<h2>7.2 Theo dõi khi AI đang làm</h2>
<p>Ticket có tab <b>Run</b> (biểu tượng tia sáng) hiển thị từng bước theo thời gian thật: đọc file, sửa file, lệnh đã chạy, thay đổi trạng thái, token và chi phí. Có nút <b>Stop</b> bất cứ lúc nào. Trên board, thẻ có chip Running/Queued và cột hiện “1 AI running”.</p>
{fig("b05-run-panel-live", "Run panel cập nhật trực tiếp: từng bước đọc file, sửa code, chạy lệnh, gọi công cụ của board.")}
<h2>7.3 Khi AI hỏi lại</h2>
<p>AI dừng ở trạng thái <b>Needs input</b> và hiện <b>thẻ câu hỏi</b> với các lựa chọn (có lựa chọn được đề xuất). Trả lời xong, AI tiếp tục đúng phiên cũ. Nếu chưa trả lời, app nhắc sau 15 phút và định kỳ; admin được báo khi quá 6 giờ.</p>
{fig("c06-question-card", "Thẻ câu hỏi của AI: chọn một phương án hoặc viết câu trả lời riêng.")}
<h2>7.4 Duyệt kết quả (Review gate)</h2>
<p>Khi xong, AI chuyển ticket sang <b>Review</b> và để lại <b>AI summary</b>: đã làm gì, file nào đổi (+/−), từng acceptance criteria đạt hay chưa kèm bằng chứng. <b>Quyền chuyển sang Done luôn thuộc về người.</b></p>
{table(
    ["Nút", "Ý nghĩa"],
    [
        ["<b>Approve</b>", "Chấp nhận. Ticket sang Done."],
        ["<b>Request changes</b>", "Viết nhận xét; AI làm lại theo nhận xét đó."],
        ["<b>Take over</b>", "Bạn tự làm tiếp; AI nhả ticket."],
        ["<b>Undo run's changes</b>", "Hoàn tác các thay đổi <b>trên ticket</b> mà run đã làm (trường, trạng thái). Những thay đổi bạn sửa sau đó được bỏ qua."],
    ],
)}
{callout("warn", "Code do AI sửa: hoàn tác bằng git", "Nút Undo của board chỉ hoàn tác dữ liệu trên ticket. Với file code, dùng git: <code>git diff</code> để xem, <code>git restore .</code> hoặc <code>git checkout -- file</code> để bỏ thay đổi. Đây là lý do nên giao việc khi repo đã commit sạch.")}
{fig("b08-ai-summary-review-gate", "AI summary: việc đã làm, file đổi, đối chiếu từng acceptance criteria. Người duyệt quyết định Approve hoặc Request changes.")}
"""
body_parts.append(section("7", "Giao việc, theo dõi, duyệt", "Từ lúc bấm Start đến lúc bạn Approve.", p7))

# ---- Part 8: Board AI
p8 = f"""
<h2>8.1 Hỏi đáp với Ask AI (Ctrl/Cmd + J)</h2>
<p>Mở dock bên phải và chọn phạm vi: <b>project</b>, <b>ticket</b>, <b>doc</b> hoặc <b>all</b> (nhiều dự án). Hỏi như hỏi đồng nghiệp. Dock hiển thị nguồn, chi phí và có nút thumbs để chấm câu trả lời. Khi AI muốn đổi dữ liệu, nó đưa <b>bản nháp</b> để bạn bấm áp dụng (có Undo).</p>
{fig("g04-answer", "Ask AI: câu trả lời kèm thẻ ticket, bảng và nguồn tham chiếu.")}
<h3>Câu hỏi mẫu</h3>
{table(["Phạm vi", "Câu hỏi"], [[a, html.escape(b)] for a, b in BOARD_PROMPTS], "wide")}
<h2>8.2 Các tính năng soạn nháp</h2>
{table(
    ["Tính năng", "Mở ở đâu", "Mẹo viết prompt"],
    [
        ["<b>Draft with AI</b>", "New Ticket", "Mô tả ý thô: người dùng, hành vi mong muốn, ràng buộc. AI trả tiêu đề, mô tả, tiêu chí, ưu tiên và liệt kê ticket gần giống để tránh trùng."],
        ["<b>Improve description</b>", "Trên ticket", "Cho biết cần gì: “ngắn hơn”, “thêm cách kiểm tra”. Xem diff và chấp nhận từng đoạn."],
        ["<b>Split with AI</b>", "Trên ticket cha", "Nói bạn muốn chia theo lớp (API, UI, test) hay theo bước. AI tạo ticket con có liên kết blocked-by."],
        ["<b>Suggest test cases</b>", "Test Cases của ticket", "Viết acceptance criteria rõ trước. AI gắn test case vào từng tiêu chí và chỉ ra tiêu chí chưa được bao phủ."],
        ["<b>Board health</b>", "Chip trên board, bản tin hằng ngày", "Không cần prompt. Đặt giờ, số ngày “kẹt” và giới hạn WIP trong Settings → Board assistant."],
        ["<b>Docs AI</b>", "Menu AI trong trang Docs", "Bôi đen đoạn văn để Summarise, Rewrite, Ask; kết quả hiện thành bản nháp, chèn khi bạn đồng ý."],
    ],
    "wide",
)}
{fig("h03-draft", "Draft with AI trong New Ticket: bản nháp theo từng trường, chấp nhận hoặc bỏ từng phần.")}
"""
body_parts.append(section("8", "Dùng Board AI (Ask AI)", "Hỏi đáp và soạn nháp. Board AI không tự sửa gì ngoài ý bạn.", p8))

# ---- Part 9: schedules
p9 = f"""
<h2>9.1 Khi nào dùng lịch chạy</h2>
<p>Dùng khi việc <b>lặp lại hoặc dài</b> và có cách kiểm tra bằng máy: dọn test đỏ, cập nhật phụ thuộc, tổng hợp báo cáo. Đừng lên lịch cho việc cần quyết định thiết kế.</p>
<h2>9.2 Tạo lịch</h2>
<p>Mở menu <b>Run</b> của ticket → <b>Schedule a run…</b>, hoặc tab <b>Schedules</b> → <b>New schedule</b>. Các mục trong trình soạn:</p>
{table(
    ["Mục", "Ý nghĩa"],
    [
        ["<b>Task</b>", "Ticket mà AI sẽ làm."],
        ["<b>When</b>", "Một lần hoặc lặp lại (chọn ngày trong tuần, giờ, <b>múi giờ</b>, quy tắc kết thúc, khung giờ cho phép)."],
        ["<b>Who runs it</b>", "AI member chính và <b>backup</b>. AI phải có quyền nhận ticket này."],
        ["<b>Done when</b>", "Các điều kiện “xong”, tất cả phải đạt: mọi acceptance criteria đã tick; <b>Tests pass</b> (lệnh và thư mục); có comment tóm tắt; có branch hoặc PR liên kết; hoặc kiểm tra tự viết bằng lời cho AI reviewer."],
        ["<b>AI review</b>", "Một AI thứ hai kiểm tra kết quả; có thể cho vài vòng sửa."],
        ["<b>Limits</b>", "Giới hạn dừng run."],
        ["<b>If it cannot run on time</b>", "Cách xử lý khi máy tắt, AI bận hay tạm dừng (chạy bù, bỏ qua…)."],
        ["<b>Tell me when</b>", "Ai được báo và về việc gì."],
        ["<b>Instruction</b>", "Chữ thêm cho AI, giống Extra instruction."],
    ],
    "wide",
)}
{fig("s04-editor", "Trình soạn lịch: task, thời điểm, AI, điều kiện “Done when”, AI review và các giới hạn. Bên phải là bản tóm tắt và 5 lần chạy kế tiếp.")}
<h2>9.3 Ba công thức</h2>
{''.join(f'<div class="recipe"><b>{t}</b><p>{d}</p></div>' for t, d in SCHED_RECIPES)}
{callout("note", "Cần nhớ", "Lịch chạy bằng quyền của AI member, theo trần trạng thái của nó. Đạt tất cả điều kiện thì ticket sang <b>Review</b>, không bao giờ tự sang Done. Ba lần thất bại liên tiếp thì lịch tự tạm dừng. App cần đang mở khi đến giờ (nếu không, “If it cannot run on time” quyết định chuyện gì xảy ra).")}
"""
body_parts.append(section("9", "AI schedules: giao việc theo giờ", "AI làm việc khi bạn không ngồi đó, rồi tự kiểm tra bằng điều kiện bạn đặt.", p9))

# ---- Part 10: safety
def mode(m):
    return {"a": '<span class="ok">Cho phép</span>', "p": '<span class="ap">Cần duyệt</span>', "b": '<span class="no">Chặn</span>'}[m]


# columns: Developer, Reviewer, Read only, Custom — rewritten below from the real template table
real = {
    "Đọc ticket": ["a", "a", "a", "a"], "Comment": ["a", "a", "a", "a"],
    "Sửa trường (tiêu đề, mô tả…)": ["a", "p", "b", "a"], "Đổi trạng thái (trong trần)": ["a", "a", "b", "a"],
    "Đổi người được giao": ["p", "b", "b", "a"], "Tạo ticket": ["a", "p", "b", "a"],
    "Xoá ticket": ["b", "b", "b", "p"], "Sửa Docs": ["p", "b", "b", "a"],
    "Quản lý test case": ["a", "a", "b", "a"], "Tạo branch": ["a", "b", "b", "a"],
}
perm_rows = [[k] + [mode(x) for x in v] for k, v in real.items()]
p10 = f"""
<h2>10.1 Quyền theo template</h2>
<p>Mỗi AI member có một template. Bạn chỉ có thể <b>làm chặt hơn</b> template bằng các ghi đè; muốn nới rộng phải chuyển sang <b>Custom</b> (chỉ owner).</p>
{table(["Hành động", "Developer", "Reviewer", "Read only", "Custom"], perm_rows, "perm")}
<h2>10.2 Các lớp bảo vệ</h2>
{table(
    ["Lớp", "Tác dụng", "Ở đâu"],
    [
        ["<b>Trần trạng thái</b>", "AI chỉ đưa ticket tới mức tối đa bạn đặt (mặc định Review). Testing và Done cần xác nhận thêm và owner.", "Add / Edit AI member"],
        ["<b>Duyệt</b>", "Hành động mức “Cần duyệt” bị giữ lại; AI <b>chờ</b> quyết định của bạn rồi mới tiếp tục. Có thể “Approve &amp; remember”.", "Inbox / Approvals"],
        ["<b>Giới hạn</b>", "Run mỗi ngày, run mỗi ticket, daily budget và monthly cap (API key). Báo ở 80% và 100%.", "Profile → Usage; Settings → AI"],
        ["<b>Safe mode</b>", "AI chỉ đọc và comment, mọi hành động khác bị chặn. Bật cho cả dự án hoặc từng AI.", "Settings → AI"],
        ["<b>Giới hạn chung của board</b>", "Board daily cap, Board monthly budget, Max chain depth (AI nhờ AI), Runs per ticket a day, và thời gian hết hạn của yêu cầu duyệt (1 giờ, 4 giờ, 24 giờ, 3 ngày).", "Settings → AI → safety and limits"],
        ["<b>Pause all AI</b> (kill switch)", "Dừng mọi AI ngay (huỷ run hoặc để chạy nốt), giữ hàng đợi. Resume có checklist.", "Nút trên header board"],
        ["<b>Nhật ký (Audit log)</b>", "Mọi hành động ghi “tên AI, thay mặt ai”. Có lọc, xuất file, hoàn tác từng thay đổi hoặc cả run.", "AI members → Audit"],
    ],
    "wide",
)}
{fig("d06-approvals-inbox", "Hộp duyệt: hành động AI đang chờ bạn, kèm trước → sau, mức rủi ro và nút Approve hoặc Deny.", "92%")}
<h2>10.3 Ai làm được gì</h2>
<p><b>Viewer</b> chỉ xem. <b>Member</b> giao ticket, tạm dừng, chạy thử, thao tác run. <b>Admin</b> thêm, sửa, xoá AI member và đổi cấu hình. <b>Owner</b> (bạn, với bản desktop) đổi mặc định chung và cho phép thêm lượt chạy. Admin đổi quyền của AI thì phải chờ owner xác nhận.</p>
"""
body_parts.append(section("10", "An toàn và chi phí", "AI làm việc thật nên cần kiểm soát. Mọi thứ dưới đây đã có sẵn, bạn chỉ cần biết chỗ bật.", p10))

# ---- Part 11: troubleshooting
p11 = f"""
{callout("note", "Khi cần hỗ trợ", "Mở <b>Settings → Diagnostics → Application logs → Export logs</b>, gửi file log kèm phiên bản app (hiện trong file) và mô tả ngắn: bạn bấm gì, thấy gì, mong đợi gì.")}
{table(
    ["Dấu hiệu", "Nguyên nhân thường gặp", "Cách xử lý"],
    [
        ["““claude” was not found on this computer”", "Chưa cài CLI, hoặc app desktop không thấy thư mục chứa <code>claude</code> (app tự tìm trong PATH và các thư mục npm thông dụng như <code>%AppData%\\npm</code>).", "Chạy <code>where claude</code> (Windows) hoặc <code>which claude</code> để biết vị trí. Thêm thư mục đó vào <b>PATH</b>, <b>tắt hẳn rồi mở lại app</b>, bấm <b>Check again</b>."],
        ["Trạng thái “not signed in”", "CLI đã cài nhưng chưa đăng nhập.", "Mở terminal, chạy <code>claude</code>, đăng nhập, rồi <b>Test connection</b> trong app."],
        ["“Choose a project folder inside your home folder…”", "Thư mục dự án nằm ngoài vùng cho phép.", "Chuyển repo vào thư mục home hoặc ổ khác, hoặc đặt <code>KANBAN_AI_ROOTS</code> (Phần 1.3) và mở lại app."],
        ["AI báo không chạy được lệnh test (lệnh bị từ chối)", "Lệnh test của bạn không nằm trong danh sách cho phép. Mặc định chỉ có git status/diff/log, pytest, npm test, npm run test/lint.", "AI member → <b>Configuration → Permissions</b>: thêm luật như <code>Bash(dotnet test:*)</code>, <code>Bash(go test:*)</code>, <code>Bash(uv run pytest:*)</code>. Muốn cho commit: <code>Bash(git add:*)</code>, <code>Bash(git commit:*)</code>. Mặc định không cho push."],
        ["Run dừng ở “Needs input”", "AI đang chờ bạn trả lời thẻ câu hỏi.", "Trả lời ở thẻ câu hỏi trên ticket hoặc trong Inbox. Có thể chọn “Answer later” hay “Ask someone else”."],
        ["“Rate limited” rồi tự chạy lại", "Nhà cung cấp giới hạn tốc độ.", "Đợi hết thời gian chờ (run xếp lại và chạy tự động) hoặc bấm <b>Retry now</b>."],
        ["“Key invalid” (API key)", "Key sai, hết hạn hoặc bị thu hồi.", "Sửa AI member, nhập key mới, bấm Test key."],
        ["Run “failed: the board restarted…”", "App bị đóng hoặc crash giữa chừng.", "Bấm Retry để tạo run mới. Process CLI còn sót sẽ được dọn khi app mở lại."],
        ["AI bị tạm dừng vì hết hạn mức", "Chạm daily budget, monthly cap hoặc run mỗi ngày.", "Chờ sang ngày mới hoặc tăng hạn mức. Owner có thể <b>Allow more runs</b> cho một ticket."],
        ["Pause run báo “not supported on Windows yet”", "Tạm dừng một run local cần tín hiệu của Linux/macOS. Run dùng API key vẫn tạm dừng được.", "Dùng <b>Stop</b> rồi chạy lại. <b>Pause all AI</b> (kill switch) vẫn dùng được."],
        ["Mất nút Ask AI hoặc Settings → AI quay mãi (Windows)", "Lỗi định dạng ngày ở bản trước 3.8.2.", "Cập nhật lên 3.8.2 trở lên. Nếu còn, mở <b>Settings → Diagnostics → Application logs → Export logs</b> và gửi file log."],
        ["AI làm sai hướng", "Ticket thiếu tiêu chí hoặc phạm vi.", "Viết comment rõ, <b>Request changes</b>. Sửa ticket theo khung ở Phần 6. Xem Run panel để biết AI hiểu sai ở bước nào."],
    ],
    "wide trouble",
)}
"""
body_parts.append(section("11", "Xử lý sự cố thường gặp", "Gần như mọi lỗi lần đầu rơi vào mười hai dấu hiệu dưới đây.", p11))

# ---- Part 12: checklist
p12 = f"""
<div class="check-grid">
<div class="check"><h3>Cài đặt (một lần)</h3>
<ul class="boxes">
<li>Cài và đăng nhập Claude Code CLI; <code>claude auth status</code> báo đã đăng nhập</li>
<li>Thư mục dự án là repo git, nằm trong home / ổ khác / <code>KANBAN_AI_ROOTS</code></li>
<li>Thêm AI member, <b>Run test</b> báo Connection OK</li>
<li>Viết persona (dưới 1000 ký tự)</li>
<li>Viết Instructions: lệnh test, cấu trúc, điều cấm</li>
<li>Lệnh test nằm trong luật cho phép (Configuration → Permissions)</li>
<li>Chọn Board AI, bật các công tắc cần dùng</li>
<li>Biết chỗ của nút <b>Pause all AI</b></li>
</ul></div>
<div class="check"><h3>Trước khi giao ticket</h3>
<ul class="boxes">
<li>Repo đã commit hoặc stash sạch</li>
<li>Ticket có bối cảnh, việc cần làm, <b>ngoài phạm vi</b></li>
<li>Có acceptance criteria kiểm tra được</li>
<li>Có lệnh để AI tự kiểm tra</li>
<li>Việc đủ nhỏ cho một lần chạy</li>
<li>Chọn Start now / Queue; thêm Extra instruction nếu cần</li>
<li>Dặn “thiếu thông tin thì hỏi” nếu việc còn mơ hồ</li>
</ul></div>
<div class="check"><h3>Khi AI đang chạy</h3>
<ul class="boxes">
<li>Xem tab <b>Run</b> trong vài phút đầu để chắc nó đi đúng hướng</li>
<li>Trả lời thẻ câu hỏi khi AI hỏi</li>
<li>Thấy sai hướng: bấm <b>Stop</b>, sửa ticket, chạy lại</li>
</ul></div>
<div class="check"><h3>Sau khi AI xong</h3>
<ul class="boxes">
<li>Đọc <b>AI summary</b>: file đổi, từng tiêu chí và bằng chứng</li>
<li>Chạy <code>git diff</code> và test ở máy bạn</li>
<li><b>Approve</b>, hoặc <b>Request changes</b> kèm nhận xét cụ thể</li>
<li>Xem chi phí và số bước ở lịch sử run; chỉnh giới hạn nếu cần</li>
</ul></div>
</div>
<div class="final">Prompt tốt = <b>mục tiêu rõ</b> + <b>phạm vi rõ</b> + <b>cách kiểm tra rõ</b> + <b>cho phép hỏi lại</b>.</div>
"""
body_parts.append(section("12", "Checklist một trang", "In ra hoặc ghim lại. Đi qua từ trên xuống là đủ.", p12))

CSS = """
@page { size: A4; margin: 16mm 16mm 20mm;
  @bottom-left { content: "Kanban Board · Hướng dẫn dùng AI · v__VERSION__"; font: 8pt 'Inter', sans-serif; color: #8a998f; }
  @bottom-right { content: counter(page); font: 8pt 'Inter', sans-serif; color: #8a998f; } }
@page :first { margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }
* { box-sizing: border-box; }
html { font-family: 'Inter', 'DejaVu Sans', sans-serif; color: #1c2b21; font-size: 10pt; line-height: 1.5; }
body { margin: 0; }
section.sec { padding: 0; }
section.sec:not(.first) { margin-top: 20pt; padding-top: 10pt; border-top: 3px solid #2E6F40; }
section.sec.newpage { break-before: page; margin-top: 0; border-top: 0; padding-top: 0; }
.kicker, h1, .lead { break-after: avoid; }
.kicker { color: #2E6F40; font-weight: 700; font-size: 8.5pt; letter-spacing: .12em; margin-bottom: 2pt; }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 6pt; color: #14301f; font-weight: 700; }
h2 { font-size: 13pt; margin: 14pt 0 5pt; color: #14301f; break-after: avoid; border-bottom: 1.5px solid #dbe6dd; padding-bottom: 3pt; }
h3 { font-size: 11pt; margin: 10pt 0 4pt; color: #14301f; break-after: avoid; }
p { margin: 0 0 7pt; }
.lead { break-after: avoid; font-size: 11pt; color: #3d5345; margin-bottom: 10pt; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.6pt; background: #eef3ee; padding: 0 3pt; border-radius: 3px; color: #1b4d2c; }
ol, ul { margin: 0 0 8pt; padding-left: 16pt; }
li { margin-bottom: 3pt; }
figure { margin: 8pt auto 10pt; break-inside: avoid; }
figure img { width: 100%; display: block; border: 1px solid #cfd9d1; border-radius: 6px; }
figcaption { font-size: 8.5pt; color: #5b6b60; margin-top: 3pt; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9pt; break-inside: auto; }
th { background: #2E6F40; color: #fff; text-align: left; padding: 5pt 7pt; font-weight: 600; }
td { padding: 5pt 7pt; border-bottom: 1px solid #dbe6dd; vertical-align: top; }
tr { break-inside: avoid; }
tbody tr:nth-child(even) td { background: #f5f9f5; }
table.perm td:not(:first-child), table.perm th:not(:first-child) { text-align: center; }
.ok { color: #1b6b35; font-weight: 600; } .ap { color: #a3640c; font-weight: 600; } .no { color: #a33; font-weight: 600; }
.callout { border-left: 4px solid #2E6F40; background: #eef6ef; padding: 7pt 10pt; border-radius: 4px; margin: 8pt 0 10pt; break-inside: avoid; font-size: 9.4pt; }
.callout > b { display: block; margin-bottom: 2pt; }
.callout.warn { border-color: #c4820f; background: #fdf3e0; }
.callout.note { border-color: #2f6fb0; background: #eaf2fb; }
.prompt { border: 1px solid #c9d6cb; border-radius: 6px; margin: 6pt 0 9pt; background: #f6f9f6; break-inside: avoid; overflow: hidden; }
.prompt-h { display: flex; justify-content: space-between; background: #e1ece3; padding: 3pt 8pt; font-size: 8pt; font-weight: 700; color: #2E6F40; letter-spacing: .02em; }
.prompt pre { margin: 0; padding: 7pt 9pt; font-family: 'Inter', 'DejaVu Sans', sans-serif; font-size: 8.8pt; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.ex { background: #eef3ee; padding: 1pt 4pt; border-radius: 3px; color: #1b4d2c; }
.pagebreak { break-before: page; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
.tag { display: inline-block; font-size: 8pt; font-weight: 700; padding: 1pt 7pt; border-radius: 10px; margin-bottom: 3pt; }
.bad, .good { break-inside: avoid; margin-bottom: 6pt; }
.bad .tag { background: #f9dcdc; color: #a33; } .good .tag { background: #d9eede; color: #1b6b35; }
.recipe { border: 1px solid #cfdcd1; border-radius: 6px; padding: 6pt 10pt; margin-bottom: 7pt; break-inside: avoid; }
.recipe p { margin: 2pt 0 0; font-size: 9.4pt; }
.roadmap { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6pt; margin: 6pt 0 10pt; }
.roadmap div { border: 1px solid #cfdcd1; border-radius: 8px; padding: 8pt; position: relative; background: #f7faf7; }
.roadmap i { position: absolute; top: -8pt; left: 8pt; background: #2E6F40; color: #fff; width: 18pt; height: 18pt; border-radius: 50%; font-style: normal; font-weight: 700; text-align: center; line-height: 18pt; font-size: 9pt; }
.roadmap b { display: block; margin: 5pt 0 3pt; font-size: 9.4pt; }
.roadmap span { display: block; font-size: 8.4pt; color: #3d5345; }
.roadmap em { display: block; margin-top: 4pt; font-size: 7.8pt; color: #2E6F40; font-style: normal; font-weight: 700; }
.cover { height: 297mm; padding: 38mm 24mm 20mm; background: linear-gradient(160deg, #14301f 0%, #2E6F40 62%, #4c9b62 100%); color: #fff; break-after: page; }
.cover-badge { display: inline-block; border: 1px solid rgba(255,255,255,.5); border-radius: 20px; padding: 3pt 12pt; font-size: 9pt; margin-bottom: 20pt; }
.cover-title { font-size: 44pt; color: #fff; margin: 0 0 8pt; line-height: 1.1; }
.cover-sub { font-size: 14pt; opacity: .92; max-width: 135mm; }
.cover-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; margin-top: 32mm; }
.cover-grid div { background: rgba(255,255,255,.12); border-radius: 8px; padding: 10pt 12pt; }
.cover-grid b { display: block; font-size: 11pt; margin-bottom: 2pt; } .cover-grid span { font-size: 9pt; opacity: .9; }
.cover-note { margin-top: 18mm; font-size: 8.8pt; opacity: .8; max-width: 140mm; }
.check-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9pt; }
.check { border: 1px solid #cfdcd1; border-radius: 8px; padding: 6pt 11pt 4pt; break-inside: avoid; background: #fafcfa; }
.check h3 { margin-top: 3pt; color: #2E6F40; }
ul.boxes { list-style: none; padding-left: 0; }
ul.boxes li { position: relative; padding-left: 15pt; font-size: 9.2pt; }
ul.boxes li::before { content: ''; position: absolute; left: 0; top: 2.5pt; width: 8pt; height: 8pt; border: 1.5px solid #2E6F40; border-radius: 2px; }
.final { margin-top: 12pt; padding: 10pt 14pt; background: #14301f; color: #fff; border-radius: 8px; font-size: 11.5pt; text-align: center; }
.trouble td:first-child { width: 28%; font-weight: 600; }
"""

doc = f"""<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Hướng dẫn dùng AI trong Kanban Board</title>
<style>{CSS.replace("__VERSION__", VERSION)}</style></head><body>{''.join(body_parts)}</body></html>"""
with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp) / "guide.html"
    page.write_text(doc, encoding="utf-8")
    subprocess.run(["node", str(HERE / "print_pdf.js"), str(page), str(PDF)], check=True)
print("wrote", PDF)
