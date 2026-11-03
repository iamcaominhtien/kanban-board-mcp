// Demo video of fast mode on a ticket and on a comment that tags an AI, recorded from the web app with REAL AI runs.
//
//   1. ui/dist built (cd ui && npx vite build), server/.venv synced (cd server && uv sync), `claude` signed in
//   2. node docs/demo/fast-mode/record_comments_demo.js <out.mp4> [screenshots dir]
//
// One project with one AI member, Dev An (the Dev role pack: Sonnet at medium), running the real `claude` CLI on a
// small Python repository, and three tickets with no workflow and no AI on them:
//   SHOP-1: a person turns Fast on in the ticket header. Nothing runs. Then they tag @Dev An in a comment with a
//           question: the answer comes from a fast run (one effort level lower, told to go straight to the point).
//   SHOP-2: the same question at the normal pace.
//   SHOP-3: a normal ticket; Fast ticked on that one comment only (the ticket stays normal).
// Then "Do the work" from a comment on SHOP-1 (fast) and SHOP-2 (normal): the same change, each in its own worktree,
// checked with the same acceptance test the AI never saw. A warm-up question in another project runs first, off
// camera, so the first timed run does not pay for the CLI's cold start. Waiting is fast-forwarded (marked ⏩), the rest
// plays at real speed. At the end, each answer and change with its time, effort and tokens.
const { chromium } = require("playwright");
const { spawn, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const [OUT = path.join(process.cwd(), "fast-mode-comments-demo.mp4"), SHOTS] =
  process.argv.slice(2);
const WORK = process.env.DEMO_DIR || "/tmp/fast-mode-comments-demo";
const PORT = 8777;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1600;
const H = 900;
const BAND = 120;
const FF = Number(process.env.DEMO_FF || 8);
const PY = path.join(ROOT, "server", ".venv", "bin", "python");
const CLAUDE =
  process.env.CLAUDE_CLI ||
  execFileSync("sh", ["-c", "command -v claude"]).toString().trim();

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "video"), { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// The repository the AI reads to answer
const REPO = path.join(WORK, "shop");
const files = {
  "cart.py":
    '"""The shopping cart."""\n\nCODES = {"SAVE10": 0.10}\n\n\n' +
    "def total(items: list[dict], code: str | None = None) -> float:\n" +
    '    """The cart total: the sum of price * qty, less the discount of a code."""\n' +
    '    amount = sum(i["price"] * i["qty"] for i in items)\n' +
    "    if code:\n" +
    "        amount -= amount * CODES.get(code.upper(), 0)\n" +
    "    return round(amount, 2)\n",
  "tests/__init__.py": "",
  "tests/test_cart.py":
    "import unittest\n\nfrom cart import total\n\n\n" +
    "class Total(unittest.TestCase):\n" +
    "    def test_sum(self):\n" +
    '        self.assertEqual(total([{"price": 2.5, "qty": 2}, {"price": 1, "qty": 3}]), 8)\n\n' +
    "    def test_save10(self):\n" +
    '        self.assertEqual(total([{"price": 10, "qty": 1}], code="save10"), 9)\n',
};
for (const [f, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), text);
}
const git = (...a) => execFileSync("git", a, { cwd: REPO });
git("init", "-q", "-b", "main");
git("add", "-A");
git(
  "-c",
  "user.name=An",
  "-c",
  "user.email=an@example.com",
  "commit",
  "-qm",
  "Shop",
);

const QUESTION =
  "What does total() in cart.py do with an unknown discount code, and is that tested?";
const WORK_ASK =
  "Make total() raise ValueError naming the code when the discount code is unknown, and add a test for it.";
const ACCEPTANCE = `import unittest

from cart import total


class Acceptance(unittest.TestCase):
    def test_unknown_code_raises_and_names_it(self):
        with self.assertRaises(ValueError) as e:
            total([{"price": 10, "qty": 1}], code="BOGUS")
        self.assertIn("BOGUS", str(e.exception))

    def test_known_code_still_works(self):
        self.assertEqual(total([{"price": 10, "qty": 1}], code="save10"), 9)

    def test_no_code(self):
        self.assertEqual(total([{"price": 2.5, "qty": 2}]), 5)


if __name__ == "__main__":
    unittest.main()
`;

