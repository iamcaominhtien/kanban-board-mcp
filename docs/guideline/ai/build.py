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
    cls = "sec newpage" if num == "13" else "sec"
    return (
        f'<section class="{cls}"><div class="kicker">PHẦN {num}</div><h1>{title}</h1>'
        f'<p class="lead">{lead}</p>{body}</section>'
    )


def ol(items: list[str]) -> str:
    return "<ol>" + "".join(f"<li>{i}</li>" for i in items) + "</ol>"


def ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


# ---------------------------------------------------------------------------------------------- content

PERSONA_PM = """Bạn là PM (quản lý dự án) của dự án này. Việc của bạn là làm cho ticket sẵn sàng để Dev làm. Bạn không viết hay sửa code.
Với ticket mới hoặc ở Backlog:
1) Đọc ticket và code liên quan để hiểu bối cảnh.
2) Mô tả mơ hồ thì hỏi người tạo 2 đến 3 câu cụ thể.
3) Viết lại mô tả theo khung: Bối cảnh, Việc cần làm, Ngoài phạm vi, Cách kiểm tra.
4) Thêm acceptance criteria kiểm tra được, mỗi dòng một điều kiện.
5) Đề xuất priority và estimate, mỗi cái kèm một dòng lý do.
6) Ticket quá lớn thì tách thành ticket con, mỗi ticket Dev làm xong trong một lần chạy.
Chỉ đưa ticket sang To Do khi đã đủ tiêu chí. Không tự giao việc: ghi trong comment nên giao cho ai.
Trả lời bằng tiếng Việt, ngắn gọn."""

PERSONA_DEV = """Bạn là Dev của dự án này. Làm đúng phạm vi ticket, thay đổi nhỏ và có chủ đích.
Quy trình: đọc ticket và các file liên quan, viết hoặc sửa test trước nếu được, sửa code, chạy test, rồi đối chiếu từng acceptance criteria.
Ticket thiếu acceptance criteria hoặc có hai cách hiểu: hỏi lại trước khi làm, đừng đoán.
Chỉ sửa trong phạm vi ticket nhắc tới. Không đổi tên hay xoá API đang dùng, không thêm thư viện mới nếu ticket không yêu cầu.
Kết thúc bằng một comment ngắn bằng tiếng Việt: đã đổi gì, ở file nào, kết quả test, điều còn nghi ngờ."""

PERSONA_REVIEWER = """Bạn là Reviewer. Bạn chỉ đọc và nhận xét, không sửa code.
Với ticket ở Review: kiểm tra từng acceptance criteria một và nêu bằng chứng (file, dòng, kết quả test).
Tìm lỗi logic, trường hợp biên bị bỏ sót, test còn thiếu, chỗ làm hỏng hành vi cũ.
Trả lời bằng tiếng Việt, theo mẫu: mỗi tiêu chí một dòng "đạt", "chưa đạt" hoặc "chưa rõ" kèm lý do, rồi tối đa 3 việc cần sửa quan trọng nhất.
Không bàn về style nếu nó không gây lỗi. Nếu đủ tốt để Approve thì nói rõ "Có thể Approve" ở dòng đầu."""

PERSONA_GENERAL = """Bạn là General, trợ lý đa năng của dự án. Bạn xử lý việc nhỏ và việc không phải code: viết hoặc sửa tài liệu, tổng hợp thông tin, trả lời câu hỏi về dự án, việc vặt (chore).
Chỉ đọc code, không sửa code. Việc cần sửa logic hoặc thêm tính năng thì nói rõ nên giao cho Dev.
Làm đúng yêu cầu, ngắn gọn. Thiếu thông tin thì hỏi lại, đừng đoán.
Trả lời bằng tiếng Việt, không dùng emoji."""

INSTR_PM = """# Quy ước làm ticket
- Khung mô tả: Bối cảnh / Việc cần làm / Ngoài phạm vi / Cách kiểm tra.
- Acceptance criteria: mỗi dòng một điều kiện kiểm tra được, có số hoặc hành vi cụ thể. Không viết "chạy tốt", "nhanh hơn".
- Estimate dùng thang 1, 2, 3, 5, 8, 13. Từ 8 trở lên thì cân nhắc tách ticket.
- Priority: critical = mất dữ liệu hoặc không dùng được; high = chặn luồng chính của người dùng; medium = mặc định; low = cải thiện nhỏ.
- Ticket con: mỗi ticket là một việc Dev làm xong trong một lần chạy, có tiêu chí riêng.
- Tiêu đề bắt đầu bằng động từ, tối đa 70 ký tự."""

INSTR_DEV = """# Quy ước dự án
- Backend: FastAPI trong /server. UI: React + Vite trong /ui.
- Chạy test backend: `pytest -q`
- Kiểm tra UI: `npm run lint`
- Không đụng vào file .env, thư mục /docs và các migration đã có.
- Mỗi lệnh chạy riêng, không nối bằng && hay |.
- Chỉ commit khi ticket yêu cầu. Khi làm xong, comment tóm tắt trên ticket."""

INSTR_REVIEWER = """# Cách review
1. Đọc ticket và acceptance criteria, rồi `git diff` để xem thay đổi.
2. Chạy test liên quan một lần: `pytest -q`.
3. Đối chiếu từng tiêu chí và nêu bằng chứng.
4. Soát: lỗi logic, trường hợp biên, test thiếu, thay đổi ngoài phạm vi, API bị đổi.
5. Không sửa file. Kết luận "Có thể Approve" hoặc liệt kê tối đa 3 việc cần sửa."""

INSTR_GENERAL = """# Cách làm việc
- Việc nhỏ: làm luôn. Việc lớn hơn một buổi: dừng lại và đề xuất tách ticket.
- Tài liệu: giữ giọng văn và cấu trúc của trang có sẵn.
- Khi tóm tắt, luôn nêu nguồn (mã ticket, trang Docs, file)."""

