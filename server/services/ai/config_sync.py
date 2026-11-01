"""Write a Claude Code member's synced configuration into its working folder (design/screens/ai-provider-config.md, B).

The board owns *units* inside the files it writes, never whole files it did not create:

- ``CLAUDE.md``: the text between the ``kanban:begin`` / ``kanban:end`` markers,
- ``.claude/skills/<name>/…`` and ``.claude/agents/<name>.md``: the files themselves,
- ``.mcp.json``: one entry per MCP server under ``mcpServers``,
- ``.claude/settings.json``: allow / deny rules and hook commands.

For every unit the board remembers what it wanted last time (the *base*). A sync is a 3-way merge of base, what the
file holds now and what the board wants now: a unit nobody touched is updated, a unit the person edited and the
board did not change keeps the person's version, and a unit both changed is a conflict that waits for a choice
(keep my lines / overwrite). Files are only written inside the working folder, and an existing file is copied to
``.claude/.kanban/backups`` (the last 5) before it is changed.
"""

import difflib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import config_model as cm

BEGIN = "<!-- kanban:begin — managed by Kanban Board: edit this block on the board. Text outside the markers is yours. -->"
END = "<!-- kanban:end -->"
_BEGIN_RE = re.compile(r"<!--\s*kanban:begin\b[^>]*?-->")
_END_RE = re.compile(r"<!--\s*kanban:end\s*-->")
BACKUP_DIR = ".claude/.kanban/backups"
KEEP_BACKUPS = 5
MAX_FILE_BYTES = 2 * 1024 * 1024
SEP = "\x1f"  # separates event, matcher and command inside a hook unit key


class SyncError(Exception):
    """A file could not be written; nothing was changed."""

    def __init__(self, path: str, message: str):
        """Name the file and say why."""
        super().__init__(message)
        self.path = path
        self.message = message


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def merge3(base: str, mine: str, theirs: str) -> tuple[str, bool]:
    """Line-based 3-way merge: (merged text, whether both sides changed the same lines). Where they did, `mine` wins."""
    b, m, t = base.split("\n"), mine.split("\n"), theirs.split("\n")

    def changes(other: list[str], side: str):
        ops = difflib.SequenceMatcher(None, b, other, autojunk=False).get_opcodes()
        return [
            (i1, i2, other[j1:j2], side)
            for tag, i1, i2, j1, j2 in ops
            if tag != "equal"
        ]

    allc = sorted(changes(m, "m") + changes(t, "t"), key=lambda c: (c[0], c[1], c[3]))
    out: list[str] = []
    overlapped = False
    pos = 0
    i = 0
    while i < len(allc):
        group = [allc[i]]
        gend = allc[i][1]
        i += 1
        # Changes that overlap are one group (the person's side wins); changes that merely touch are both applied
        while i < len(allc) and allc[i][0] < gend:
            group.append(allc[i])
            gend = max(gend, allc[i][1])
            i += 1
        gstart = group[0][0]
        overlapped = overlapped or len({c[3] for c in group}) > 1
        use = [c for c in group if c[3] == "m"] or group
        out += b[pos:gstart]
        cursor = gstart
        for s, e, repl, _ in sorted(use, key=lambda c: (c[0], c[1])):
            out += b[cursor:s]
            out += repl
            cursor = e
        out += b[cursor:gend]
        pos = gend
    out += b[pos:]
    return "\n".join(out), overlapped


def diff_lines(old: str | None, new: str | None, context: int = 2) -> list[dict]:
    """A unified diff as rows {t: '+'|'-'|' '|'…', n: new line number, text} for the preview."""
    a = (old or "").split("\n") if old is not None else []
    b = (new or "").split("\n") if new is not None else []
    rows: list[dict] = []
    for tag_group in difflib.SequenceMatcher(
        None, a, b, autojunk=False
    ).get_grouped_opcodes(context):
        if rows:
            rows.append({"t": "…", "n": None, "text": ""})
        for tag, i1, i2, j1, j2 in tag_group:
            if tag == "equal":
                rows += [{"t": " ", "n": j + 1, "text": b[j]} for j in range(j1, j2)]
                continue
            if tag in ("replace", "delete"):
                rows += [{"t": "-", "n": i + 1, "text": a[i]} for i in range(i1, i2)]
            if tag in ("replace", "insert"):
                rows += [{"t": "+", "n": j + 1, "text": b[j]} for j in range(j1, j2)]
    return rows[:400]