// ---------------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caps = [];
const segs = [];
let t0 = 0;
let current = null;
let ffOn = null;
const now = () => (Date.now() - t0) / 1000;
function caption(text) {
  const t = now();
  if (current) current.end = t;
  current = { start: t, end: null, text };
  caps.push(current);
  console.log(`[${t.toFixed(1)}s] ${text}`);
}
function ff(on) {
  const t = now();
  if (on && ffOn === null) ffOn = t;
  if (!on && ffOn !== null) {
    segs.push({ start: ffOn, end: t });
    ffOn = null;
  }
}
function outTime(t) {
  let out = t;
  for (const s of segs) {
    if (t <= s.start) break;
    const inside = Math.min(t, s.end) - s.start;
    out -= inside - inside / FF;
  }
  return out;
}
const assTime = (s) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
function writeAss(file, total) {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H + BAND}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Band,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,60,60,${Math.round(BAND / 2 - 30)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const c of caps) {
    const a = outTime(c.start);
    const b = outTime(c.end ?? total);
    if (b - a < 0.05) continue;
    lines.push(
      `Dialogue: 0,${assTime(a)},${assTime(b)},Band,,0,0,0,,${c.text.replace(/\n/g, "\\N")}`,
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "An Nguyen" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const mins = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec < 60
    ? `${sec}s`
    : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
};
// the run as the board recorded it: its effort, model, tokens, start and end, and its instruction
function runRow(tid) {
  const q = spawnSync(
    PY,
    [
      "-c",
      "import json,sqlite3,sys;c=sqlite3.connect(sys.argv[1]);" +
        'print(json.dumps([dict(zip(("id","mode","state","model","effort","tin","tout","cached","start","end","instruction"),r)) for r in c.execute(' +
        '"select id,mode,state,model,effort_override,tokens_in,tokens_out,coalesce(tokens_cached,0),started_at,ended_at,instruction ' +
        'from ai_run where ticket_id=? order by number",(sys.argv[2],))]))',
      path.join(WORK, "kanban.db"),
      tid,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(q.stdout || "[]");
}
async function waitAnswer(tid, n = 1, timeout = 600000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const runs = await api("GET", `/tickets/${tid}/ai/runs`);
    if (
      runs.length >= n &&
      runs
        .slice(0, n)
        .every((r) =>
          ["finished", "failed", "cancelled", "needs_input"].includes(r.state),
        )
    )
      return runs[0];
    await sleep(1000);
  }
  throw new Error(`no answer on ${tid}`);
}
// the change on the ticket's branch (its worktree), checked with the acceptance test and its own tests
function check(tid) {
  const wt = path.join(`${REPO}.worktrees`, tid);
  const dir = fs.existsSync(wt) ? wt : REPO;
  const acc = path.join(WORK, `acceptance-${tid}`);
  fs.rmSync(acc, { recursive: true, force: true });
  fs.mkdirSync(acc);
  fs.copyFileSync(path.join(dir, "cart.py"), path.join(acc, "cart.py"));
  fs.writeFileSync(path.join(acc, "test_acceptance.py"), ACCEPTANCE);
  const a = spawnSync("python3", ["-m", "unittest", "test_acceptance", "-v"], {
    cwd: acc,
    encoding: "utf8",
  });
  const passed = ((a.stdout + a.stderr).match(/ \.\.\. ok/g) || []).length;
  const own = spawnSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests", "-t", "."],
    { cwd: dir, encoding: "utf8" },
  );
  const ran = ((own.stdout + own.stderr).match(/^Ran (\d+)/m) || [])[1] || "0";
  return {
    acceptance: `${passed} of 3`,
    own: `${own.status === 0 ? "pass" : "FAIL"} (${ran} tests)`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
(async () => {
  const server = spawn(
    path.join(ROOT, "server", ".venv", "bin", "uvicorn"),
    ["main:app", "--port", String(PORT)],
    {
      cwd: path.join(ROOT, "server"),
      env: {
        ...process.env,
        KANBAN_DB_PATH: path.join(WORK, "kanban.db"),
        KANBAN_PORT: String(PORT),
        PORT: String(PORT),
        KANBAN_AI_ROOTS: WORK,
        KANBAN_SECRET_STORE: "file",
        KANBAN_AI_RUNS_DIR: path.join(WORK, "runs"),
        KANBAN_WORKSPACE_ROOT: path.join(WORK, "workspaces"),
        KANBAN_BOARD_URL: BASE,
      },
      stdio: [
        "ignore",
        fs.openSync(path.join(WORK, "server.log"), "w"),
        fs.openSync(path.join(WORK, "server.err"), "w"),
      ],
    },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  // off camera: one question in another project, so the CLI's cold start is not in the first timed run
  const warm = await api("POST", "/projects", {
    name: "Warm-up",
    prefix: "WARM",
    color: "#5B6B60",
  });
  await api("POST", `/projects/${warm.id}/members`, {
    name: "An Nguyen",
    role: "admin",
  });
  const warmDev = await api(
    "POST",
    `/projects/${warm.id}/ai/packs/dev/member`,
    { name: "Dev Warm", working_dir: REPO },
  );
  await api("PATCH", `/ai/members/${warmDev.id}`, { cli_path: CLAUDE });
  const warmT = (
    await api("POST", `/projects/${warm.id}/tickets`, {
      title: "Warm-up",
      status: "todo",
    })
  ).id;
  await api("POST", `/tickets/${warmT}/ai/ask`, {
    member_id: warmDev.id,
    question: "What does cart.py do? One line.",
  });
  await waitAnswer(warmT);
  console.log("warmed up");

  const project = await api("POST", "/projects", {
    name: "Shop",
    prefix: "SHOP",
    color: "#2E6F40",
  });
  const pid = project.id;
  await api("POST", `/projects/${pid}/members`, {
    name: "An Nguyen",
    role: "admin",
  });
  const dev = await api("POST", `/projects/${pid}/ai/packs/dev/member`, {
    name: "Dev An",
    working_dir: REPO,
  });
  await api("PATCH", `/ai/members/${dev.id}`, { cli_path: CLAUDE });
  await api("PATCH", `/projects/${pid}/ai/ops`, {
    commands: { test: "python3 -m unittest discover -s tests -t ." },
    worktrees: { on: true, handover: "branch" },
  });
  const mk = async (title) =>
    (
      await api("POST", `/projects/${pid}/tickets`, {
        title,
        description: "Discount codes at checkout.",
        status: "todo",
      })
    ).id;
  const t1 = await mk("Discount codes: what happens with a bad code?");
  const t2 = await mk("Discount codes: what happens with a bad code? (normal)");
  const t3 = await mk(
    "Discount codes: what happens with a bad code? (one fast comment)",
  );

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: {
      dir: path.join(WORK, "video"),
      size: { width: W, height: H },
    },
  });
  await ctx.addInitScript(
    ([p]) => {
      localStorage.setItem("activeProjectId", p);
      localStorage.setItem("kanbanActor", "An Nguyen");
    },
    [pid],
  );
  const page = await ctx.newPage();
  const shot = async (name) =>
    SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const openTicket = async (tid) => {
    await page.goto(`${BASE}/?proj=${pid}&ticket=${tid}`);
    await page.getByTestId("view-ticket").waitFor({ timeout: 20000 });
    await sleep(800);
  };
  // write the question as a person does: @Dev An …, then Comment (or Fast first)
  const comment = async (tickFast, text = QUESTION, work = false) => {
    const collapsed = page
      .locator('[data-testid="comment-collapsed"]:visible')
      .first();
    await collapsed.scrollIntoViewIfNeeded();
    await collapsed.click();
    const box = page
      .locator('[data-testid="comment-textarea"]:visible')
      .first();
    await box.click();
    await box.pressSequentially(`@Dev An ${text}`, { delay: 10 });
    await page
      .locator('[data-testid="comment-ai-pill"]:visible')
      .first()
      .waitFor({ timeout: 10000 });
    if (work) {
      await page.locator('[data-testid="plan-work"]:visible').first().click();
      await sleep(1000);
    }
    await page
      .locator('[data-testid="comment-send"]:visible')
      .first()
      .scrollIntoViewIfNeeded();
    await sleep(1200);
    if (tickFast) {
      await page
        .locator('[data-testid="comment-fast"]:visible')
        .first()
        .click();
      await sleep(1500);
    }
  };
  const send = async () => {
    await page.locator('[data-testid="comment-send"]:visible').first().click();
    return Date.now();
  };
  const showAnswer = async () => {
    await page.reload();
    await page.getByTestId("view-ticket").waitFor({ timeout: 20000 });
    await sleep(800);
    const last = page.locator("[data-comment-id]").last();
    await last.scrollIntoViewIfNeeded().catch(() => {});
  };
  t0 = Date.now();

  // ---- SHOP-1: Fast on, nothing runs
  caption(
    "Fast mode on a ticket, and on a comment that tags an AI · real Claude Code runs",
  );
  await openTicket(t1);
  await sleep(2500);
  caption(
    "SHOP-1 has no workflow and no AI on it · ⚡ Fast in the ticket header",
  );
  await page.getByTestId("ticket-pace").scrollIntoViewIfNeeded();
  await sleep(2000);
  await page.getByTestId("ticket-pace").click();
  await sleep(1500);
  await shot("c1-pace-on");
  const runsAfterToggle = (await api("GET", `/tickets/${t1}/ai/runs`)).length;
  caption(
    `Fast is on, and nothing ran: ${runsAfterToggle} AI runs on SHOP-1 · it applies when an AI starts on the ticket`,
  );
  await sleep(5000);

  // ---- SHOP-1: tag the AI in a comment
  caption(
    "Tag Dev An in a comment with a question · the composer says the ticket is fast already",
  );
  await comment(false);
  await page
    .locator('[data-testid="comment-fast-ticket"]:visible')
    .first()
    .waitFor({ timeout: 5000 });
  await sleep(2500);
  await shot("c2-composer-ticket-fast");
  const s1 = await send();
  caption(
    "⏩ Dev An answers in a fast run (one effort level lower, told to go straight to the point)",
  );
  ff(true);
  await waitAnswer(t1);
  const e1 = Date.now();
  ff(false);
  await showAnswer();
  caption(`SHOP-1 (fast ticket): answered in ${mins(e1 - s1)}`);
  await sleep(6000);
  await shot("c3-fast-answer");

  // ---- SHOP-2: the same question at the normal pace
  caption("SHOP-2 · a normal ticket · the same question, Fast not ticked");
  await openTicket(t2);
  await comment(false);
  await sleep(1000);
  const s2 = await send();
  caption("⏩ Dev An answers at its own effort (medium)");
  ff(true);
  await waitAnswer(t2);
  const e2 = Date.now();
  ff(false);
  await showAnswer();
  caption(`SHOP-2 (normal): answered in ${mins(e2 - s2)}`);
  await sleep(6000);
  await shot("c4-normal-answer");

  // ---- SHOP-3: Fast ticked on one comment
  caption("SHOP-3 · a normal ticket · ⚡ Fast ticked on this one comment");
  await openTicket(t3);
  await comment(true);
  await shot("c5-composer-comment-fast");
  const s3 = await send();
  caption("⏩ A fast run for this answer; the ticket stays at the normal pace");
  ff(true);
  await waitAnswer(t3);
  const e3 = Date.now();
  ff(false);
  await showAnswer();
  const pace3 = (await api("GET", `/tickets/${t3}/ai/pace`)).pace;
  caption(
    `SHOP-3: answered in ${mins(e3 - s3)} · the ticket's pace is still ${pace3}`,
  );
  await sleep(6000);
  await shot("c6-comment-fast-answer");

  // ---- Do the work from a comment: SHOP-1 (fast ticket) and SHOP-2 (normal), the same change
  caption("Now “Do the work” from a comment · SHOP-1, the fast ticket");
  await openTicket(t1);
  await comment(false, WORK_ASK, true);
  await shot("c8-work-fast-composer");
  const w1s = await send();
  caption("⏩ Dev An changes the code in a fast work run (its own worktree)");
  ff(true);
  await waitAnswer(t1, 2);
  const w1e = Date.now();
  ff(false);
  await showAnswer();
  caption(`SHOP-1 (fast): the change is done in ${mins(w1e - w1s)}`);
  await sleep(5000);
  await shot("c9-work-fast-done");
  caption("SHOP-2, the normal ticket · the same change");
  await openTicket(t2);
  await comment(false, WORK_ASK, true);
  const w2s = await send();
  caption("⏩ Dev An changes the code at its own effort");
  ff(true);
  await waitAnswer(t2, 2);
  const w2e = Date.now();
  ff(false);
  await showAnswer();
  caption(`SHOP-2 (normal): the change is done in ${mins(w2e - w2s)}`);
  await sleep(5000);
  await shot("c10-work-normal-done");

  // ---- the result
  // Dev An's comments on the ticket, oldest first: the answer to the question, then the note of the change
  const aiComments = async (tid) => {
    const t = await api("GET", `/tickets/${tid}`);
    return (t.comments || [])
      .filter((x) => x.author === "Dev An" || (x.ai && x.ai.member_id))
      .sort((a, b) =>
        String(a.createdAt || a.created_at || "").localeCompare(
          String(b.createdAt || b.created_at || ""),
        ),
      )
      .map((c) => (c.text || "").replace(/\s+/g, " ").trim());
  };
  const answer = async (tid) => (await aiComments(tid))[0] || "";
  const rows = [];
  for (const [tid, label, ms] of [
    [t1, "SHOP-1 · ⚡ fast ticket", e1 - s1],
    [t2, "SHOP-2 · normal", e2 - s2],
    [t3, "SHOP-3 · normal, ⚡ on the comment", e3 - s3],
  ]) {
    const r = runRow(tid).find((x) => x.mode === "ask") || {};
    rows.push({
      ticket: tid,
      label,
      ms,
      effort: r.effort || "medium (its own)",
      model: r.model,
      tokens: (r.tin || 0) + (r.tout || 0),
      fresh: (r.tin || 0) - (r.cached || 0) + (r.tout || 0),
      told: /Fast mode/.test(r.instruction || ""),
      answer: await answer(tid),
      pace: (await api("GET", `/tickets/${tid}/ai/pace`)).pace,
    });
  }
  const work = [];
  for (const [tid, label, ms] of [
    [t1, "SHOP-1 · ⚡ fast ticket", w1e - w1s],
    [t2, "SHOP-2 · normal", w2e - w2s],
  ]) {
    const r = runRow(tid).find((x) => x.mode === "work") || {};
    work.push({
      ticket: tid,
      label,
      ms,
      effort: r.effort || "medium (its own)",
      tokens: (r.tin || 0) + (r.tout || 0),
      fresh: (r.tin || 0) - (r.cached || 0) + (r.tout || 0),
      state: r.state,
      note: (await aiComments(tid)).slice(-1)[0] || "",
      ...check(tid),
    });
  }
  fs.writeFileSync(
    path.join(WORK, "report.json"),
    JSON.stringify({ runsAfterToggle, rows, work }, null, 2),
  );
  console.log(JSON.stringify({ runsAfterToggle, rows, work }, null, 2));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#F6F8F6;color:#1E2A22;display:grid;place-items:center;min-height:100vh}
  .card{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(30,42,34,.08);padding:30px 38px;width:1440px;box-sizing:border-box}
  h1{font-size:24px;margin:0 0 2px} p.sub{margin:0 0 18px;color:#5B6B60}
  table{border-collapse:collapse;width:100%;table-layout:fixed} th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #E6ECE7;vertical-align:top}
  th{color:#5B6B60;font-weight:600;width:200px} thead td{font-weight:700;font-size:16px} .f{color:#7A5A06}
  td.a{font-size:13px;color:#33433A;max-height:150px;overflow:hidden}
  </style><div class="card"><h1>@Dev An in a comment, three ways</h1>
  <p class="sub">The same question, real Claude Code runs · turning Fast on started ${runsAfterToggle} runs</p>
  <table><thead><tr><th></th>${rows.map((x) => `<td class="${/fast/.test(x.label) ? "f" : ""}">${esc(x.label)}</td>`).join("")}</tr></thead>
  <tr><th>Answered in</th>${rows.map((x) => `<td>${mins(x.ms)}</td>`).join("")}</tr>
  <tr><th>Effort · model</th>${rows.map((x) => `<td>${esc(x.effort)} · ${esc((x.model || "").replace(/^claude-/, ""))}</td>`).join("")}</tr>
  <tr><th>Told “Fast mode”</th>${rows.map((x) => `<td>${x.told ? "yes" : "no"}</td>`).join("")}</tr>
  <tr><th>Tokens</th>${rows.map((x) => `<td>${x.tokens.toLocaleString("en")} <span style="color:#5B6B60">(${x.fresh.toLocaleString("en")} not from cache)</span></td>`).join("")}</tr>
  <tr><th>Ticket's pace after</th>${rows.map((x) => `<td>${x.pace}</td>`).join("")}</tr>
  <tr><th>The answer</th>${rows.map((x) => `<td class="a">${esc(x.answer.slice(0, 260))}${x.answer.length > 260 ? "…" : ""}</td>`).join("")}</tr>
  </table>
  <h1 style="margin-top:22px;font-size:20px">“Do the work” from a comment</h1>
  <table><thead><tr><th></th>${work.map((x) => `<td class="${/fast/.test(x.label) ? "f" : ""}">${esc(x.label)}</td>`).join("")}</tr></thead>
  <tr><th>Done in</th>${work.map((x) => `<td>${mins(x.ms)}</td>`).join("")}</tr>
  <tr><th>Effort</th>${work.map((x) => `<td>${esc(x.effort)}</td>`).join("")}</tr>
  <tr><th>Tokens</th>${work.map((x) => `<td>${x.tokens.toLocaleString("en")} <span style="color:#5B6B60">(${x.fresh.toLocaleString("en")} not from cache)</span></td>`).join("")}</tr>
  <tr><th>Its own tests</th>${work.map((x) => `<td>${x.own}</td>`).join("")}</tr>
  <tr><th>Hidden acceptance test</th>${work.map((x) => `<td>${x.acceptance}</td>`).join("")}</tr>
  <tr><th>What it said</th>${work.map((x) => `<td class="a">${esc(x.note.slice(0, 200))}${x.note.length > 200 ? "…" : ""}</td>`).join("")}</tr>
  </table></div>`);
  const close = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.3;
  caption(
    `${close(rows[0].ms, rows[1].ms) ? "A short question takes about as long either way (the CLI starting and reading the code)" : `The question: ${mins(rows[0].ms)} fast, ${mins(rows[1].ms)} normal`} · ` +
      `the change: ${mins(work[0].ms)} fast, ${mins(work[1].ms)} normal`,
  );
  await sleep(14000);
  await shot("c7-summary");
  caption(
    "Recorded in the web app with Playwright · every answer is a real Claude Code run",
  );
  await sleep(3500);

  const total = now();
  if (current) current.end = total;
  const video = page.video();
  await ctx.close();
  await browser.close();
  server.kill("SIGTERM");
  const raw = await video.path();
  const ass = path.join(WORK, "captions.ass");
  writeAss(ass, total);
  const parts = [];
  let at = 0;
  for (const s of segs) {
    if (s.start > at) parts.push({ a: at, b: s.start, speed: 1 });
    parts.push({ a: s.start, b: s.end, speed: FF });
    at = s.end;
  }
  parts.push({ a: at, b: total, speed: 1 });
  const list = [];
  parts.forEach((p, i) => {
    const f = path.join(WORK, `part${i}.mp4`);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      p.a.toFixed(3),
      "-to",
      p.b.toFixed(3),
      "-i",
      raw,
      "-vf",
      `setpts=PTS/${p.speed}`,
      "-r",
      "25",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      f,
    ]);
    list.push(`file '${f}'`);
  });
  fs.writeFileSync(path.join(WORK, "parts.txt"), list.join("\n") + "\n");
  const joined = path.join(WORK, "joined.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    path.join(WORK, "parts.txt"),
    "-c",
    "copy",
    joined,
  ]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    joined,
    "-vf",
    `pad=${W}:${H + BAND}:0:0:color=0x14211A,subtitles=${ass}`,
    "-c:v",
    "libx264",
    "-crf",
    "28",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    OUT,
  ]);
  console.log("wrote", OUT);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