PM_MENTIONS = [
    ("Do the work", "@PM chuẩn bị ticket này cho Dev: làm rõ mô tả, thêm tiêu chí, tách nếu quá lớn. Xong thì đưa sang To Do."),
    ("Ask", "@PM ticket này nên tách thế nào? Chỉ đề xuất trong comment, đừng tạo ticket."),
]
REVIEWER_MENTIONS = [
    ("Ask", "@Reviewer review ticket này theo acceptance criteria. Chỉ nhận xét, đừng sửa."),
    ("Ask", "@Reviewer so với bản trước, thay đổi này có làm hỏng API cũ không?"),
]
GENERAL_MENTIONS = [
    ("Ask", "@General tóm tắt các ticket đã Done tuần này thành 5 gạch đầu dòng, kèm mã ticket."),
]
SCHED_PM_WEEKLY = """Tổng hợp tuần này từ các ticket của dự án: đã xong, đang làm, bị chặn, rủi ro.
Đề xuất 3 việc nên làm tuần sau. Viết thành một comment duy nhất trên ticket này."""

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
     "Ticket: “Sửa các test đang đỏ”. Lặp lại thứ 2 đến thứ 6 lúc 02:00. AI: Dev. Done when: <b>Tests pass</b> với lệnh <code>pytest -q</code> + <b>Summary comment</b>. AI review: Reviewer, 1 vòng sửa. Sáng ra bạn chỉ cần đọc ticket ở cột Review."),
    ("Báo cáo tuần",
     "Ticket: “Báo cáo tiến độ tuần”. Lặp lại thứ 6 lúc 16:00. AI: PM (chỉ đọc code, comment được). Dán prompt ở mục 5.6 vào <b>Instruction</b>. Done when: <b>Summary comment</b>. Hợp với việc tổng hợp, không đụng vào code."),
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
    <div><b>Phần 1–4</b><span>Cài đặt: chuẩn bị, đội AI, tạo AI member, thiết lập còn lại</span></div>
    <div><b>Phần 5–8</b><span>Prompt để copy, cách viết prompt, ticket, giao việc</span></div>
    <div><b>Phần 9–10</b><span>Board AI (Ask AI) và lịch chạy tự động</span></div>
    <div><b>Phần 11–13</b><span>An toàn, xử lý sự cố, checklist</span></div>
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
  <div><i>2</i><b>Chọn đội AI</b><span>PM, Dev, Reviewer, General: vai, model, quyền.</span><em>Phần 2</em></div>
  <div><i>3</i><b>Tạo AI member</b><span>Members → tab AI → Add AI member, cho từng AI.</span><em>Phần 3</em></div>
  <div><i>4</i><b>Thiết lập còn lại</b><span>Chọn Board AI, cài đặt Board assistant, luật lệnh test.</span><em>Phần 4</em></div>
  <div><i>5</i><b>Dán prompt, giao việc</b><span>Persona và instructions có sẵn. Giao ticket nhỏ đầu tiên.</span><em>Phần 5–8</em></div>
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

