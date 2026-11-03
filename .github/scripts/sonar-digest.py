#!/usr/bin/env python3
"""File what SonarQube Cloud found on main in one GitHub issue, so nobody collects it by hand.

Run by the nightly job (.github/workflows/nightly-quality.yml) right after the scan:

1. waits until SonarQube Cloud has processed the scan (.scannerwork/report-task.txt);
2. reads the quality gate and every open issue of the project;
3. compares the issue keys with last night's (a file the workflow keeps in the Actions cache), so it knows which
   issues are new and how many were fixed;
4. rewrites the body of one open issue labelled `sonarqube` (made the first time) and, when there are new issues,
   adds a comment that lists them, which is what notifies the owner.

Only the standard library. A dry run prints the body and the comment instead of posting them:

    python3 .github/scripts/sonar-digest.py --dry-run --previous-keys /dev/null --keys-out /tmp/keys.txt

Env: SONAR_TOKEN (optional for a public project), SONAR_HOST_URL (default https://sonarcloud.io), GITHUB_TOKEN,
GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_RUN_ID, TESTS_SUMMARY (one line about the nightly tests).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"]
SEVERITY_ICON = {"BLOCKER": "🟥", "HIGH": "🟧", "MEDIUM": "🟨", "LOW": "🟦", "INFO": "⬜"}
LABEL = "sonarqube"
MARKER = "<!-- sonar-digest -->"
TITLE = "SonarQube Cloud: nightly report"
MAX_ROWS_BODY = 60  # new issues listed in the body; the comment lists up to MAX_ROWS_COMMENT
MAX_ROWS_COMMENT = 100
SONAR_RESULT_WINDOW = 10_000  # SonarQube Cloud returns at most this many issues for one query


def http_json(url: str, token: str = "", method: str = "GET", body: dict | None = None, github: bool = False):
    """Call a JSON API and return the decoded answer (None for an empty one)."""
    headers = {"Accept": "application/vnd.github+json" if github else "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise SystemExit(f"{method} {url} -> HTTP {e.code}: {detail}") from e
    return json.loads(raw) if raw else None


def project_key(properties: Path) -> str:
    """The sonar.projectKey of sonar-project.properties."""
    for line in properties.read_text().splitlines():
        if line.startswith("sonar.projectKey="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"No sonar.projectKey in {properties}")


class Sonar:
    """The few SonarQube Cloud web API calls the digest needs."""

    def __init__(self, host: str, token: str, key: str):
        self.host, self.token, self.key = host.rstrip("/"), token, key

    def get(self, path: str, **params) -> dict:
        """GET one API path with query parameters."""
        return http_json(f"{self.host}/api/{path}?{urllib.parse.urlencode(params)}", self.token)

    def wait_for_task(self, report_task: Path, timeout: int = 900) -> None:
        """Wait until the server has processed the analysis the scanner uploaded."""
        if not report_task.is_file():
            print(f"No {report_task}: not waiting for an analysis")
            return
        props = dict(line.split("=", 1) for line in report_task.read_text().splitlines() if "=" in line)
        task_id = props.get("ceTaskId")
        if not task_id:
            return
        deadline = time.monotonic() + timeout
        while True:
            status = self.get("ce/task", id=task_id)["task"]["status"]
            if status in ("SUCCESS", "FAILED", "CANCELED"):
                print(f"Analysis {task_id}: {status}")
                if status != "SUCCESS":
                    raise SystemExit(f"SonarQube Cloud could not process the analysis ({status})")
                return
            if time.monotonic() > deadline:
                raise SystemExit(f"The analysis {task_id} was still {status} after {timeout} s")
            time.sleep(10)

    def quality_gate(self) -> dict:
        """The quality gate of the main branch: status and the conditions that failed."""
        return self.get("qualitygates/project_status", projectKey=self.key)["projectStatus"]

    def open_issues(self) -> tuple[list[dict], list[str]]:
        """Every open issue, fetched one impact severity at a time to stay under the result window."""
        issues: list[dict] = []
        warnings: list[str] = []
        seen: set[str] = set()
        for severity in SEVERITIES:
            page = 1
            while True:
                data = self.get(
                    "issues/search",
                    componentKeys=self.key,
                    resolved="false",
                    impactSeverities=severity,
                    ps=500,
                    p=page,
                )
                for issue in data["issues"]:
                    if issue["key"] not in seen:  # an issue with two impacts comes back under both
                        seen.add(issue["key"])
                        issue["_severity"] = severity
                        issues.append(issue)
                total = data["paging"]["total"]
                if page * 500 >= min(total, SONAR_RESULT_WINDOW):
                    if total > SONAR_RESULT_WINDOW:
                        warnings.append(
                            f"{severity}: {total} issues, only the first {SONAR_RESULT_WINDOW} could be read"
                        )
                    break
                page += 1
        return issues, warnings


def top_severity(issue: dict) -> str:
    """The highest impact severity of an issue (BLOCKER first)."""
    found = {i["severity"] for i in issue.get("impacts", [])} or {issue["_severity"]}
    return next(s for s in SEVERITIES if s in found or s == SEVERITIES[-1])


def qualities(issue: dict) -> str:
    """The software qualities an issue harms, e.g. 'security, reliability'."""
    return ", ".join(sorted({i["softwareQuality"].lower() for i in issue.get("impacts", [])})) or "-"


def cell(text: str, limit: int = 160) -> str:
    """Text made safe for one Markdown table cell."""
    text = " ".join(str(text).split()).replace("|", "\\|")
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Links:
    """Links to the issue on SonarQube Cloud and to the line on GitHub."""

    def __init__(self, sonar: Sonar, repo_url: str, sha: str):
        self.sonar, self.repo_url, self.sha = sonar, repo_url, sha

    def issues(self, **params) -> str:
        """The project's issue list on SonarQube Cloud, filtered."""
        return f"{self.sonar.host}/project/issues?" + urllib.parse.urlencode(
            {"id": self.sonar.key, "resolved": "false", **params}
        )

    def issue(self, issue: dict) -> str:
        """One issue on SonarQube Cloud."""
        return self.issues(open=issue["key"])

    def code(self, issue: dict) -> str:
        """The file (and line) of an issue, as a GitHub link."""
        path = issue["component"].split(":", 1)[-1]
        line = issue.get("line")
        label = f"{path}:{line}" if line else path
        if not self.repo_url:
            return f"`{label}`"
        return f"[`{label}`]({self.repo_url}/blob/{self.sha}/{path}{f'#L{line}' if line else ''})"


