"""Skills and plugins installed from a source (design/screens/ai-team-process.md, B; plan D1–D3).

A plugin comes from a git URL, a marketplace (a repository with ``.claude-plugin/marketplace.json``) or a folder on
this computer. Installing has no review step (D1): the board records the source and the commit, shows what changed
before an update, and one button puts the previous version back. The installed copy lives in the board's data folder
(``plugin-cache/<id>/<commit>``) and reaches a run as ``--plugin-dir`` (spike S1: skills are used under ``-p``; S3:
hooks run; S4: ten plugins cost no start-up time).

Layouts understood, as found in the catalogue's repositories:
- a plugin at the root (``.claude-plugin/plugin.json``), e.g. ``nextlevelbuilder/ui-ux-pro-max-skill``;
- a marketplace whose entry is a folder (``"source": "./design"``), e.g. ``anthropics/knowledge-work-plugins``;
- a marketplace whose entry lists skills of the repository (``"source": "./", "skills": [...]``), e.g.
  ``anthropics/skills`` — a subset of those skills can be installed as a plugin of its own;
- a folder with ``skills/`` and no manifest, or a single ``SKILL.md``.

Who gets it: the project default (on or off), the roles it is suggested for, and a switch per member.
"""

import asyncio
import logging
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import col, select

import database
from models import AiMember, AiPlugin, AiSkillUse

from .store import loads

logger = logging.getLogger(__name__)

# the most a plugin may copy into the board's cache (checked before anything is copied)
MAX_PLUGIN_BYTES = 50 * 1024 * 1024