# ---- Part 2: the team of AI members
team_rows = [
    ["<b>PM</b><br/>quản lý dự án", "Chuẩn bị ticket cho Dev: làm rõ, viết tiêu chí, estimate và priority, tách ticket lớn, báo cáo tuần. Không viết code.", "Sonnet", "Developer, rút quyền sửa file (xem 3.4)", "To Do", "10"],
    ["<b>Dev</b><br/>làm việc chung", "Nhận ticket đã sẵn sàng: sửa code, chạy test, báo cáo. Dừng ở Review.", "Sonnet", "Developer", "Review", "10"],
    ["<b>Reviewer</b>", "Kiểm tra ticket ở Review theo acceptance criteria. Không sửa code.", "Sonnet", "Reviewer", "Review", "20"],
    ["<b>General</b><br/>= Board AI", "Hỏi đáp, soạn nháp ticket, chia việc, gợi ý test case, báo cáo sức khoẻ board, Docs AI.", "Haiku", "Read-only", "None", "mặc định"],
]
p_team = f"""
<h2>2.1 Đội AI khuyên dùng: bốn AI, mỗi AI một vai</h2>
<p>Mỗi vai cần quyền, model và lời dặn khác nhau, nên tách thành các AI member riêng. Bốn AI dưới đây đủ cho phần lớn dự án nhỏ và vừa.</p>
{table(["AI", "Làm gì", "Model", "Template quyền", "Trần trạng thái", "Run mỗi ngày"], team_rows, "wide")}
<p>Cả bốn AI dùng loại <b>Claude Code</b>; chỉ khác model.</p>
<h2>2.2 Luồng làm việc</h2>
<div class="flow">
  <div><b>Ticket thô</b><span>Bạn viết, hoặc nhờ General nháp (Draft with AI)</span></div><i>→</i>
  <div><b>PM chuẩn bị</b><span>Làm rõ, tiêu chí, estimate, tách. Ticket sang <b>To Do</b></span></div><i>→</i>
  <div><b>Dev làm</b><span>Bạn giao ticket. Dev sửa code, chạy test, sang <b>Review</b></span></div><i>→</i>
  <div><b>Reviewer kiểm tra</b><span>Bạn @mention, chọn <b>Ask</b>. Nhận xét từng tiêu chí</span></div><i>→</i>
  <div><b>Bạn duyệt</b><span><b>Approve</b> sang Done, hoặc <b>Request changes</b></span></div>
</div>
<p>General (Ask AI) đứng bên ngoài luồng: bạn hỏi nó bất cứ lúc nào về board, ticket, tài liệu.</p>
{callout("note", "Bạn là người chuyển việc giữa các AI", "AI không tự giao việc cho nhau: chữ do một AI khác viết (ví dụ @mention từ AI) chỉ được coi là dữ liệu, không phải mệnh lệnh, và độ sâu chuỗi AI nhờ AI bị giới hạn (Max chain depth). Vì vậy bạn giao Dev sau khi PM xong, và gọi Reviewer sau khi Dev xong. Cách này cũng giữ cho mọi bước đều có người nhìn.")}
<h2>2.3 Vì sao thiết kế như vậy</h2>
{ol([
    "<b>Tách vai thì quyền gọn.</b> PM không sửa code, Reviewer không sửa gì, Dev không tự đưa ticket sang Done. Mỗi AI chỉ có quyền đúng với việc của nó.",
    "<b>PM có trần trạng thái To Do.</b> Nó dọn được backlog nhưng không bao giờ tự bắt đầu việc.",
    "<b>Reviewer là AI khác Dev.</b> Người kiểm tra không nên là chính phiên đã viết code: persona khác, phiên riêng, góc nhìn độc lập.",
    "<b>Một Dev chung cho cả repo khi mới bắt đầu.</b> Khi repo lớn, tách Dev Backend và Dev Frontend (mỗi AI một thư mục làm việc và một bộ instructions).",
    "<b>Model theo độ khó.</b> Sonnet cho việc cần suy luận (PM, Dev, Reviewer). Haiku cho hỏi đáp nhanh của General.",
    "<b>Mỗi AI chạy một run mỗi lần.</b> Hai run cùng sửa một thư mục dễ đè lên nhau.",
])}
<h2>2.4 General nên là Board AI</h2>
<p>Ask AI chính là trợ lý đa năng: trả lời về board, soạn nháp, tóm tắt, tìm ticket giống nhau. Vì vậy mình khuyên <b>General làm Board AI</b>, dùng Haiku, template <b>Read-only</b>. Nó không tự sửa gì: mọi thay đổi là bản nháp để bạn bấm Apply. Nếu sau này bạn cần một AI nhận việc nhỏ ngoài code (viết tài liệu, tổng hợp), vẫn giao được cho General vì persona của nó có sẵn ở Phần 5.4.</p>
<h2>2.5 Gợi ý thêm</h2>
{ul([
    "<b>Bắt đầu nhỏ:</b> tạo General, Dev, Reviewer trước; thêm PM khi backlog đủ lớn để cần người dọn.",
    "<b>QA / Tester:</b> chỉ thêm khi bạn có nhiều việc kiểm thử thủ công. Board AI đã có Suggest test cases gắn với tiêu chí.",
    "<b>Dev theo mảng:</b> khi repo có nhiều công nghệ, tách Dev Backend và Dev Frontend. Dev nào ở thư mục nào thì trỏ Working folder tới đó.",
    "<b>Lịch chạy (Phần 10):</b> Dev dọn test đỏ ban đêm, PM báo cáo tuần, Reviewer làm “AI review” cho các lần chạy đó.",
    "<b>Một AI cho nhiều dự án:</b> tạo một lần rồi tick thêm dự án (Phần 3.6). Riêng Board AI phải chọn lại ở từng dự án.",
    "<b>Đặt tên ngắn</b> như <code>PM</code>, <code>Dev</code>, <code>Reviewer</code>, <code>General</code> để @mention cho nhanh. Tên không được trùng người hay AI khác trong dự án.",
])}
"""
body_parts.append(section("2", "Thiết kế đội AI", "Quyết định cần những AI nào trước khi tạo. Đội bốn AI: PM, Dev, Reviewer, General.", p_team))