def count_changes(old: str | None, new: str | None) -> tuple[int, int]:
    """(added, removed) lines."""
    a = (old or "").split("\n") if old else []
    b = (new or "").split("\n") if new else []
    add = rem = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
        None, a, b, autojunk=False
    ).get_opcodes():
        if tag in ("replace", "delete"):
            rem += i2 - i1
        if tag in ("replace", "insert"):
            add += j2 - j1
    return add, rem


# ---------------------------------------------------------------------------
# What the board wants (desired units per file)
# ---------------------------------------------------------------------------


@dataclass
class Spec:
    """One file and the units the board wants in it (None = the unit should not exist)."""

    path: str
    kind: str  # block | text | mcp | settings
    units: dict[str, str | None] = field(default_factory=dict)


def canon(value) -> str:
    """Canonical JSON text of a value (used to compare units)."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def mcp_entry(server: dict) -> dict:
    """One server as Claude Code's .mcp.json wants it."""
    if server.get("type") == "http":
        spec: dict = {"type": "http", "url": server.get("url", "")}
        if server.get("headers"):
            spec["headers"] = {p["name"]: p["value"] for p in server["headers"]}
    else:
        spec = {
            "command": server.get("command", ""),
            "args": list(server.get("args") or []),
        }
        if server.get("env"):
            spec["env"] = {p["name"]: p["value"] for p in server["env"]}
    return spec


def claude_md_text(cfg: dict) -> str | None:
    """The text of the managed CLAUDE.md block, or None when there is nothing to write."""
    text = cm.expand_includes(
        cfg.get("instructions") or "", cfg.get("snippets") or []
    ).strip()
    return text or None


def hooks_hash(cfg: dict) -> str:
    """Hash of the enabled hooks (the typed confirmation covers exactly this set)."""
    return cm.sha(
        canon(
            sorted(
                (h["event"], h["matcher"], h["command"])
                for h in cfg.get("hooks") or []
                if h["enabled"]
            )
        )
    )


def desired_specs(
    cfg: dict, board_url: str, hooks_ok: dict | None, state_paths: set[str]
) -> tuple[list[Spec], dict]:
    """The files of a Claude Code member and the units the board wants in them.

    Returns:
        (specs, notes) where notes has `hooks_pending` (hooks wait for the typed confirmation).
    """
    specs: list[Spec] = []
    notes = {"hooks_pending": False}
    specs.append(Spec("CLAUDE.md", "block", {"block": claude_md_text(cfg)}))

    for s in cfg.get("skills") or []:
        if s["mode"] != "synced" or not s["name"]:
            continue
        base = f".claude/skills/{s['name']}"
        on = s["enabled"]
        specs.append(
            Spec(f"{base}/SKILL.md", "text", {"text": s["content"] if on else None})
        )
        for f in s.get("files") or []:
            specs.append(
                Spec(
                    f"{base}/{f['path']}",
                    "text",
                    {"text": f["content"] if on else None},
                )
            )
    for a in cfg.get("subagents") or []:
        if a["name"]:
            specs.append(
                Spec(
                    f".claude/agents/{a['name']}.md",
                    "text",
                    {"text": a["content"] if a["enabled"] else None},
                )
            )

    servers = {
        s["name"]: canon(mcp_entry(s))
        for s in cfg.get("mcp_servers") or []
        if s["enabled"] and s["mode"] == "synced" and s["name"]
    }
    mcp_units: dict[str, str | None] = {}
    if servers or ".mcp.json" in state_paths:
        mcp_units["server:kanban"] = canon(
            {"type": "http", "url": f"{board_url.rstrip('/')}/mcp/"}
        )
    mcp_units.update({f"server:{n}": v for n, v in servers.items()})
    specs.append(Spec(".mcp.json", "mcp", mcp_units))

    settings: dict[str, str | None] = {}
    for r in cfg.get("allow_rules") or []:
        settings[f"allow:{r}"] = "1"
    for r in cfg.get("deny_rules") or []:
        settings[f"deny:{r}"] = "1"
    hooks = [
        h
        for h in cfg.get("hooks") or []
        if h["enabled"] and h["event"] and h["command"]
    ]
    if hooks:
        if (hooks_ok or {}).get("hash") == hooks_hash(cfg):
            for h in hooks:
                settings[f"hook:{h['event']}{SEP}{h['matcher']}{SEP}{h['command']}"] = (
                    "1"
                )
        else:
            notes["hooks_pending"] = True
    specs.append(Spec(".claude/settings.json", "settings", settings))
    return specs, notes


# ---------------------------------------------------------------------------
# Reading units out of a file / building the new file
# ---------------------------------------------------------------------------


class _Bad(Exception):
    pass