# The "Suggested for a role" catalogue (D2, D16): what each role is suggested to install.
CATALOGUE: list[dict] = [
    {
        "key": "design",
        "name": "design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/knowledge-work-plugins",
        "plugin": "design",
        "skills": [
            "design-critique",
            "accessibility-review",
            "ux-copy",
            "design-handoff",
        ],
        "roles": ["designer"],
        "what": "Anthropic's design plugin: design-handoff, design-critique, accessibility-review, ux-copy, design-system, user-research, research-synthesis.",
        "use": "design-critique on your own screens, accessibility-review before you hand in, ux-copy for buttons, errors and empty states, design-handoff for the spec of each screen",
    },
    {
        "key": "ui-ux-pro-max",
        "name": "ui-ux-pro-max",
        "kind": "plugin",
        "source": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
        "plugin": "ui-ux-pro-max",
        "skills": ["ui-ux-pro-max"],
        "roles": ["designer"],
        "what": "UI/UX design intelligence: styles, palettes, font pairings, charts and stack guidelines.",
        "use": "palettes and font pairings to look through while choosing the direction (ideas, not rules)",
    },
    {
        "key": "taste-skill",
        "name": "taste-skill",
        "kind": "plugin",
        "source": "https://github.com/Leonxlnx/taste-skill",
        "plugin": "taste-skill",
        "roles": ["designer"],
        "what": "Art direction against the generic AI look (tasteskill): researched directions, a no-ornament house style, rules for app screens, and a look-and-fix loop on screenshots. MIT.",
        "use": "while choosing the direction and again in the critique pass (its rules for app screens and pages)",
    },
    {
        "key": "impeccable",
        "name": "impeccable",
        "kind": "plugin",
        "source": "https://github.com/pbakaus/impeccable",
        "plugin": "impeccable",
        # strong design rules, but its hooks run a launcher on every edit and at the end of a run (it downloads a
        # binary the first time), which an unattended run should not depend on: in the catalogue, suggested to no role
        "roles": [],
        "what": "Design fluency: modes per surface, a craft floor of banned patterns, critique, audit and polish commands. Apache-2.0. Its hooks run a downloaded helper on every edit.",
        "use": "a critique, audit or polish pass",
    },
    # Niche frontend skills (vetted 2026-11: license, no hooks, nothing downloaded at run time; a subset where a repository
    # also carries skills that need an API key, a browser download or an MCP engine)
    {
        "key": "make-interfaces-feel-better",
        "name": "make-interfaces-feel-better",
        "kind": "plugin",
        "source": "https://github.com/jakubkrehel/make-interfaces-feel-better",
        "ui": True,
        "roles": ["designer", "dev"],
        "what": "The finishing details: text wrapping, tabular numbers, optical alignment, nested radii, shadows, hit areas, icon states, restrained motion. MIT.",
        "use": "in the critique pass, on every main screen",
    },
    {
        "key": "emil-design-eng",
        "name": "Emil Kowalski's design engineering",
        "kind": "plugin",
        "source": "https://github.com/emilkowalski/skills",
        "skills": [
            "emil-design-eng",
            "animate",
            "review-animations",
            "improve-animations",
            "find-animation-opportunities",
            "animation-performance",
            "animation-vocabulary",
            "mobile-native",
            "break-ui",
        ],
        "ui": True,
        "roles": ["designer", "dev"],
        "what": "Animation craft (whether to animate, easing, duration, interruption), animation reviews and performance, a web app that feels native on a phone. MIT.",
        "use": "before you design any motion (animate, emil-design-eng) and to check it (review-animations, animation-performance)",
    },
    {
        "key": "gsap",
        "name": "GSAP",
        "kind": "plugin",
        "source": "https://github.com/greensock/gsap-skills",
        "plugin": "gsap-skills",
        "ui": True,
        "roles": ["dev"],
        "what": "GSAP's own skills: tweens, timelines, ScrollTrigger, Flip and Draggable, React cleanup with useGSAP, performance, reduced motion. MIT.",
        "use": "when an animation is built with GSAP",
    },
    {
        "key": "motion-design",
        "name": "motion-design",
        "kind": "plugin",
        "source": "https://github.com/LottieFiles/motion-design-skill",
        "ui": True,
        "roles": ["designer"],
        "what": "Motion principles for any stack: timing, easing, choreography, purpose (LottieFiles). MIT.",
        "use": "before you design motion: timing, easing, choreography",
    },
    {
        "key": "ui-foundations",
        "name": "UI foundations (dembrandt)",
        "kind": "plugin",
        "source": "https://github.com/dembrandt/dembrandt-skills",
        # eight of its 45: not the ones that need the dembrandt engine (an MCP server fetched with npx and a browser), and
        # not the ones another skill or the board's guide already covers (motion, loading, gestalt, accessibility, forms)
        "skills": [
            "surface-separation",
            "visual-emphasis-and-hierarchy",
            "modular-scale-typography",
            "algorithmic-color-palette",
            "color-mode-and-theme",
            "component-family-consistency",
            "status-colors-and-errors",
            "responsive-paradigms",
        ],
        "ui": True,
        "roles": ["designer"],
        "what": "Interface rules one by one: type scales, derived palettes, themes, button states, density, surfaces, hierarchy, forms, loading states, dense expert tools, WCAG. MIT.",
        "use": "type scale (modular-scale-typography), palette and dark theme (algorithmic-color-palette, color-mode-and-theme), surfaces and hierarchy (surface-separation, visual-emphasis-and-hierarchy), the components board (component-family-consistency), states and errors (status-colors-and-errors), phone vs desktop (responsive-paradigms)",
    },
    {
        "key": "web-quality",
        "name": "Web quality",
        "kind": "plugin",
        "source": "https://github.com/addyosmani/web-quality-skills",
        "skills": ["accessibility", "performance", "core-web-vitals", "best-practices"],
        "ui": True,
        "roles": ["dev", "qa"],
        "what": "WCAG 2.2 audits from evidence, performance and Core Web Vitals, web best practices (Addy Osmani). MIT.",
        "use": "accessibility and performance checks of a built page",
    },
    {
        "key": "tufte-data-viz",
        "name": "tufte-data-viz",
        "kind": "plugin",
        "source": "https://github.com/caylent/tufte-data-viz",
        "roles": ["designer", "dev"],
        "what": "Charts after Tufte: data-ink, direct labels, range frames, accessible and dark-mode ready; for Recharts, ECharts, Chart.js, D3 or SVG. MIT.",
        "use": "before you draw any chart",
    },
    {
        "key": "threejs",
        "name": "three.js",
        "kind": "plugin",
        "source": "https://github.com/CloudAI-X/threejs-skills",
        # not threejs-asset-pipeline, which runs an npx tool
        "skills": [
            "threejs-fundamentals",
            "threejs-shaders",
            "threejs-react-three-fiber",
            "threejs-materials",
            "threejs-postprocessing",
            "threejs-performance",
            "threejs-lighting",
            "threejs-animation",
            "threejs-geometry",
            "threejs-interaction",
            "threejs-loaders",
            "threejs-textures",
        ],
        "ui": True,
        "roles": ["designer", "dev"],
        "what": "Current three.js, React Three Fiber and drei APIs (with WebGPU), each skill with the mistakes models still make. MIT.",
        "use": "before you write three.js: fundamentals for the scene, materials and lighting for the look, shaders before a shader, performance before you hand in",
    },
    {
        "key": "webgl-animation",
        "name": "WebGL animation",
        "kind": "plugin",
        "source": "https://github.com/iart-ai/webgl-animation-skills",
        "ui": True,
        "skills": ["particle-system", "shader-glsl"],
        "roles": ["designer", "dev"],
        "what": "Particle systems, GLSL backgrounds and image transitions, three.js hero scenes with a scroll-linked camera. MIT.",
        "use": "particles and GLSL backgrounds",
    },
    {
        "key": "shader-art",
        "name": "Shader art",
        "kind": "plugin",
        "source": "https://github.com/gokayfem/shader-skills",
        "roles": ["designer"],
        "what": "GLSL shaders in the Shadertoy style (raymarching, noise, terrain, water, clouds) from a tested function library, with a local checker. MIT.",
        "use": "before you write a GLSL shader",
    },
    {
        "key": "genart",
        "name": "Generative art",
        "kind": "plugin",
        "source": "https://github.com/camilleroux/genart-skill",
        "roles": [],
        "what": "Seeded, reproducible generative art and creative coding, resolution-independent, with traits. MIT.",
        "use": "generative or seeded art",
    },
    {
        "key": "frontend-design",
        "name": "frontend-design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["frontend-design"],
        "roles": ["designer"],
        "what": "Distinctive, production-grade frontend interfaces (Anthropic skills).",
        "use": "ideas for a distinctive frontend look (ideas, not rules)",
    },
    {
        "key": "canvas-design",
        "name": "canvas-design",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["canvas-design"],
        # poster and art pieces as a PNG or PDF, not the board's canvas frames; its name hides the board's own
        # canvas-design guide, so no role gets it by default
        "roles": [],
        "what": "Posters and visual art as a PNG or PDF (Anthropic skills); not for the board's canvas frames.",
    },
    {
        "key": "webapp-testing",
        "name": "webapp-testing",
        "kind": "plugin",
        "source": "https://github.com/anthropics/skills",
        "plugin": "example-skills",
        "skills": ["webapp-testing"],
        "ui": True,  # a browser tool: only for a project with a UI
        "roles": ["designer", "user_tester", "qa"],
        "what": "Testing a local web app with Playwright (Anthropic skills).",
        "use": "testing a running web app in the browser",
    },
    {
        "key": "figma",
        "name": "Figma MCP",
        "kind": "mcp",
        "server": {"name": "figma", "type": "http", "url": "https://mcp.figma.com/mcp"},
        "roles": ["designer"],
        "what": "Read Figma files and frames (Figma's remote MCP server; signs in through the browser).",
    },
    {
        "key": "chrome-devtools",
        "name": "Chrome DevTools MCP",
        "kind": "mcp",
        "server": {
            "name": "chrome-devtools",
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "chrome-devtools-mcp@latest"],
        },
        "ui": True,  # a browser tool: only for a project with a UI
        "roles": ["dev"],
        "what": "Performance and network debugging in a real Chrome.",
    },
    {
        "key": "playwright",
        "name": "Playwright MCP",
        "kind": "mcp",
        "server": {
            "name": "playwright",
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest", "--isolated"],
        },
        "ui": True,  # a browser tool: only for a project with a UI
        "roles": ["designer", "user_tester", "qa"],
        "what": "A fresh browser per run, driven through the page's structure; can emulate a phone.",
    },
]