# ---- Part 3: create the members
VALUES_ROWS = [
    ["<b>1 · Type</b>", "Claude Code", "Claude Code", "Claude Code", "Claude Code"],
    ["<b>2 · Model</b>", "Sonnet", "Sonnet", "Sonnet", "Haiku"],
    ["<b>2 · Working folder</b>", "Thư mục repo", "Thư mục repo", "Thư mục repo", "Một thư mục <b>trống</b> riêng, ví dụ <code>C:\\Users\\ten\\board-ai</code>"],
    ["<b>3 · Name</b>", "<code>PM</code>", "<code>Dev</code>", "<code>Reviewer</code>", "<code>General</code>"],
    ["<b>3 · Short description</b>", "Chuẩn bị ticket: làm rõ, tiêu chí, estimate, tách việc", "Làm ticket theo acceptance criteria, chạy test, báo cáo", "Review ticket ở Review theo acceptance criteria", "Trả lời câu hỏi và soạn nháp cho board"],
    ["<b>3 · Role / persona</b>", "Dán persona PM (5.1)", "Dán persona Dev (5.2)", "Dán persona Reviewer (5.3)", "Để trống (Ask AI không dùng persona)"],
    ["<b>3 · Max parallel runs</b>", "1", "1", "1", "2 (mặc định)"],
    ["<b>3 · Max runs per day</b>", "10", "10", "20", "20 (mặc định)"],
    ["<b>4 · May move tickets up to</b>", "To Do", "Review", "Review", "None"],
    ["<b>4 · Ask a person first…</b>", "Bật: Change an assignee, Edit docs, Create tickets (tuần đầu)", "Bật: Change an assignee, Create tickets, Edit docs", "Giữ nguyên", "Giữ nguyên"],
    ["<b>Sau khi tạo · Role template</b>", "Developer (giữ)", "Developer (giữ)", "<b>Reviewer</b>", "<b>Read-only</b>"],
    ["<b>Sau khi tạo · luật CLI</b>", "Bỏ <code>Edit</code>, <code>Write</code> (3.4)", "Thêm lệnh test của bạn (4.3)", "Giữ mặc định", "—"],
]
p_members = f"""
<p>Cả bốn AI dùng chung một hộp thoại bốn bước. Phần này chỉ từng ô trong hộp thoại, bảng 3.3 cho giá trị điền của từng AI. <b>Tạo General trước</b>: AI đầu tiên của dự án (không tính loại “Other MCP client”) tự trở thành Board AI.</p>
<h2>3.1 Mở hộp thoại</h2>
<p>Bấm <b>Members</b> ở sidebar, chọn tab <b>AI</b>, rồi <b>Add AI member</b>. Hoặc vào <b>Settings → AI → Manage AI members</b>.</p>
{fig("a03-ai-empty-state", "Trang AI members khi chưa có AI. Ba lối bắt đầu nhanh: Claude Code, Antigravity, hoặc API key.", "80%")}
<h2>3.2 Từng bước và từng ô</h2>
{ol([
    "<b>Type</b>: chọn loại. Với cả bốn AI: <b>Claude Code</b>.",
    "<b>Connect</b>: app dò CLI, phiên bản và tài khoản đã đăng nhập. Điền <b>Working folder</b> và <b>Model</b> (Sonnet hoặc Haiku), rồi bấm <b>Run test</b> và chờ <b>Connection OK</b>. Không thấy CLI thì hộp thoại hướng dẫn cài đặt; thêm thư mục chứa <code>claude</code> vào PATH, mở lại app, bấm <b>Check again</b> (Phần 12).",
    "<b>Identity &amp; limits</b>: <b>Name</b> (không trùng), <b>Short description</b>, <b>Role / persona</b> (tối đa 1000 ký tự), <b>Max parallel runs</b> và <b>Max runs per day</b>. Với API key thì là <b>Daily budget</b> và <b>Monthly cap</b>.",
    "<b>Permissions &amp; review</b>: <b>May move tickets up to</b> (trần trạng thái: None, Backlog, To Do, In Progress, Review; Testing và Done cần xác nhận thêm) và các công tắc <b>Ask a person first before it can…</b>: Delete a ticket, Change an assignee, Create tickets, Edit docs. Bật công tắc nghĩa là hành động đó phải chờ bạn duyệt.",
])}
<p><b>Lưu ý:</b> hộp thoại này <b>không có ô chọn template quyền</b>. AI mới luôn mang template <b>Developer</b>; template chỉ đổi được sau khi tạo (3.4).</p>
{fig("a05-add-step2-connect", "Bước Connect: app thấy Claude Code CLI, phiên bản và tài khoản. Bấm Run test để chạy thử một lệnh thật.", "80%")}
{fig("a06-add-step3-identity", "Bước Identity &amp; limits: tên không được trùng người hay AI khác; persona tối đa 1000 ký tự; giới hạn chạy.", "80%")}
{fig("a07-add-step4-permissions", "Bước Permissions &amp; review: trần trạng thái và các hành động phải chờ bạn duyệt.", "80%")}
<div class="pagebreak"></div>
<h2>3.3 Giá trị điền cho từng AI</h2>
{table(["Ô", "PM", "Dev", "Reviewer", "General"], VALUES_ROWS, "wide values")}
<p>Các prompt cần dán (persona, instructions) có đủ ở Phần 5.</p>
<h2>3.4 Sau khi tạo: Role template và luật cho CLI</h2>
<p>Mở AI member, chọn tab <b>Permissions</b>. Thẻ <b>Role template</b> có bốn lựa chọn <b>Developer</b>, <b>Reviewer</b>, <b>Read-only</b>, <b>Custom</b> (Custom cần owner). Đặt Reviewer = <b>Reviewer</b> và General = <b>Read-only</b>. Bảng <b>What it may do</b> bên dưới cho thấy từng hành động đang ở mức Allowed, Needs approval hay Blocked, và đến từ đâu.</p>
{fig("u03-role-template", "Tab Permissions: Status ceiling, Role template (Developer, Reviewer, Read-only, Custom), bảng What it may do và thẻ Scope (chọn dự án).")}
<p><b>PM chỉ đọc code.</b> Template quyền chỉ điều khiển hành động trên ticket; việc AI sửa file do <b>luật của CLI</b> quyết định. Với PM: AI member → tab <b>Configuration → Permissions</b>, bỏ luật <code>Edit</code> và <code>Write</code>, giữ <code>Read</code>, <code>Glob</code>, <code>Grep</code> và các lệnh git đọc. Tuỳ chọn thêm: trong bảng What it may do, đặt <b>Create branches = Blocked</b>.</p>
<h2>3.5 Working folder và những gì có sẵn trong đó</h2>
<p>Nếu thư mục đã có <code>CLAUDE.md</code>, <code>.claude/</code>… thì AI <b>làm ticket</b> (PM, Dev, Reviewer) sẽ chịu ảnh hưởng. Board chạy CLI với <code>--permission-mode dontAsk</code>, <code>--strict-mcp-config</code> và <code>--append-system-prompt</code>, không tắt việc nạp cấu hình có sẵn.</p>
{table(
    ["Có sẵn trong thư mục", "Ảnh hưởng đến AI làm ticket"],
    [
        ["<code>CLAUDE.md</code>", "<b>Có.</b> AI đọc nó như quy ước dự án, cùng persona và Instructions của board."],
        ["<code>.claude/settings.json</code>", "<b>Có.</b> Luật allow và deny gộp với luật của board; các <b>hook</b> chạy thật khi AI dùng công cụ."],
        ["<code>.claude/skills</code>, <code>agents</code>, <code>commands</code>", "<b>Có thể.</b> AI dùng được skill và subagent trong đó."],
        ["<code>.mcp.json</code>", "<b>Không.</b> Board dùng <code>--strict-mcp-config</code>: chỉ MCP của board và server bạn thêm ở tab Configuration."],
        ["<code>~/.claude</code> (cấp người dùng)", "Cũng được nạp, vì CLI chạy dưới tài khoản của bạn."],
    ],
    "wide",
)}
{callout("warn", "Ba điều cần soát trước lần chạy đầu", "1) Luật <b>allow</b> trong <code>.claude/settings.json</code> có thể mở rộng quyền của AI (ví dụ cho <code>git push</code>). 2) <b>Hook</b> chạy thật: hook nhẹ như format thì hữu ích, hook chậm hoặc đòi tương tác có thể làm run bị treo. 3) Đừng để CLAUDE.md chứa luật quy trình như “luôn commit và push” hay “hỏi tôi trước khi làm”: nó xung đột với trần trạng thái và thẻ câu hỏi của board. CLAUDE.md nên giữ quy ước code và lệnh build, test.")}
<p><b>Board ghi gì vào thư mục?</b> Chỉ khi bạn lưu ở tab Configuration của AI member: đoạn giữa <code>&lt;!-- kanban:begin … --&gt;</code> và <code>&lt;!-- kanban:end --&gt;</code> trong <code>CLAUDE.md</code> (chữ ngoài hai dấu này là của bạn), cùng <code>.mcp.json</code> và các luật, hook board quản lý trong <code>.claude/settings.json</code>. Board hiện bản xem trước, tự gộp 3 chiều khi bạn sửa tay, và sao lưu vào <code>.claude/.kanban/</code>. Nên commit repo trước lần lưu đầu để <code>git diff</code> thấy rõ.</p>
<p><b>General (Board AI)</b> chạy khác: không công cụ, không MCP, bỏ qua settings của người dùng và dự án. Hãy cho nó một <b>thư mục trống</b> để chắc chắn không có gì trong repo tác động tới nó.</p>
<h2>3.6 Một AI member cho nhiều dự án</h2>
<p>Mặc định AI thuộc dự án nơi bạn tạo nó. Muốn dùng ở dự án khác: mở AI member, tab <b>Permissions</b>, thẻ <b>Scope</b>, tick thêm dự án (hoặc mục <b>Projects it can work in</b> trong phần sửa hồ sơ). Mỗi dự án được tick có một <b>bản sao liên kết</b>.</p>
{table(
    ["Dùng chung (sửa một bản thì các bản khác theo)", "Riêng từng dự án"],
    [
        ["Tên, avatar, cách kết nối, model, API key; persona và Configuration; quyền, trần trạng thái, safe mode; giới hạn chạy và <b>ngân sách (tính gộp mọi dự án)</b>", "<b>Working folder</b> (mỗi dự án trỏ repo của nó); danh sách run và ticket; <b>Board AI</b> (chọn riêng ở từng dự án)"],
    ],
    "wide",
)}
<p>Sau khi tick thêm dự án, hãy mở bản sao ở dự án đó và đặt lại <b>Working folder</b>. Thẻ Scope cũng cho chọn AI chỉ làm <b>ticket giao cho nó (hoặc nơi có thành viên @mention nó)</b> hay <b>mọi ticket trong các dự án</b> (rộng hơn, cần owner xác nhận). Nên để mức hẹp.</p>
"""
body_parts.append(section("3", "Tạo AI member", "Từng ô của hộp thoại, giá trị cho cả bốn AI, và những việc phải làm ngay sau khi tạo.", p_members))