def _json_obj(text: str | None) -> dict:
    if text is None or not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise _Bad("is not valid JSON; fix or move it and try again") from exc
    if not isinstance(data, dict):
        raise _Bad("is not a JSON object")
    return data


def read_units(spec: Spec, text: str | None, keys: set[str]) -> dict[str, str | None]:
    """What the file holds now for the given unit keys."""
    out: dict[str, str | None] = {k: None for k in keys}
    if text is None:
        return out
    if spec.kind == "text":
        out["text"] = text
    elif spec.kind == "block":
        m1 = _BEGIN_RE.search(text)
        m2 = _END_RE.search(text, m1.end()) if m1 else None
        if m1 and m2:
            out["block"] = text[m1.end() : m2.start()].strip("\n")
    elif spec.kind == "mcp":
        servers = _json_obj(text).get("mcpServers") or {}
        for k in keys:
            if k.startswith("server:") and k[7:] in servers:
                out[k] = canon(servers[k[7:]])
    elif spec.kind == "settings":
        data = _json_obj(text)
        perms = data.get("permissions") or {}
        hooks = data.get("hooks") or {}
        for k in keys:
            kind, _, rest = k.partition(":")
            if kind in ("allow", "deny") and rest in (perms.get(kind) or []):
                out[k] = "1"
            elif kind == "hook":
                event, matcher, command = rest.split(SEP, 2)
                for grp in hooks.get(event) or []:
                    if (grp.get("matcher") or "") == matcher and any(
                        h.get("command") == command for h in grp.get("hooks") or []
                    ):
                        out[k] = "1"
    return out


def build_text(
    spec: Spec, text: str | None, final: dict[str, str | None]
) -> str | None:
    """The file after applying the final unit values (None = the file should not exist)."""
    if spec.kind == "text":
        return final.get("text")
    if spec.kind == "block":
        block = final.get("block")
        cur = text or ""
        m1 = _BEGIN_RE.search(cur)
        m2 = _END_RE.search(cur, m1.end()) if m1 else None
        rendered = f"{BEGIN}\n{block}\n{END}" if block is not None else None
        if m1 and m2:
            if rendered is None:
                head, tail = (
                    cur[: m1.start()].rstrip("\n"),
                    cur[m2.end() :].lstrip("\n"),
                )
                out = head + ("\n\n" if head and tail else "") + tail
                return out if out.strip() else ("" if text is not None else None)
            return cur[: m1.start()] + rendered + cur[m2.end() :]
        if rendered is None:
            return text
        return (cur.rstrip("\n") + "\n\n" if cur.strip() else "") + rendered + "\n"
    data = _json_obj(text)
    if spec.kind == "mcp":
        servers = dict(data.get("mcpServers") or {})
        for k, v in final.items():
            name = k[7:]
            if v is None:
                servers.pop(name, None)
            else:
                servers[name] = json.loads(v)
        if servers or "mcpServers" in data:
            data["mcpServers"] = servers
    elif spec.kind == "settings":
        perms = dict(data.get("permissions") or {})
        hooks = {
            e: [dict(g, hooks=list(g.get("hooks") or [])) for g in groups]
            for e, groups in (data.get("hooks") or {}).items()
        }
        for k, v in final.items():
            kind, _, rest = k.partition(":")
            if kind in ("allow", "deny"):
                lst = list(perms.get(kind) or [])
                if v and rest not in lst:
                    lst.append(rest)
                if not v and rest in lst:
                    lst.remove(rest)
                if lst or kind in perms:
                    perms[kind] = lst
            elif kind == "hook":
                event, matcher, command = rest.split(SEP, 2)
                groups = hooks.setdefault(event, [])
                grp = next(
                    (g for g in groups if (g.get("matcher") or "") == matcher), None
                )
                if v:
                    if grp is None:
                        grp = {"hooks": []}
                        if matcher:
                            grp["matcher"] = matcher
                        groups.append(grp)
                    if not any(h.get("command") == command for h in grp["hooks"]):
                        grp["hooks"].append({"type": "command", "command": command})
                elif grp is not None:
                    grp["hooks"] = [
                        h for h in grp["hooks"] if h.get("command") != command
                    ]
                    if not grp["hooks"]:
                        groups.remove(grp)
                if not groups:
                    hooks.pop(event, None)
        if perms:
            data["permissions"] = perms
        if hooks:
            data["hooks"] = hooks
        elif "hooks" in data:
            data["hooks"] = {}
    out = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    return out if data else (None if text is None else out)


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------