class PluginError(RuntimeError):
    """A plugin could not be read, installed or updated."""


# Installs still running per project (a pack's plugins install in the background when a member is made from it): a run
# waits for them before it lists its plugin folders, or the first run of a new member would start without them.
_PENDING: dict[str, set[asyncio.Task]] = {}
SETTLE_SECONDS = 180


def installing(project_id: str, coro) -> None:
    """Run an install in the background and remember it until it ends; its failure is logged, never raised."""

    async def go() -> None:
        try:
            await coro
        except Exception:  # noqa: BLE001 - a plugin that fails to install never breaks the member it came with
            logger.exception("Installing plugins on %s failed", project_id)

    try:
        task = asyncio.get_running_loop().create_task(go())
    except RuntimeError:  # no loop (a sync caller in a test): nothing to schedule
        coro.close()
        return
    tasks = _PENDING.setdefault(project_id, set())
    tasks.add(task)
    task.add_done_callback(tasks.discard)


async def settled(project_id: str, timeout: float = SETTLE_SECONDS) -> bool:
    """Wait for the project's running installs (at most `timeout` seconds). False when some were still running."""
    tasks = [t for t in _PENDING.get(project_id, set()) if not t.done()]
    if not tasks:
        return True
    _done, still = await asyncio.wait(tasks, timeout=timeout)
    if still:
        logger.warning(
            "A run on %s started while %d plugin installs were still running",
            project_id,
            len(still),
        )
    return not still


def _now() -> str:
    return datetime.now(UTC).isoformat()