# ---- Part 4: the rest of the setup
p_rest = f"""
<h2>4.1 Chọn Board AI</h2>
<p>Mở <b>Settings</b> ở sidebar, chọn trang <b>AI</b> (nhóm <i>Project settings</i>). Ở thẻ <b>BOARD AI</b>, bấm <b>Change</b> và chọn <b>General</b>. AI đó phải đang online (không báo lỗi key, chưa đăng nhập hay đang tạm dừng).</p>
{fig("t01-settings-ai", "Settings → AI: thẻ BOARD AI với nút Change, lối vào Library và Manage AI members, cùng phần an toàn và giới hạn chung.")}
{callout("note", "“Currently not chosen” nghĩa là gì?", "Dự án này chưa có Board AI. Board AI được chọn <b>riêng cho từng dự án</b>. AI đầu tiên bạn thêm tự thành Board AI; nút <b>Change</b> bị mờ nếu dự án chưa có AI nào. Nếu AI từng là Board AI đã bị xoá, ô này quay về “not chosen”. Hãy thêm AI (Phần 3) hoặc bấm Change để chọn lại. Loại “Other MCP client” không làm Board AI được.")}
<h2>4.2 Cài đặt Board assistant</h2>
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
{fig("t02-settings-assistant", "Settings → Board assistant: sáu công tắc tính năng, Language, Tone và Style guide for ticket drafts.")}
<p>Đặt <b>Language = Tiếng Việt</b>, <b>Tone = Concise</b>, và dán <b>Style guide</b> ở Phần 5.5. <b>Data scope</b> cho biết Board AI được đọc những gì ở từng dự án; <b>Excluded docs</b> là tài liệu riêng tư, không bao giờ gửi cho AI.</p>
<h2>4.3 Cho phép lệnh test của dự án</h2>
<p>AI làm ticket chỉ chạy được lệnh khớp một luật cho phép. Mặc định có: <code>Read</code>, <code>Glob</code>, <code>Grep</code>, <code>Edit</code>, <code>Write</code>, <code>git status</code>, <code>git diff</code>, <code>git log</code>, <code>pytest</code> (cả <code>python -m pytest</code>), <code>npm test</code>, <code>npm run test</code>, <code>npm run lint</code>. Mặc định bị chặn: <code>rm -rf</code>, <code>git push --force</code>, đọc <code>.env</code>. Lệnh của bạn không nằm trong danh sách thì thêm ở AI member → <b>Configuration → Permissions</b>, dạng <code>Bash(lệnh:*)</code>:</p>
{table(
    ["Công nghệ", "Luật cần thêm"],
    [
        [".NET", "<code>Bash(dotnet test:*)</code>, <code>Bash(dotnet build:*)</code>"],
        ["Go", "<code>Bash(go test:*)</code>"],
        ["Rust", "<code>Bash(cargo test:*)</code>"],
        ["Java", "<code>Bash(mvn test:*)</code> hoặc <code>Bash(./gradlew test:*)</code>"],
        ["Node (yarn, pnpm)", "<code>Bash(yarn test:*)</code>, <code>Bash(pnpm test:*)</code>"],
        ["Python (uv)", "<code>Bash(uv run pytest:*)</code>"],
        ["Cho phép commit", "<code>Bash(git add:*)</code>, <code>Bash(git commit:*)</code>"],
    ],
)}
{callout("warn", "Đừng thêm luật rộng", "Không thêm <code>git push</code>, <code>rm</code> hay <code>Bash(*)</code>. Mỗi lệnh nên chạy riêng; board hướng dẫn AI không nối lệnh bằng <code>&amp;&amp;</code>, <code>;</code>, <code>|</code>.")}
<h2>4.4 Giới hạn chung của board</h2>
<p>Cũng ở trang <b>Settings → AI</b>, phần <b>AI members · safety and limits</b>: <b>Safe mode</b> (AI chỉ đọc và comment), <b>Board daily cap</b> và <b>Board monthly budget</b> (đô la, cho AI dùng API key), <b>Max chain depth</b> (AI nhờ AI), <b>Runs per ticket a day</b> và <b>Approvals expire after</b>. Khởi đầu hợp lý: Max chain depth 2–3, Runs per ticket a day 3–6, Approvals expire 24 giờ. Với Claude Code (đăng nhập bằng gói thuê bao) chi phí hiển thị “not metered”, nên giới hạn thực tế là <b>Max runs per day</b> của từng AI.</p>
<h2>4.5 Kiểm tra cuối</h2>
{ul([
    "Mỗi AI: <b>Test connection</b> báo OK; trạng thái Idle.",
    "Settings → AI: thẻ BOARD AI hiện tên <b>General</b>, không còn “not chosen”.",
    "Mở Ask AI (Ctrl/Cmd + J), hỏi một câu như “Tóm tắt các ticket đang In Progress”.",
    "Giao một ticket nhỏ cho Dev (Phần 8) và xem tab <b>Run</b>.",
    "Khi ticket sang Review, @mention Reviewer với ý định <b>Ask</b>.",
])}
"""
body_parts.append(section("4", "Thiết lập còn lại", "Board AI, cài đặt Board assistant, lệnh test cho phép và giới hạn chung.", p_rest))