def issue_rows(issues: list[dict], links: Links, limit: int) -> list[str]:
    """A Markdown table of issues, the most severe first, cut at `limit` rows."""
    order = {s: i for i, s in enumerate(SEVERITIES)}
    issues = sorted(issues, key=lambda i: (order[top_severity(i)], i["component"], i.get("line") or 0))
    rows = ["| | Where | Rule | Quality | What |", "|---|---|---|---|---|"]
    for issue in issues[:limit]:
        sev = top_severity(issue)
        rows.append(
            f"| {SEVERITY_ICON[sev]} {sev} | {links.code(issue)} | [{issue['rule']}]({links.issue(issue)}) "
            f"| {qualities(issue)} | {cell(issue['message'])} |"
        )
    if len(issues) > limit:
        rows.append(f"\n…and {len(issues) - limit} more: [see them on SonarQube Cloud]({links.issues()}).")
    return rows


def build_body(gate: dict, issues: list[dict], new: list[dict], fixed: int, baseline: bool, links: Links,
               previous_counts: Counter | None, warnings: list[str], run_url: str, tests: str) -> str:
    """The body of the report issue."""
    counts = Counter(top_severity(i) for i in issues)
    status = gate.get("status", "NONE")
    gate_line = {"OK": "✅ Passed", "ERROR": "❌ Failed", "WARN": "⚠️ Warning"}.get(status, status)
    lines = [
        MARKER,
        f"_Updated by the nightly quality run on `{links.sha[:7]}`"
        + (f" ([run]({run_url}))" if run_url else "")
        + ". This issue stays open and is rewritten every night; a comment is added when something new appears._",
        "",
        f"**Quality gate:** {gate_line} · **Open issues:** {len(issues)}"
        + ("" if baseline else f" · **New since last night:** {len(new)} · **Fixed:** {fixed}"),
    ]
    if tests:
        lines.append(f"**Nightly tests:** {tests}")
    failed = [c for c in gate.get("conditions", []) if c.get("status") == "ERROR"]
    if failed:
        lines.append("")
        lines.append("Quality gate conditions that fail: " + ", ".join(
            f"`{c['metricKey']}` {c.get('actualValue', '?')} ({c.get('comparator', '')} {c.get('errorThreshold', '')})"
            for c in failed
        ))
    lines += ["", "| Severity | Open | Change |", "|---|---|---|"]
    for sev in SEVERITIES:
        change = "" if previous_counts is None else f"{counts[sev] - previous_counts[sev]:+d}"
        lines.append(f"| {SEVERITY_ICON[sev]} [{sev}]({links.issues(impactSeverities=sev)}) | {counts[sev]} | {change} |")

    lines += ["", f"### New since last night ({len(new)})", ""]
    if baseline:
        lines.append("First run: tonight's issues are the baseline. From tomorrow this lists only the new ones.")
    elif new:
        lines += issue_rows(new, links, MAX_ROWS_BODY)
    else:
        lines.append("Nothing new. 🎉")

    blockers = [i for i in issues if top_severity(i) == "BLOCKER"]
    if blockers:
        lines += ["", f"### Blockers ({len(blockers)})", ""] + issue_rows(blockers, links, 30)

    lines += ["", "### The rules with the most open issues", "",
              "Fix one rule at a time: the same change, many places.", "",
              "| Rule | Highest severity | Open |", "|---|---|---|"]
    by_rule = Counter(i["rule"] for i in issues)
    worst = {}
    order = {s: i for i, s in enumerate(SEVERITIES)}
    for i in issues:
        sev = top_severity(i)
        if order[sev] < order.get(worst.get(i["rule"]), 99):
            worst[i["rule"]] = sev
    for rule, n in by_rule.most_common(15):
        lines.append(f"| [{rule}]({links.issues(rules=rule)}) | {worst[rule]} | {n} |")

    if warnings:
        lines += ["", "> ⚠️ " + "; ".join(warnings)]
    lines += ["", f"<!-- counts {json.dumps(dict(counts))} -->"]
    body = "\n".join(lines)
    return body if len(body) < 65_000 else body[:64_000] + "\n\n…(cut: the body is too long for GitHub)"