def cache_root() -> Path:
    """``plugin-cache`` beside the database."""
    base = database.get_db_path().parent / "plugin-cache"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _run(
    args: list[str], cwd: str | None = None, timeout: float = 300
) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def _clone(url: str, ref: str | None, into: str) -> str:
    """Shallow clone of `url` at `ref` (a tag, branch or commit); returns the commit."""
    if ref and re.fullmatch(r"[0-9a-f]{7,40}", ref):
        out = _run(["git", "clone", "-q", "--", url, into])
        if out.returncode == 0:
            out = _run(["git", "checkout", "-q", ref], cwd=into)
    else:
        out = _run(
            [
                "git",
                "clone",
                "-q",
                "--depth",
                "1",
                *(["--branch", ref] if ref else []),
                "--",  # a URL that starts with "-" is never read as an option
                url,
                into,
            ]
        )
    if out.returncode != 0:
        raise PluginError(
            f"Could not get {url}{'@' + ref if ref else ''}: {out.stderr.strip()[:240]}"
        )
    return _run(["git", "rev-parse", "HEAD"], cwd=into).stdout.strip()


def _manifest(folder: Path, name: str) -> dict:
    try:
        return json.loads(
            (folder / ".claude-plugin" / name).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}


def source_name(source: str) -> str:
    """A plugin's name from where it came from, for a repository with no manifest: the repository's name, with its
    owner when the name alone says nothing ("emilkowalski-skills")."""
    parts = [p for p in re.split(r"[/:]", source.rstrip("/")) if p]
    repo = re.sub(r"\.git$", "", parts[-1]) if parts else "plugin"
    if (
        repo.lower() in ("skills", "plugin", "plugins", "claude-skills", "agent-skills")
        and len(parts) > 1
    ):
        repo = f"{parts[-2]}-{repo}"
    return repo


def _skill_name(folder: Path) -> str:
    """The `name` in a skill's SKILL.md front matter (safe as a folder name), else the folder's own name."""
    try:
        head = (folder / "SKILL.md").read_text(encoding="utf-8")[:2000]
    except OSError:
        return folder.name
    m = (
        re.search(r"^name:\s*[\"']?([^\"'\n]+)", head, re.MULTILINE)
        if head.startswith("---")
        else None
    )
    name = (
        re.sub(r"[^a-z0-9-]+", "-", m.group(1).strip().lower()).strip("-") if m else ""
    )
    return name or folder.name


def _skill_dirs(folder: Path) -> list[Path]:
    out = []
    for skill_md in folder.rglob("SKILL.md"):
        if ".git" in skill_md.parts or "node_modules" in skill_md.parts:
            continue
        out.append(skill_md.parent)
    return sorted(out)


_IGNORED = (".git", "node_modules", "__pycache__")


def _inside(checkout: Path, path: Path) -> bool:
    """Whether `path` (resolved) stays inside the checkout."""
    return path.resolve().is_relative_to(checkout.resolve())


def _check_link(checkout: Path, link: Path, shown: str) -> None:
    """A link may stay: a repository that links one of its own files from another folder (ui-ux-pro-max does) is
    copied with that file in place of the link. One that leaves the repository could point anywhere on this machine
    (a key, a home folder) and is refused, and so is a folder link back into its own parents (the copy never ends)."""
    target = link.resolve()
    if not _inside(checkout, target):
        raise PluginError(
            f"{shown} is a link out of the repository; a plugin's files must be its own."
        )
    if target.is_dir() and link.parent.resolve().is_relative_to(target):
        raise PluginError(f"{shown} is a link to a folder that holds it.")


def _check_tree(src: Path, checkout: Path) -> int:
    """The bytes a copy of `src` takes, with every link checked (_check_link)."""
    total = 0
    if src.is_symlink():
        _check_link(checkout, src, src.name)
    for root, dirs, files in os.walk(src, followlinks=True):
        dirs[:] = [d for d in dirs if d not in _IGNORED]
        for name in [*dirs, *files]:
            p = Path(root) / name
            if p.is_symlink():
                _check_link(checkout, p, str(p.relative_to(src)))
        for name in files:
            total += (Path(root) / name).stat().st_size
    return total


def _copy(src: Path, dst: Path) -> None:
    shutil.copytree(
        src,
        dst,
        symlinks=False,  # a link inside the repository becomes the file it points to (_check_tree checked them)
        ignore=shutil.ignore_patterns(*_IGNORED),
        dirs_exist_ok=True,
    )