# ---- Part 5: copy-paste prompts
p_prompts = f"""
<h2>5.0 Dán vào đâu</h2>
{table(
    ["Prompt", "Dán ở đâu", "Dùng cho"],
    [
        ["<b>Persona</b>", "Hộp <b>Role / persona</b> khi tạo AI, hoặc AI member → Overview → <b>Edit persona</b>", "Vai và quy trình của AI, mọi run"],
        ["<b>Instructions</b>", "AI member → <b>Configuration → Instructions</b>", "Quy ước dự án, mọi run"],
        ["<b>Extra instruction</b>", "Ô <b>Extra instruction (optional)</b> khi giao ticket", "Lưu ý riêng cho một lần chạy"],
        ["<b>@mention</b>", "Ô comment của ticket", "Hỏi hoặc giao việc nhanh"],
        ["<b>Style guide</b>", "<b>Settings → Board assistant</b>", "Cách Board AI viết nháp ticket"],
        ["<b>Instruction của lịch</b>", "Trình soạn lịch → mục <b>Instruction</b>", "Việc chạy theo giờ"],
    ],
    "wide",
)}
<h2>5.1 PM</h2>
{prompt("PERSONA · PM", PERSONA_PM, 1000)}
{prompt("INSTRUCTIONS · PM", INSTR_PM)}
{''.join(prompt("@MENTION · PM · " + t, x) for t, x in PM_MENTIONS)}
<h2>5.2 Dev</h2>
{prompt("PERSONA · Dev", PERSONA_DEV, 1000)}
{prompt("INSTRUCTIONS · Dev (thay lệnh và thư mục bằng của dự án bạn)", INSTR_DEV)}
{callout("note", "Lệnh shell: viết dạng một lệnh đơn", "Claude Code trong board chỉ chạy lệnh <b>khớp hoàn toàn</b> một luật cho phép. Hãy ghi lệnh test dạng đơn giản như <code>pytest -q</code>, tránh nối bằng <code>&amp;&amp;</code>, <code>;</code>, <code>|</code>, <code>echo</code> hay <code>cd</code> (AI đã đứng sẵn trong thư mục dự án).")}
<h3>Extra instruction mẫu khi giao ticket cho Dev</h3>
{''.join(prompt(t, x) for t, x in EXTRA_EXAMPLES)}
<h2>5.3 Reviewer</h2>
{prompt("PERSONA · Reviewer", PERSONA_REVIEWER, 1000)}
{prompt("INSTRUCTIONS · Reviewer (thay lệnh test bằng của dự án)", INSTR_REVIEWER)}
{''.join(prompt("@MENTION · Reviewer · " + t, x) for t, x in REVIEWER_MENTIONS)}
<h2>5.4 General</h2>
<p>Persona này chỉ có tác dụng khi bạn <b>giao ticket</b> cho General. Với Ask AI, persona không được dùng (xem 5.5).</p>
{prompt("PERSONA · General", PERSONA_GENERAL, 1000)}
{prompt("INSTRUCTIONS · General", INSTR_GENERAL)}
{''.join(prompt("@MENTION · General · " + t, x) for t, x in GENERAL_MENTIONS)}
<h2>5.5 Board AI (Ask AI)</h2>
<p>Ba thứ đặt ở <b>Settings → Board assistant</b>: <b>Language</b> = Tiếng Việt, <b>Tone</b> = Concise, và <b>Style guide for ticket drafts</b>:</p>
{prompt("STYLE GUIDE · dán vào Settings → Board assistant (đổi KAN thành mã dự án của bạn)", STYLE_GUIDE, 1000)}
<h3>Câu hỏi mẫu cho Ask AI</h3>
{table(["Phạm vi", "Câu hỏi"], [[a, html.escape(b)] for a, b in BOARD_PROMPTS], "wide")}
<h2>5.6 Lịch chạy: báo cáo tuần của PM</h2>
<p>Trong trình soạn lịch (Phần 10), chọn AI là PM, lặp lại thứ 6 lúc 16:00, và dán vào mục <b>Instruction</b>:</p>
{prompt("INSTRUCTION · lịch báo cáo tuần (PM)", SCHED_PM_WEEKLY)}
"""
body_parts.append(section("5", "Prompt để copy", "Persona, instructions và câu lệnh mẫu cho từng AI. Dán và sửa vài chữ cho hợp dự án.", p_prompts))

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
    "<b>Cho AI lệnh để tự kiểm tra</b> (test, lint) và chắc chắn lệnh đó nằm trong danh sách cho phép (Phần 4.3).",
    "<b>Nêu phạm vi</b>: file hoặc thư mục được sửa, và một mục “Ngoài phạm vi”.",
    "<b>Cho ví dụ</b> hoặc trỏ tới mẫu có sẵn: “làm giống ticket KAN-12”.",
    "<b>Cho phép hỏi lại</b>: “thiếu thông tin thì hỏi, đừng đoán”. AI sẽ dừng và hiện thẻ câu hỏi cho bạn trả lời.",
    "<b>Viết câu khẳng định</b>: “Chỉ sửa trong /server” tốt hơn “đừng sửa lung tung”. Khi cấm điều gì, nói luôn nên làm gì thay thế.",
    "<b>Tránh từ mơ hồ</b> như “tối ưu”, “làm tốt hơn”. Thay bằng số hoặc hành vi: “giảm thời gian trả về dưới 200 ms”, “trả 20 bản ghi mỗi trang”.",
])}
{callout("warn", "Đừng dán bí mật vào prompt", "Không đưa API key, mật khẩu, token vào ticket, persona hay instructions. Board che các chuỗi trông giống key khi lưu bước chạy và nhật ký, nhưng cách an toàn nhất là không viết chúng ở đây.")}
"""
body_parts.append(section("6", "Prompt: AI đọc những gì", "Prompt chuẩn không phải một đoạn dài. Nó là năm lớp chữ, mỗi lớp viết một chỗ.", p4))

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
{callout("tip", "Dùng Board AI để viết ticket tốt hơn", "Gõ ý thô trong <b>New Ticket → Draft with AI</b>, hoặc bấm <b>Improve description</b> trên ticket có sẵn. Board AI trả về bản nháp có tiêu đề, mô tả, tiêu chí và ưu tiên; bạn chấp nhận từng phần (Phần 9). Rồi mới giao cho AI member.")}
<h2>6.3 Comment cũng là prompt</h2>
<p>AI đọc 20 comment gần nhất. Comment của thành viên dự án được tin cậy; comment của AI khác chỉ là dữ liệu; người ngoài dự án không được hiển thị cho AI (trừ khi bạn bật cho AI đó đọc nguồn ngoài). Khi AI làm sai hướng, <b>viết một comment rõ ràng</b> rồi Request changes sẽ hiệu quả hơn mở lại từ đầu.</p>
"""
body_parts.append(section("7", "Viết ticket để AI làm đúng", "Hai ticket cùng một lỗi, kết quả khác hẳn nhau tuỳ cách viết.", p6))

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
body_parts.append(section("8", "Giao việc, theo dõi, duyệt", "Từ lúc bấm Start đến lúc bạn Approve.", p7))

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
body_parts.append(section("9", "Dùng Board AI (Ask AI)", "Hỏi đáp và soạn nháp. Board AI không tự sửa gì ngoài ý bạn.", p8))

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
body_parts.append(section("10", "AI schedules: giao việc theo giờ", "AI làm việc khi bạn không ngồi đó, rồi tự kiểm tra bằng điều kiện bạn đặt.", p9))

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
body_parts.append(section("11", "An toàn và chi phí", "AI làm việc thật nên cần kiểm soát. Mọi thứ dưới đây đã có sẵn, bạn chỉ cần biết chỗ bật.", p10))

