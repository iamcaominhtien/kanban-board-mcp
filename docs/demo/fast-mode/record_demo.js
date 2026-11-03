// Demo video of fast mode on a ticket's workflow, recorded from the web app with REAL AI runs (Claude Code).
//
//   1. ui/dist built (cd ui && npx vite build), server/.venv synced (cd server && uv sync), `claude` signed in
//   2. node docs/demo/fast-mode/record_demo.js <out.mp4> [screenshots dir]
//
// It starts the board on a throwaway database with one project and its AI team (Triage, BA, Dev, QA, Reviewer, made
// from the role packs, each running the real `claude` CLI with its pack's model), a small Python repository and two
// tickets asking for the same change. SHOP-1 goes on "Standard feature" at the normal pace, SHOP-2 on the same
// workflow in fast mode; both run at the same time, each in its own worktree. Waiting is fast-forwarded (marked ⏩),
// everything else plays at real speed. At the end the same acceptance tests, written beforehand and never shown to the
// AIs, are run on both branches. Captions go in a band under the picture, from an .ass file timed while recording.
const { chromium } = require("playwright");
const { spawn, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const [OUT = path.join(process.cwd(), "fast-mode-demo.mp4"), SHOTS] =
  process.argv.slice(2);
const WORK = process.env.DEMO_DIR || "/tmp/fast-mode-demo";
const PORT = 8776;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1600;
const H = 900;
const BAND = 120;
const FF = Number(process.env.DEMO_FF || 16); // the speed of a fast-forwarded stretch
const PY = path.join(ROOT, "server", ".venv", "bin", "python");
const CLAUDE =
  process.env.CLAUDE_CLI ||
  execFileSync("sh", ["-c", "command -v claude"]).toString().trim();
const LIMIT_MIN = Number(process.env.DEMO_LIMIT_MIN || 45);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "video"), { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// The repository: a cart total with one test; the change asked for is discount codes
const REPO = path.join(WORK, "shop");
const files = {
  "cart.py":
    '"""The shopping cart."""\n\n\n' +
    "def total(items: list[dict]) -> float:\n" +
    '    """The cart total: the sum of price * qty."""\n' +
    '    return sum(i["price"] * i["qty"] for i in items)\n',
  "tests/__init__.py": "",
  "tests/test_cart.py":
    "import unittest\n\nfrom cart import total\n\n\n" +
    "class Total(unittest.TestCase):\n" +
    "    def test_sum(self):\n" +
    '        self.assertEqual(total([{"price": 2.5, "qty": 2}, {"price": 1, "qty": 3}]), 8)\n',
  "README.md":
    "# Shop\n\nRun the tests with `python3 -m unittest discover -s tests -t .`\n",
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

// The acceptance tests a person wrote beforehand; the AIs never see them. Run on each branch at the end.
const ACCEPTANCE = `import unittest

from cart import total

ITEMS = [{"price": 19.99, "qty": 1}, {"price": 5.01, "qty": 2}]  # 30.01


class Acceptance(unittest.TestCase):
    def test_no_code_is_unchanged(self):
        self.assertAlmostEqual(total(ITEMS), 30.01, places=2)

    def test_save10_takes_ten_percent_off(self):
        self.assertAlmostEqual(total(ITEMS, code="SAVE10"), 27.01, places=2)

    def test_lowercase_code_works(self):
        self.assertAlmostEqual(total(ITEMS, code="save10"), 27.01, places=2)

    def test_unknown_code_raises_and_names_it(self):
        with self.assertRaises(ValueError) as e:
            total(ITEMS, code="BOGUS")
        self.assertIn("BOGUS", str(e.exception))

    def test_free_ship_is_five_off_never_below_zero(self):
        self.assertAlmostEqual(total(ITEMS, code="FREESHIP"), 25.01, places=2)
        self.assertEqual(total([{"price": 3, "qty": 1}], code="FREESHIP"), 0)

    def test_empty_cart(self):
        self.assertEqual(total([], code="SAVE10"), 0)


if __name__ == "__main__":
    unittest.main()
`;

const TASK = {
  description:
    "Customers can enter a discount code at checkout. `total(items, code=None)` in `cart.py` applies it.\n\n" +
    "Codes: `SAVE10` takes 10% off the total; `FREESHIP` takes 5.00 off, never below zero. Codes are not case " +
    "sensitive. The total is rounded to 2 decimals.",
  criteria: [
    "total(items) without a code returns the same total as before",
    "SAVE10 takes 10% off; FREESHIP takes 5.00 off and never goes below zero; codes are case-insensitive",
    "An unknown code raises ValueError and the message names the code",
    "The total is rounded to 2 decimals, and the tests cover each code",
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Captions and the fast-forwarded stretches
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caps = [];
const segs = []; // {start, end, speed} in seconds of the raw recording
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
// raw time -> time in the cut video
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
const assText = (s) => s.replace(/\n/g, "\\N");
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
      `Dialogue: 0,${assTime(a)},${assTime(b)},Band,,0,0,0,,${assText(c.text)}`,
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
const OPEN = ["pending", "active", "waiting", "blocked", "failed"];
const currentStep = (v) => v && v.steps.find((s) => OPEN.includes(s.state));
const atDone = (v) => {
  const c = currentStep(v);
  return (
    !!v &&
    (v.state !== "active" || (c && c.key === "done" && c.state === "waiting"))
  );
};
const stuck = (v) => {
  const c = currentStep(v);
  return (
    !!v &&
    (v.state === "stopped" || (c && ["blocked", "failed"].includes(c.state)))
  );
};
const mins = (ms) => {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
};
function where(v) {
  if (!v) return "…";
  if (atDone(v)) return "waits for you at Done ✔";
  const c = currentStep(v);
  if (!c) return v.state;
  return `${c.label}${c.memberName ? ` (${c.memberName})` : ""} · ${c.state === "active" ? "working" : c.state}`;
}

async function summary(tid, startedAt, endedAt) {
  const view = await api("GET", `/tickets/${tid}/ai/workflow`);
  // every run of the ticket, as the board recorded it: the model it was served, its effort, its tokens
  const q = spawnSync(
    PY,
    [
      "-c",
      "import json,sqlite3,sys;c=sqlite3.connect(sys.argv[1]);" +
        'print(json.dumps([dict(zip(("mode","model","effort","tin","tout","cached","who"),r)) for r in c.execute(' +
        '"select r.mode,r.model,r.effort_override,r.tokens_in,r.tokens_out,coalesce(r.tokens_cached,0),m.name ' +
        'from ai_run r join member m on m.id=r.member_id where r.ticket_id=? order by r.started_at",(sys.argv[2],))]))',
      path.join(WORK, "kanban.db"),
      tid,
    ],
    { encoding: "utf8" },
  );
  const runs = JSON.parse(q.stdout || "[]");
  const work = runs.filter((r) => r.mode === "work");
  const tokens = runs.reduce((n, r) => n + r.tin + r.tout, 0);
  const fresh = runs.reduce((n, r) => n + r.tin - r.cached + r.tout, 0);
  const short = (m) =>
    /haiku/.test(m)
      ? "Haiku"
      : /sonnet/.test(m)
        ? "Sonnet"
        : /opus/.test(m)
          ? "Opus"
          : m || "?";
  const review = view.steps.filter((s) => s.role === "reviewer" && s.outcome);
  // the hidden acceptance tests on the ticket's branch (its worktree)
  const wt = path.join(`${REPO}.worktrees`, tid);
  const dir = fs.existsSync(wt) ? wt : REPO;
  const accDir = path.join(WORK, `acceptance-${tid}`);
  fs.rmSync(accDir, { recursive: true, force: true });
  fs.mkdirSync(accDir);
  fs.copyFileSync(path.join(dir, "cart.py"), path.join(accDir, "cart.py"));
  fs.writeFileSync(path.join(accDir, "test_acceptance.py"), ACCEPTANCE);
  const acc = spawnSync(
    "python3",
    ["-m", "unittest", "test_acceptance", "-v"],
    { cwd: accDir, encoding: "utf8" },
  );
  const accOut = acc.stdout + acc.stderr;
  const passed = (accOut.match(/ \.\.\. ok/g) || []).length;
  const totalTests = (accOut.match(/^Ran (\d+)/m) || [])[1];
  const own = spawnSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests", "-t", "."],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  const ownRan =
    ((own.stdout + own.stderr).match(/^Ran (\d+)/m) || [])[1] || "0";
  return {
    ticket: tid,
    pace: view.pace,
    ms: endedAt - startedAt,
    steps: view.steps
      .filter((s) => s.state === "done" && s.kind === "ai")
      .map((s) => s.label),
    skipped: view.steps.filter((s) => s.outcome === "fast").map((s) => s.label),
    runs: work.length,
    asks: runs.length - work.length,
    models: work.map(
      (r) =>
        `${r.who.split(" ")[0]} ${short(r.model)}${r.effort ? ` ${r.effort}` : ""}`,
    ),
    tokens,
    fresh,
    depth: view.review_runs_at,
    rounds: Object.values(view.rounds || {}).reduce((a, b) => a + b, 0),
    review: review.map((s) => s.outcome).join(" → ") || "–",
    acceptance: `${passed} of ${totalTests || "?"}`,
    own_tests: `${own.status === 0 ? "pass" : "FAIL"} (${ownRan} tests)`,
  };
}

function summaryPage(rows) {
  const r = (k, f) =>
    `<tr><th>${k}</th>${rows.map((x) => `<td>${f(x)}</td>`).join("")}</tr>`;
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#F6F8F6;color:#1E2A22;display:grid;place-items:center;height:100vh}
  .card{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(30,42,34,.08);padding:36px 44px;min-width:1100px}
  h1{font-size:26px;margin:0 0 4px} p{margin:0 0 22px;color:#5B6B60}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #E6ECE7;vertical-align:top}
  th{color:#5B6B60;font-weight:600;width:230px} td{font-variant-numeric:tabular-nums}
  thead td{font-weight:700;font-size:18px} .fast{color:#7A5A06}
  </style><div class="card"><h1>Same ticket, two paces</h1>
  <p>Real Claude Code runs on the board · the acceptance tests were written beforehand and never shown to the AIs</p>
  <table><thead><tr><th></th>${rows.map((x) => `<td class="${x.pace === "fast" ? "fast" : ""}">${x.ticket} · ${x.pace === "fast" ? "⚡ Fast" : "Normal"}</td>`).join("")}</tr></thead>
  ${r("Time to “waits for you”", (x) => mins(x.ms))}
  ${r("AI steps that ran", (x) => x.steps.join(" › "))}
  ${r("Skipped", (x) => x.skipped.join(", ") || "–")}
  ${r("Work runs · model, effort", (x) => `${x.runs}${x.asks ? ` (+${x.asks} quick ask${x.asks > 1 ? "s" : ""})` : ""} · ${x.models.join(" › ")}`)}
  ${r("Tokens, every run", (x) => `${x.tokens.toLocaleString("en")} <span style="color:#5B6B60">(${x.fresh.toLocaleString("en")} not from cache)</span>`)}
  ${r("Review", (x) => `${x.review} · ${x.depth}`)}
  ${r("Its own tests", (x) => x.own_tests)}
  ${r("Hidden acceptance tests", (x) => x.acceptance)}
  </table></div>`;
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
  const names = {
    triage: "Triage Tri",
    ba: "BA Bao",
    dev: "Dev An",
    qa: "QA Quynh",
    reviewer: "Reviewer Rin",
  };
  for (const [role, name] of Object.entries(names)) {
    const m = await api("POST", `/projects/${pid}/ai/packs/${role}/member`, {
      name,
      working_dir: REPO,
    });
    await api("PATCH", `/ai/members/${m.id}`, { cli_path: CLAUDE });
  }
  await api("PATCH", `/projects/${pid}/ai/ops`, {
    commands: { test: "python3 -m unittest discover -s tests -t ." },
    worktrees: { on: true, handover: "branch" },
  });
  const mk = async (title) => {
    const t = await api("POST", `/projects/${pid}/tickets`, {
      title,
      description: TASK.description,
      status: "todo",
    });
    for (const text of TASK.criteria)
      await api("POST", `/tickets/${t.id}/acceptance-criteria`, { text });
    return t.id;
  };
  const normal = await mk("Discount codes at checkout");
  const fast = await mk("Discount codes at checkout (fast)");

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
  // the workflow card sits in the AI activity view before a ticket has a workflow, in the ticket view after
  const wfCard = () =>
    page.locator('[data-testid="ticket-workflow"]:visible').first();
  const showWorkflow = async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await wfCard().waitFor({ timeout: 4000 });
        break;
      } catch {
        const other =
          (await page
            .getByTestId("view-ticket")
            .getAttribute("aria-selected")) === "true"
            ? "view-ai"
            : "view-ticket";
        await page.getByTestId(other).click();
      }
    }
    await wfCard().scrollIntoViewIfNeeded();
  };
  const openTicket = async (tid) => {
    await page.goto(`${BASE}/?proj=${pid}&ticket=${tid}`);
    await page.getByTestId("view-ticket").waitFor({ timeout: 20000 });
    await showWorkflow();
  };
  t0 = Date.now();

  caption(
    "Fast mode for the AI team · the same ticket twice, real Claude Code runs\nSHOP-1 at the normal pace, SHOP-2 in fast mode",
  );
  await page.goto(`${BASE}/?proj=${pid}`);
  await sleep(4000);
  await shot("0-board");

  // SHOP-1: Standard feature, normal pace
  caption(
    "SHOP-1 · put it on “Standard feature” as usual\nTriage › Shape (BA) › Build (Dev) › Checks › Test (QA) › Review › you",
  );
  await openTicket(normal);
  const box1 = page.locator('[data-testid="put-on-workflow"]:visible');
  await box1.getByLabel("Workflow").selectOption("standard");
  await sleep(2500);
  await box1.getByRole("button", { name: "Put on a workflow" }).click();
  await sleep(1500);
  await showWorkflow();
  await sleep(3000);
  const startNormal = Date.now();

  // SHOP-2: the same workflow, with Fast ticked
  caption("SHOP-2 · the same workflow, with ⚡ Fast ticked");
  await openTicket(fast);
  const box2 = page.locator('[data-testid="put-on-workflow"]:visible');
  await box2.getByLabel("Workflow").selectOption("standard");
  await sleep(1500);
  await box2.getByTestId("put-fast").check();
  await sleep(2000);
  await shot("1-put-fast");
  await box2.getByRole("button", { name: "Put on a workflow" }).click();
  const startFast = Date.now();
  await sleep(1500);
  await showWorkflow();
  await page
    .locator('[data-testid="pace-row"]:visible')
    .first()
    .scrollIntoViewIfNeeded();
  caption(
    "Fast skips Triage, Shape and Test · every AI step one effort level lower · Review one depth lower\nThe Checks by code and the Review still run; a step sent back runs at full effort",
  );
  await sleep(7000);
  await shot("2-fast-strip");

  // wait for both, fast-forwarded, looking at each in turn
  let vN = null;
  let vF = null;
  let endFast = null;
  let endNormal = null;
  let turn = 0;
  const deadline = Date.now() + LIMIT_MIN * 60000;
  while (Date.now() < deadline) {
    vN = await api("GET", `/tickets/${normal}/ai/workflow`);
    vF = await api("GET", `/tickets/${fast}/ai/workflow`);
    if (!endFast && (atDone(vF) || stuck(vF))) endFast = Date.now();
    if (!endNormal && (atDone(vN) || stuck(vN))) endNormal = Date.now();
    if (endFast && endNormal) break;
    if (endFast && !caps.some((c) => c.text.startsWith("SHOP-2 is ready"))) {
      ff(false);
      await openTicket(fast);
      caption(
        `SHOP-2 is ready for you after ${mins(endFast - startFast)} · its Build, Checks and Review ran\nSHOP-1 is still at ${where(vN)}`,
      );
      await sleep(7000);
      await shot("3-fast-done");
    }
    ff(true);
    const show = turn % 3 === 0 ? null : turn % 3 === 1 ? normal : fast;
    turn += 1;
    if (show) await openTicket(show);
    else await page.goto(`${BASE}/?proj=${pid}`);
    const el = (t0e) => mins(Date.now() - t0e);
    caption(
      `⏩ ×${FF} · ${show ? `looking at ${show}` : "the board"}\n` +
        `SHOP-1 · normal · ${el(startNormal)} · ${where(vN)}    |    SHOP-2 · ⚡ fast · ${endFast ? mins(endFast - startFast) : el(startFast)} · ${where(vF)}`,
    );
    await sleep(20000);
  }
  ff(false);
  if (!endNormal) endNormal = Date.now();
  if (!endFast) endFast = Date.now();
  await openTicket(normal);
  caption(
    `SHOP-1 (normal pace) is ready after ${mins(endNormal - startNormal)}: Triage, Shape, Build, Checks, Test and Review ran`,
  );
  await sleep(6000);
  await shot("4-normal-done");

  // the result: time, runs, tokens and the hidden acceptance tests on both branches
  const rows = [
    await summary(normal, startNormal, endNormal),
    await summary(fast, startFast, endFast),
  ];
  fs.writeFileSync(
    path.join(WORK, "report.json"),
    JSON.stringify(rows, null, 2),
  );
  console.log(JSON.stringify(rows, null, 2));
  await page.setContent(summaryPage(rows));
  caption(
    "The same acceptance tests, written before and never shown to the AIs, on both branches",
  );
  await sleep(12000);
  await shot("5-summary");
  caption(
    "Recorded in the web app with Playwright · every AI step is a real Claude Code run (no script)",
  );
  await sleep(4000);

  const total = now();
  if (current) current.end = total;
  const video = page.video();
  await ctx.close();
  await browser.close();
  server.kill("SIGTERM");
  const raw = await video.path();
  const ass = path.join(WORK, "captions.ass");
  writeAss(ass, total);
  // the cut: real speed between the fast-forwarded stretches; each stretch on its own (one decode at a time), then
  // joined, then the band and the captions
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