def build(
    checkout: Path,
    *,
    plugin: str | None = None,
    skills: list[str] | None = None,
    into: Path,
    name_hint: str | None = None,
) -> dict:
    """Make an installable plugin folder `into` from a checkout (see the layouts in the module doc).

    Returns:
        {name, version, description, skills: [names], hooks, mcp, size_bytes, choices: [marketplace entries]}
    """
    market = _manifest(checkout, "marketplace.json")
    entries = market.get("plugins") or []
    root_manifest = _manifest(checkout, "plugin.json")
    source_dir: Path | None = None
    picked_skills: list[Path] | None = None
    meta: dict = {}
    if plugin and entries:
        entry = next((e for e in entries if e.get("name") == plugin), None)
        if entry is None:
            raise PluginError(
                f"The marketplace has no plugin called {plugin}. It has: {', '.join(e.get('name', '?') for e in entries)[:200]}"
            )
        meta = {
            "name": entry.get("name"),
            "version": entry.get("version"),
            "description": entry.get("description"),
        }
        src = entry.get("source")
        if isinstance(src, dict):
            raise PluginError(
                f"{plugin} lives in another repository ({src.get('url')}); install it from there."
            )
        if src is not None and not isinstance(src, str):
            raise PluginError(f"{plugin} has a source the board cannot read.")
        base = (checkout / (src or "./")).resolve()
        if not _inside(checkout, base):
            raise PluginError("The marketplace points outside its own repository.")
        listed = entry.get("skills")
        if isinstance(listed, list) and listed:
            picked_skills = []
            for s in listed:
                p = (checkout / str(s)).resolve()
                if not isinstance(s, str) or not _inside(checkout, p):
                    raise PluginError(
                        "The marketplace points outside its own repository."
                    )
                picked_skills.append(p)
        elif (base / ".claude-plugin" / "plugin.json").is_file() or (
            base / "skills"
        ).is_dir():
            source_dir = base
        else:
            picked_skills = _skill_dirs(base)
    elif root_manifest:
        source_dir = checkout
        meta = {k: root_manifest.get(k) for k in ("name", "version", "description")}
    elif entries and not plugin:
        return {
            "choices": [
                {"name": e.get("name"), "description": e.get("description")}
                for e in entries
            ]
        }
    elif (checkout / "skills").is_dir():
        picked_skills = _skill_dirs(checkout / "skills")
    elif (checkout / "SKILL.md").is_file():
        picked_skills = [checkout]
        # a repository that is one skill: named by its SKILL.md, not by the folder it was cloned into
        meta["name"] = _skill_name(checkout)
    else:
        raise PluginError("No plugin, marketplace or skill was found there.")
    if skills:
        wanted = set(skills)
        pool = (
            picked_skills
            if picked_skills is not None
            else _skill_dirs(source_dir or checkout)
        )
        picked_skills = [p for p in pool if p.name in wanted]
        source_dir = None
        if not picked_skills:
            raise PluginError(f"None of {', '.join(skills)} was found there.")
        if len(skills) == 1:
            meta["name"] = skills[0]
    sources = [source_dir] if source_dir is not None else list(picked_skills or [])
    total = 0
    for src_dir in sources:
        if not _inside(checkout, src_dir):
            raise PluginError("The marketplace points outside its own repository.")
        total += _check_tree(src_dir, checkout)
        if total > MAX_PLUGIN_BYTES:
            raise PluginError(
                f"The plugin is larger than {MAX_PLUGIN_BYTES // (1024 * 1024)} MB; the board does not copy it."
            )
    into.mkdir(parents=True, exist_ok=True)
    if source_dir is not None:
        _copy(source_dir, into)
    else:
        for skill in picked_skills or []:
            _copy(
                skill,
                into
                / "skills"
                / (_skill_name(skill) if skill == checkout else skill.name),
            )
    name = (
        re.sub(
            r"[^a-z0-9-]+",
            "-",
            (meta.get("name") or plugin or name_hint or into.name).lower(),
        ).strip("-")
        or "plugin"
    )
    manifest_path = into / ".claude-plugin" / "plugin.json"
    if not manifest_path.is_file():
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps(
                {
                    "name": name,
                    "version": meta.get("version") or "0.0.0",
                    "description": meta.get("description") or "",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    final = _manifest(into, "plugin.json")
    hooks = 0
    try:
        hooks_data = json.loads(
            (into / "hooks" / "hooks.json").read_text(encoding="utf-8")
        )
        hooks = sum(len(v) for v in (hooks_data.get("hooks") or {}).values())
    except (OSError, ValueError, AttributeError):
        pass
    mcp = 0
    try:
        mcp = len(
            (
                json.loads((into / ".mcp.json").read_text(encoding="utf-8")).get(
                    "mcpServers"
                )
                or {}
            )
        )
    except (OSError, ValueError):
        pass
    size = sum(f.stat().st_size for f in into.rglob("*") if f.is_file())
    return {
        "name": final.get("name") or name,
        "version": final.get("version") or meta.get("version"),
        "description": final.get("description") or meta.get("description"),
        "skills": sorted({d.name for d in _skill_dirs(into)}),
        "hooks": hooks,
        "mcp": mcp,
        "size_bytes": size,
    }


def _fetch(
    source_kind: str, source: str, ref: str | None, workdir: str
) -> tuple[Path, str | None]:
    """The source as a local checkout: (folder, commit or None for a plain folder)."""
    if source_kind == "folder":
        folder = Path(os.path.expanduser(source))
        if not folder.is_dir():
            raise PluginError(f"No such folder: {source}")
        commit = None
        if (folder / ".git").exists():
            commit = (
                _run(["git", "rev-parse", "HEAD"], cwd=str(folder)).stdout.strip()
                or None
            )
        return folder, commit
    dest = Path(workdir) / "checkout"
    return dest, _clone(source, ref, str(dest))


async def preview(
    source_kind: str,
    source: str,
    *,
    ref: str | None = None,
    plugin: str | None = None,
    skills: list[str] | None = None,
) -> dict:
    """What would be installed, without installing: name, version, skills, hooks, MCP servers, size, the commit."""

    def go() -> dict:
        with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
            checkout, commit = _fetch(source_kind, source, ref, tmp)
            info = build(
                checkout, plugin=plugin, skills=skills, into=Path(tmp) / "built"
            )
            return {**info, "commit": commit}

    return await asyncio.to_thread(go)


async def install(
    session,
    project_id: str,
    *,
    source_kind: str,
    source: str,
    ref: str | None = None,
    plugin: str | None = None,
    skills: list[str] | None = None,
    roles: list[str] | None = None,
    default_on: bool = False,
    by: str,
) -> AiPlugin:
    """Install a plugin for the project (no review step, D1): copied into the board's cache at its commit."""
    if source_kind not in ("git", "marketplace", "folder"):
        raise PluginError("A source is a git URL, a marketplace or a folder.")

    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch, source_kind, source, ref, tmp
        )
        staging_path = Path(tmp) / "built"
        info = await asyncio.to_thread(
            build,
            checkout,
            plugin=plugin,
            skills=skills,
            into=staging_path,
            name_hint=source_name(source),
        )
        if info.get("choices"):
            raise PluginError("This is a marketplace: pick which plugin to install.")
        same = (
            await session.exec(
                select(AiPlugin).where(
                    AiPlugin.project_id == project_id, AiPlugin.name == info["name"]
                )
            )
        ).first()
        if same is not None:
            raise PluginError(f"{info['name']} is already installed on this project.")
        row = AiPlugin(
            project_id=project_id,
            name=info["name"],
            source_kind=source_kind,
            source=source,
            ref=ref,
            plugin=plugin,
            skills_wanted=json.dumps(skills or []),
            commit=commit,
            version=info.get("version"),
            description=info.get("description"),
            skills=json.dumps(info["skills"]),
            hooks=info["hooks"],
            mcp=info["mcp"],
            size_bytes=info["size_bytes"],
            default_on=default_on,
            roles=json.dumps(roles or []),
            installed_by=by,
            pinned=bool(ref and re.fullmatch(r"[0-9a-f]{7,40}", ref)),
        )
        dest = cache_root() / row.id / (commit or "folder")
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        await asyncio.to_thread(shutil.copytree, staging_path, dest)
        row.path = str(dest)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _reinstall(
    session, row: AiPlugin, *, ref: str | None, keep_previous: bool
) -> AiPlugin:
    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch, row.source_kind, row.source, ref, tmp
        )
        staging_path = Path(tmp) / "built"
        wanted = json.loads(row.skills_wanted or "[]") or None
        info = await asyncio.to_thread(
            build, checkout, plugin=row.plugin, skills=wanted, into=staging_path
        )
        dest = (
            cache_root()
            / row.id
            / (commit or f"folder-{int(datetime.now(UTC).timestamp())}")
        )
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        await asyncio.to_thread(shutil.copytree, staging_path, dest)
    if keep_previous and row.path:
        row.previous = json.dumps(
            {
                "path": row.path,
                "commit": row.commit,
                "version": row.version,
                "skills": loads(row.skills, []),
            }
        )
    elif row.path and row.path != str(dest):
        shutil.rmtree(row.path, ignore_errors=True)
    row.path = str(dest)
    row.commit = commit
    row.version = info.get("version")
    row.skills = json.dumps(info["skills"])
    row.hooks = info["hooks"]
    row.mcp = info["mcp"]
    row.size_bytes = info["size_bytes"]
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def latest_commit(row: AiPlugin) -> str | None:
    """The source's newest commit (on its ref, or the default branch), or None for a folder or when it cannot tell."""
    if row.source_kind == "folder":
        return None
    out = await asyncio.to_thread(
        _run, ["git", "ls-remote", "--", row.source, row.ref or "HEAD"], None, 60
    )
    first = out.stdout.split()
    return first[0] if out.returncode == 0 and first else None