# ---- Part 11: troubleshooting
p11 = f"""
{callout("note", "Khi cần hỗ trợ", "Mở <b>Settings → Diagnostics → Application logs → Export logs</b>, gửi file log kèm phiên bản app (hiện trong file) và mô tả ngắn: bạn bấm gì, thấy gì, mong đợi gì.")}
{table(
    ["Dấu hiệu", "Nguyên nhân thường gặp", "Cách xử lý"],
    [
        ["““claude” was not found on this computer”", "Chưa cài CLI, hoặc app desktop không thấy thư mục chứa <code>claude</code> (app tự tìm trong PATH và các thư mục npm thông dụng như <code>%AppData%\\npm</code>).", "Chạy <code>where claude</code> (Windows) hoặc <code>which claude</code> để biết vị trí. Thêm thư mục đó vào <b>PATH</b>, <b>tắt hẳn rồi mở lại app</b>, bấm <b>Check again</b>."],
        ["Trạng thái “not signed in”", "CLI đã cài nhưng chưa đăng nhập.", "Mở terminal, chạy <code>claude</code>, đăng nhập, rồi <b>Test connection</b> trong app."],
        ["Thẻ BOARD AI hiện “Currently not chosen”", "Dự án chưa có Board AI. Board AI chọn riêng cho từng dự án; AI đầu tiên tự thành Board AI; nút Change bị mờ khi dự án chưa có AI.", "Thêm AI member (Phần 3), rồi Settings → AI → <b>Change</b>. AI phải online; lỗi key, chưa đăng nhập hoặc đang tạm dừng thì phải sửa trước."],
        ["“Choose a project folder inside your home folder…”", "Thư mục dự án nằm ngoài vùng cho phép.", "Chuyển repo vào thư mục home hoặc ổ khác, hoặc đặt <code>KANBAN_AI_ROOTS</code> (Phần 1.3) và mở lại app."],
        ["AI báo không chạy được lệnh test (lệnh bị từ chối)", "Lệnh test của bạn không nằm trong danh sách cho phép. Mặc định chỉ có git status/diff/log, pytest, npm test, npm run test/lint.", "AI member → <b>Configuration → Permissions</b>: thêm luật như <code>Bash(dotnet test:*)</code>, <code>Bash(go test:*)</code>, <code>Bash(uv run pytest:*)</code>. Muốn cho commit: <code>Bash(git add:*)</code>, <code>Bash(git commit:*)</code>. Mặc định không cho push."],
        ["Run dừng ở “Needs input”", "AI đang chờ bạn trả lời thẻ câu hỏi.", "Trả lời ở thẻ câu hỏi trên ticket hoặc trong Inbox. Có thể chọn “Answer later” hay “Ask someone else”."],
        ["“Rate limited” rồi tự chạy lại", "Nhà cung cấp giới hạn tốc độ.", "Đợi hết thời gian chờ (run xếp lại và chạy tự động) hoặc bấm <b>Retry now</b>."],
        ["“Key invalid” (API key)", "Key sai, hết hạn hoặc bị thu hồi.", "Sửa AI member, nhập key mới, bấm Test key."],
        ["Run “failed: the board restarted…”", "App bị đóng hoặc crash giữa chừng.", "Bấm Retry để tạo run mới. Process CLI còn sót sẽ được dọn khi app mở lại."],
        ["AI bị tạm dừng vì hết hạn mức", "Chạm daily budget, monthly cap hoặc run mỗi ngày.", "Chờ sang ngày mới hoặc tăng hạn mức. Owner có thể <b>Allow more runs</b> cho một ticket."],
        ["Pause run báo “not supported on Windows yet”", "Tạm dừng một run local cần tín hiệu của Linux/macOS. Run dùng API key vẫn tạm dừng được.", "Dùng <b>Stop</b> rồi chạy lại. <b>Pause all AI</b> (kill switch) vẫn dùng được."],
        ["Mất nút Ask AI hoặc Settings → AI quay mãi (Windows)", "Lỗi định dạng ngày ở bản trước 3.8.2.", "Cập nhật lên 3.8.2 trở lên. Nếu còn, mở <b>Settings → Diagnostics → Application logs → Export logs</b> và gửi file log."],
        ["AI làm sai hướng", "Ticket thiếu tiêu chí hoặc phạm vi.", "Viết comment rõ, <b>Request changes</b>. Sửa ticket theo khung ở Phần 7. Xem Run panel để biết AI hiểu sai ở bước nào."],
    ],
    "wide trouble",
)}
"""
body_parts.append(section("12", "Xử lý sự cố thường gặp", "Gần như mọi lỗi lần đầu rơi vào mười ba dấu hiệu dưới đây.", p11))

