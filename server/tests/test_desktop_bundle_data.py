"""Every data file the server reads from beside its code is bundled into the desktop app (desktop/common_spec.py).

PyInstaller packs only Python modules; a file such as ``services/slides_skill/guide.md`` reaches the installed app
only when the spec's ``datas`` names it. 3.27.0 shipped without the slides skill's folder, and both programs exited
on start (``FileNotFoundError`` while ``services.shared_skills`` was imported), which a checkout never shows.
"""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent
SPEC = SERVER.parent / "desktop" / "common_spec.py"


@pytest.fixture
def datas(monkeypatch) -> list[tuple[Path, Path]]:
    """The spec's ``(source, destination)`` data entries, with PyInstaller's helpers stubbed out."""
    hooks = types.ModuleType("PyInstaller.utils.hooks")
    hooks.collect_submodules = lambda *a, **k: []
    hooks.collect_data_files = lambda *a, **k: []
    hooks.copy_metadata = lambda *a, **k: []
    for name in ("PyInstaller", "PyInstaller.utils"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "PyInstaller.utils.hooks", hooks)
    spec = importlib.util.spec_from_file_location("common_spec_under_test", SPEC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    args = module.get_base_analysis_args("server/main.py", "kanban-server")
    return [(Path(src), Path(dest)) for src, dest in args["datas"]]


def _bundled_as(path: Path, datas: list[tuple[Path, Path]]) -> Path | None:
    """Where ``path`` lands inside the bundle, or None when no entry carries it."""
    for src, dest in datas:
        if path == src:
            return dest / path.name if src.is_file() else dest
        if src.is_dir() and path.is_relative_to(src):
            return dest / path.relative_to(src)
    return None


def _data_files() -> list[Path]:
    """The files under ``services/`` that are not Python code: what the server reads from beside its modules."""
    return sorted(
        p
        for p in (SERVER / "services").rglob("*")
        if p.is_file()
        and p.suffix not in {".py", ".pyc"}
        and not any(
            part.startswith((".", "__")) for part in p.relative_to(SERVER).parts
        )
    )


def test_every_services_data_file_is_bundled_at_its_own_path(datas):
    files = _data_files()
    # the folder 3.27.0 left out is seen by this test
    assert any(p.name == "guide.md" for p in files)
    wrong = {
        str(p.relative_to(SERVER)): _bundled_as(p, datas)
        for p in files
        if _bundled_as(p, datas) != p.relative_to(SERVER)
    }
    assert not wrong, (
        f"not bundled where the code reads them (add them to desktop/common_spec.py datas): {wrong}"
    )


def test_alembic_is_bundled(datas):
    assert _bundled_as(SERVER / "alembic.ini", datas) == Path("alembic.ini")
    assert (
        _bundled_as(SERVER / "alembic" / "env.py", datas) == Path("alembic") / "env.py"
    )