@dataclass
class FilePlan:
    """What a sync would do to one file."""

    path: str
    spec: Spec
    action: str  # new | modified | unchanged | delete
    old: str | None
    new: str | None
    base: dict[str, str | None]  # the units to remember after writing
    conflicts: list[dict] = field(default_factory=list)
    error: str | None = None
    foreign: bool = False  # the file exists and the board did not write it
    kept: list[str] = field(
        default_factory=list
    )  # units where the person chose "keep my lines"


def merge_units(
    spec: Spec,
    base: dict[str, str | None],
    cur: dict[str, str | None],
    want: dict[str, str | None],
    resolution: str | None,
    kept: set[str],
) -> tuple[dict[str, str | None], list[dict], set[str]]:
    """3-way merge of the units (see the module docstring); returns the final values, the open conflicts and the
    units whose person's lines are being kept. A unit the person already chose to keep is merged line by line
    without asking again, unless the board changed the very lines the person changed."""
    final: dict[str, str | None] = {}
    conflicts: list[dict] = []
    kept = set(kept)
    for k in dict.fromkeys([*want, *base]):
        b, c, d = base.get(k), cur.get(k), want.get(k)
        mergeable = spec.kind in ("block", "text") and None not in (b, c, d)
        if c == b:
            final[k] = d
        elif d == b or c == d:
            final[k] = c
        elif k in kept and mergeable and not merge3(b, c, d)[1]:
            final[k] = merge3(b, c, d)[0]
        else:
            kind = "removed" if c is None else ("exists" if k not in base else "edited")
            conflicts.append({"unit": k, "kind": kind, "mine": c, "board": d})
            if resolution == "keep":
                final[k] = merge3(b, c, d)[0] if mergeable else c
                kept.add(k)
            elif resolution == "overwrite":
                final[k] = d
                kept.discard(k)
            else:
                final[k] = c
    return final, conflicts, kept


def plan_file(
    spec: Spec, text: str | None, state: dict | None, resolution: str | None
) -> FilePlan:
    """Plan one file."""
    base = dict((state or {}).get("units") or {})
    keys = set(base) | set(spec.units)
    try:
        cur = read_units(spec, text, keys)
        final, conflicts, kept = merge_units(
            spec,
            base,
            cur,
            spec.units,
            resolution,
            set((state or {}).get("kept") or []),
        )
        # Units nobody manages any more are forgotten once they are gone
        new_text = build_text(spec, text, final)
    except _Bad as exc:
        return FilePlan(
            spec.path, spec, "unchanged", text, text, base, [], f"{spec.path} {exc}."
        )
    except (KeyError, ValueError) as exc:  # pragma: no cover - defensive
        return FilePlan(
            spec.path, spec, "unchanged", text, text, base, [], f"{spec.path}: {exc}"
        )
    new_base = {k: v for k, v in spec.units.items() if v is not None}
    foreign = text is not None and state is None
    if new_text is None:
        action = "delete" if text is not None else "unchanged"
    elif text is None:
        action = "new" if (new_text.strip() or spec.kind != "block") else "unchanged"
    else:
        action = "unchanged" if new_text == text else "modified"
    if (
        text is None
        and not any(v is not None for v in final.values())
        and spec.kind in ("block", "settings", "mcp")
    ):
        action, new_text = "unchanged", None
    kept_now = sorted(k for k in kept if k in spec.units)
    return FilePlan(
        spec.path,
        spec,
        action,
        text,
        new_text,
        new_base,
        conflicts,
        None,
        foreign,
        kept_now,
    )


# ---------------------------------------------------------------------------
# Disk
# ---------------------------------------------------------------------------


def _safe_target(root: Path, rel: str) -> Path:
    """The absolute path of `rel` inside `root`; refuses anything that would end up outside (.., symlinks)."""
    if not rel or rel.startswith("/") or "\\" in rel or ".." in Path(rel).parts:
        raise SyncError(rel, f"“{rel}” is not a path inside the working folder.")
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, rel))
    if not target.startswith(base.rstrip(os.sep) + os.sep):
        raise SyncError(rel, f"“{rel}” leads outside the working folder.")
    return Path(target)


def read_text(root: Path | None, rel: str) -> str | None:
    """The current text of a file, or None when missing / binary / not readable."""
    if root is None:
        return None
    try:
        target = _safe_target(root, rel)
        if not target.is_file() or target.stat().st_size > MAX_FILE_BYTES:
            return None
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, SyncError):
        return None


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")