async def check_update(row: AiPlugin) -> dict:
    """Whether a newer version is out (never applied on its own); a pinned plugin is never offered one."""
    if row.pinned:
        return {"update": False, "pinned": True}
    newest = await latest_commit(row)
    return {
        "update": bool(newest and row.commit and newest != row.commit),
        "latest": newest,
        "current": row.commit,
    }


async def changes(row: AiPlugin) -> dict:
    """What an update would change: files added, removed and changed between the installed copy and the newest."""
    with tempfile.TemporaryDirectory(prefix="kanban-plugin-") as tmp:
        checkout, commit = await asyncio.to_thread(
            _fetch,
            row.source_kind,
            row.source,
            None if not row.pinned else row.ref,
            tmp,
        )
        built = Path(tmp) / "built"
        wanted = json.loads(row.skills_wanted or "[]") or None
        await asyncio.to_thread(
            build, checkout, plugin=row.plugin, skills=wanted, into=built
        )
        old = (
            {
                str(p.relative_to(row.path)): p.read_bytes()
                for p in Path(row.path).rglob("*")
                if p.is_file()
            }
            if row.path and Path(row.path).is_dir()
            else {}
        )
        new = {
            str(p.relative_to(built)): p.read_bytes()
            for p in built.rglob("*")
            if p.is_file()
        }
    return {
        "commit": commit,
        "added": sorted(set(new) - set(old)),
        "removed": sorted(set(old) - set(new)),
        "changed": sorted(k for k in set(new) & set(old) if new[k] != old[k]),
    }