def previous_counts_from(body: str) -> Counter | None:
    """The per-severity counts last night's body stored in a comment."""
    start = body.find("<!-- counts ")
    if start < 0:
        return None
    end = body.find(" -->", start)
    try:
        return Counter(json.loads(body[start + len("<!-- counts "):end]))
    except ValueError:
        return None


class GitHub:
    """The GitHub REST calls that keep the one report issue."""

    def __init__(self, api: str, repo: str, token: str):
        self.base, self.token = f"{api.rstrip('/')}/repos/{repo}", token

    def call(self, path: str, method: str = "GET", body: dict | None = None):
        """One REST call on the repository."""
        return http_json(f"{self.base}{path}", self.token, method, body, github=True)

    def report_issue(self) -> dict | None:
        """The open report issue, if there is one."""
        for issue in self.call(f"/issues?labels={LABEL}&state=open&per_page=50") or []:
            if MARKER in (issue.get("body") or "") and "pull_request" not in issue:
                return issue
        return None

    def ensure_label(self) -> None:
        """Make the label the first time."""
        try:
            self.call(f"/labels/{LABEL}")
        except SystemExit:
            self.call("/labels", "POST", {"name": LABEL, "color": "cb2431",
                                          "description": "Findings of the nightly SonarQube Cloud analysis"})


def main() -> None:
    """Read SonarQube Cloud, compare with last night, update the report issue."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--properties", default="sonar-project.properties", type=Path)
    ap.add_argument("--report-task", default=".scannerwork/report-task.txt", type=Path)
    ap.add_argument("--previous-keys", type=Path, required=True, help="last night's issue keys (may be missing)")
    ap.add_argument("--keys-out", type=Path, required=True, help="where tonight's issue keys are written")
    ap.add_argument("--dry-run", action="store_true", help="print instead of posting to GitHub")
    args = ap.parse_args()

    env = os.environ
    sonar = Sonar(env.get("SONAR_HOST_URL") or "https://sonarcloud.io", env.get("SONAR_TOKEN", ""),
                  project_key(args.properties))
    server = env.get("GITHUB_SERVER_URL", "https://github.com")
    repo = env.get("GITHUB_REPOSITORY", "")
    links = Links(sonar, f"{server}/{repo}" if repo else "", env.get("GITHUB_SHA", "main"))
    run_url = f"{server}/{repo}/actions/runs/{env['GITHUB_RUN_ID']}" if repo and env.get("GITHUB_RUN_ID") else ""

    sonar.wait_for_task(args.report_task)
    gate = sonar.quality_gate()
    issues, warnings = sonar.open_issues()
    print(f"Quality gate {gate.get('status')}, {len(issues)} open issues")

    baseline = not (args.previous_keys.is_file() and args.previous_keys.stat().st_size)
    previous = set() if baseline else set(args.previous_keys.read_text().split())
    current = {i["key"] for i in issues}
    new = [] if baseline else [i for i in issues if i["key"] not in previous]
    fixed = 0 if baseline else len(previous - current)
    args.keys_out.parent.mkdir(parents=True, exist_ok=True)
    args.keys_out.write_text("\n".join(sorted(current)) + "\n")
    print(f"New: {len(new)}, fixed: {fixed}, baseline: {baseline}")

    gh = None if args.dry_run else GitHub(env.get("GITHUB_API_URL", "https://api.github.com"), repo,
                                          env["GITHUB_TOKEN"])
    existing = gh.report_issue() if gh else None
    prev_counts = previous_counts_from(existing["body"]) if existing else None
    body = build_body(gate, issues, new, fixed, baseline, links, prev_counts, warnings, run_url,
                      env.get("TESTS_SUMMARY", ""))
    comment = None
    if new:
        comment = "\n".join([f"**{len(new)} new SonarQube issue(s)** on `{links.sha[:7]}`" + (
            f" ([run]({run_url}))" if run_url else "") + ":", ""] + issue_rows(new, links, MAX_ROWS_COMMENT))

    if args.dry_run:
        print("\n----- body -----\n" + body)
        if comment:
            print("\n----- comment -----\n" + comment)
        return

    if existing:
        number = existing["number"]
        gh.call(f"/issues/{number}", "PATCH", {"body": body})
    else:
        gh.ensure_label()
        owner = env.get("GITHUB_REPOSITORY_OWNER", "")
        created = gh.call("/issues", "POST", {"title": TITLE, "body": body, "labels": [LABEL],
                                              **({"assignees": [owner]} if owner else {})})
        number = created["number"]
    if comment:
        gh.call(f"/issues/{number}/comments", "POST", {"body": comment})
    print(f"Report: {server}/{repo}/issues/{number}")


if __name__ == "__main__":
    sys.exit(main())