def backup_file(root: Path, rel: str, text: str) -> str:
    """Copy a file's current text to the backups folder (last 5 kept); returns the backup id."""
    folder = _safe_target(root, f"{BACKUP_DIR}/{rel.replace('/', '__')}")
    folder.mkdir(parents=True, exist_ok=True)
    (root / ".claude" / ".kanban" / ".gitignore").write_text("*\n", encoding="utf-8")
    bid = _stamp()
    (folder / f"{bid}.bak").write_text(text, encoding="utf-8")
    for old in sorted(folder.glob("*.bak"))[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)
    return bid


def list_backups(root: Path | None, rel: str) -> list[dict]:
    """The kept backups of a file, newest first: [{id, at, size}]."""
    if root is None:
        return []
    try:
        folder = _safe_target(root, f"{BACKUP_DIR}/{rel.replace('/', '__')}")
    except SyncError:
        return []
    out = []
    for f in sorted(folder.glob("*.bak"), reverse=True) if folder.is_dir() else []:
        try:
            when = datetime.strptime(f.stem, "%Y%m%d-%H%M%S-%f").replace(tzinfo=UTC)
        except ValueError:
            continue
        out.append({"id": f.stem, "at": when.isoformat(), "size": f.stat().st_size})
    return out


def read_backup(root: Path, rel: str, backup_id: str) -> str | None:
    """The text of one backup."""
    if not re.fullmatch(r"[0-9-]+", backup_id):
        return None
    try:
        f = _safe_target(root, f"{BACKUP_DIR}/{rel.replace('/', '__')}/{backup_id}.bak")
        return f.read_text(encoding="utf-8") if f.is_file() else None
    except (OSError, SyncError):
        return None


def write_atomic(target: Path, text: str) -> None:
    """Write via a temp file in the same folder, so a crash never leaves half a file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".kanban-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        mode = target.stat().st_mode & 0o777 if target.exists() else 0o644
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def apply_plans(root: Path, plans: list[FilePlan], files_state: dict) -> dict:
    """Write the planned files; on the first failure everything already written is put back.

    Returns:
        The new `files` state.

    Raises:
        SyncError: A file could not be written (read-only folder, permissions…); nothing was changed.
    """
    todo = [p for p in plans if p.action in ("new", "modified", "delete")]
    # Check first that every folder can be written, so a read-only folder fails before anything changes
    for p in todo:
        target = _safe_target(root, p.path)
        probe = (
            target
            if target.exists()
            else next((a for a in target.parents if a.exists()), root)
        )
        if not os.access(probe if probe.is_dir() else probe.parent, os.W_OK):
            raise SyncError(
                p.path, f"The working folder is read-only (EACCES): {p.path}"
            )
    done: list[tuple[Path, str | None]] = []
    try:
        for p in todo:
            target = _safe_target(root, p.path)
            state_sha = files_state.get(p.path, {}).get("sha")
            if p.old is not None and (state_sha is None or state_sha != cm.sha(p.old)):
                backup_file(root, p.path, p.old)
            if p.action == "delete":
                done.append((target, p.old))
                target.unlink(missing_ok=True)
                for parent in target.parents:
                    if parent == root or parent.name in (".claude", "skills", "agents"):
                        break
                    try:
                        parent.rmdir()
                    except OSError:
                        break
            else:
                done.append((target, p.old))
                write_atomic(target, p.new or "")
    except OSError as exc:
        for target, old in reversed(done):
            try:
                if old is None:
                    target.unlink(missing_ok=True)
                else:
                    write_atomic(target, old)
            except OSError:
                pass
        rel = os.path.relpath(target, os.path.realpath(root)) if done else "files"
        raise SyncError(
            rel, f"{exc.strerror or exc} ({errno_name(exc)}): nothing was changed."
        ) from exc
    now = datetime.now(UTC).isoformat()
    state = dict(files_state)
    for p in plans:
        if p.action == "delete" or (p.new is None and not p.base):
            state.pop(p.path, None)
        elif p.action in ("new", "modified"):
            state[p.path] = {
                "units": p.base,
                "kind": p.spec.kind,
                "kept": p.kept,
                "sha": cm.sha(p.new or ""),
                "written_at": now,
            }
        elif p.path in state or p.base:
            # Unchanged on disk: the base still moves to what the board wants now (a "keep" resolution)
            state[p.path] = {
                "units": p.base,
                "kind": p.spec.kind,
                "kept": p.kept,
                "sha": cm.sha(p.new if p.new is not None else (p.old or "")),
                "written_at": state.get(p.path, {}).get("written_at", now),
            }
    return state


def errno_name(exc: OSError) -> str:
    """EACCES, EROFS… for a message."""
    import errno

    return errno.errorcode.get(exc.errno or 0, "OSError")