async def update(session, row: AiPlugin) -> AiPlugin:
    """Install the newest version; the previous one is kept so one button can put it back."""
    if row.pinned:
        raise PluginError(f"{row.name} is pinned: unpin it to update.")
    return await _reinstall(session, row, ref=row.ref, keep_previous=True)


async def rollback(session, row: AiPlugin) -> AiPlugin:
    """Put the previous version back."""
    prev = loads(row.previous, None)
    if not prev or not Path(prev.get("path", "")).is_dir():
        raise PluginError("There is no previous version to put back.")
    current = {
        "path": row.path,
        "commit": row.commit,
        "version": row.version,
        "skills": loads(row.skills, []),
    }
    row.path, row.commit, row.version = (
        prev["path"],
        prev.get("commit"),
        prev.get("version"),
    )
    row.skills = json.dumps(prev.get("skills") or [])
    row.previous = json.dumps(current)
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def reload(session, row: AiPlugin) -> AiPlugin:
    """Re-read the source (a folder's current files, or the same commit of a repository)."""
    return await _reinstall(
        session,
        row,
        ref=row.commit if row.source_kind != "folder" else None,
        keep_previous=False,
    )


async def reset(session, row: AiPlugin) -> AiPlugin:
    """Back to the catalogue version: the recorded commit, freshly copied, dropping anything changed locally."""
    return await reload(session, row)


async def pin(session, row: AiPlugin, on: bool) -> AiPlugin:
    """Pin to the installed commit (no update is offered until unpinned)."""
    row.pinned = on
    if on and row.commit:
        row.ref = row.commit
    elif not on and row.ref and re.fullmatch(r"[0-9a-f]{7,40}", row.ref):
        row.ref = None
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def remove(session, row: AiPlugin) -> None:
    """Uninstall: the row and every cached copy."""
    shutil.rmtree(cache_root() / row.id, ignore_errors=True)
    await session.delete(row)
    await session.commit()


def role_of(profile: AiMember) -> str | None:
    """The member's role pack key (set when it was made from a pack), or None."""
    cfg = loads(profile.config, {}) or {}
    return cfg.get("role") or (cfg.get("pack") or {}).get("key")


def on_for(row: AiPlugin, profile: AiMember) -> bool:
    """Whether a member gets the plugin: its own switch, else the project default, else its role."""
    overrides = loads(row.members, {}) or {}
    if profile.id in overrides:
        return bool(overrides[profile.id])
    if row.default_on:
        return True
    return role_of(profile) in (loads(row.roles, []) or [])