# ---- Part 12: checklist
p12 = f"""
<div class="check-grid">
<div class="check"><h3>Cài đặt (một lần)</h3>
<ul class="boxes">
<li>Cài và đăng nhập Claude Code CLI; <code>claude auth status</code> báo đã đăng nhập</li>
<li>Thư mục dự án là repo git, nằm trong home / ổ khác / <code>KANBAN_AI_ROOTS</code></li>
<li>Tạo 4 AI: General, PM, Dev, Reviewer; <b>Run test</b> báo Connection OK</li>
<li>Dán persona và Instructions của từng AI (Phần 5)</li>
<li>Role template: Reviewer = Reviewer, General = Read-only</li>
<li>PM: bỏ luật <code>Edit</code>, <code>Write</code> ở Configuration → Permissions</li>
<li>Lệnh test nằm trong luật cho phép (Configuration → Permissions)</li>
<li>Chọn General làm Board AI; Language Tiếng Việt; dán Style guide</li>
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
body_parts.append(section("13", "Checklist một trang", "In ra hoặc ghim lại. Đi qua từ trên xuống là đủ.", p12))

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
.flow { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr auto 1fr; align-items: stretch; gap: 3pt; margin: 6pt 0 10pt; }
.flow div { border: 1px solid #cfdcd1; border-radius: 8px; padding: 6pt 7pt; background: #f7faf7; }
.flow i { align-self: center; font-style: normal; color: #2E6F40; font-weight: 700; }
.flow div > b { display: block; font-size: 9pt; margin-bottom: 2pt; color: #14301f; }
.flow div > span { display: block; font-size: 8pt; color: #3d5345; line-height: 1.35; }
table.values td:first-child { width: 17%; }
table.values td { font-size: 8.6pt; padding: 4pt 6pt; }
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