def _norm_source(source: str) -> str:
    return re.sub(r"\.git$", "", (source or "").strip().rstrip("/")).lower()


def catalogue_entry_for(row: AiPlugin) -> dict | None:
    """The catalogue entry a plugin was installed from: same source, same marketplace entry, its skills."""
    have = set(loads(row.skills, []) or [])
    for e in CATALOGUE:
        if e.get("kind") != "plugin" or _norm_source(
            e.get("source", "")
        ) != _norm_source(row.source):
            continue
        if (e.get("plugin") or None) != (row.plugin or None) and e.get("plugin"):
            continue
        wanted = set(e.get("skills") or [])
        if wanted and not wanted & have:
            continue
        return e
    return None


async def skills_block(session, profile: AiMember) -> str:
    """The skills a member's run loads, by the exact name the Skill tool takes and with the work each one covers. A run
    that is only handed plugin folders seldom opens one (a live Designer run had 12 and opened none of them)."""
    rows = (
        await session.exec(
            select(AiPlugin).where(AiPlugin.project_id == profile.project_id)
        )
    ).all()
    lines = []
    for r in rows:
        if not (r.path and Path(r.path).is_dir() and on_for(r, profile)):
            continue
        names = loads(r.skills, []) or []
        if not names:
            continue
        entry = catalogue_entry_for(r)
        listed = ", ".join(f"`{r.name}:{n}`" for n in names)
        use = (entry or {}).get("use")
        lines.append(f"- {listed}: {use}" if use else f"- {listed}")
    if not lines:
        return ""
    return (
        "Skills installed for you. Plan first: before the first file, put your steps on the ticket as sub-tasks "
        "(ticket_items item='sub_task', one call; in your first message if you may not edit the ticket), each skill below you will use as its own item right before the work "
        "it serves. When you reach that item, open the skill with the Skill tool by the exact name below, follow it and "
        "tick the item. Where one disagrees with the board's own guide (`kanban-board:canvas-design`), the guide wins. "
        "Your report names the skills you opened and why you dropped any you planned.\n"
        + "\n".join(lines)
    )


async def dirs_for(session, profile: AiMember) -> list[str]:
    """The plugin folders a member's run loads."""
    rows = (
        await session.exec(
            select(AiPlugin).where(col(AiPlugin.project_id).in_([profile.project_id]))
        )
    ).all()
    return [
        r.path for r in rows if r.path and Path(r.path).is_dir() and on_for(r, profile)
    ]


async def set_member(
    session, row: AiPlugin, member_id: str, on: bool | None
) -> AiPlugin:
    """A member's own switch (None: follow the project default again)."""
    overrides = loads(row.members, {}) or {}
    if on is None:
        overrides.pop(member_id, None)
    else:
        overrides[member_id] = on
    row.members = json.dumps(overrides)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def usage(session, project_id: str) -> dict[str, dict]:
    """Real use of each plugin's skills, from the run stream: {plugin name: {uses, by_member: {id: n}, last}}."""
    out: dict[str, dict] = {}
    for use in (
        await session.exec(
            select(AiSkillUse).where(AiSkillUse.project_id == project_id)
        )
    ).all():
        name = use.plugin or use.name
        row = out.setdefault(name, {"uses": 0, "by_member": {}, "last": None})
        row["uses"] += 1
        if use.member_id:
            row["by_member"][use.member_id] = row["by_member"].get(use.member_id, 0) + 1
        row["last"] = max(row["last"] or "", use.at)
    return out


def to_dict(row: AiPlugin, used: dict | None = None) -> dict:
    """A plugin for the API."""
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "source_kind": row.source_kind,
        "source": row.source,
        "ref": row.ref,
        "plugin": row.plugin,
        "commit": row.commit,
        "version": row.version,
        "description": row.description,
        "skills": loads(row.skills, []),
        "hooks": row.hooks,
        "mcp": row.mcp,
        "size_bytes": row.size_bytes,
        "pinned": row.pinned,
        "default_on": row.default_on,
        "roles": loads(row.roles, []),
        # lists, not dicts keyed by member id: the UI client camel-cases object keys, which would change an id
        "members": [
            {"member_id": k, "on": v} for k, v in (loads(row.members, {}) or {}).items()
        ],
        "has_previous": bool(loads(row.previous, None)),
        "installed_by": row.installed_by,
        "installed_at": row.installed_at,
        "updated_at": row.updated_at,
        "used": {
            "uses": (used or {}).get("uses", 0),
            "by_member": [
                {"member_id": k, "uses": n}
                for k, n in ((used or {}).get("by_member") or {}).items()
            ],
            "last": (used or {}).get("last"),
        },
    }
