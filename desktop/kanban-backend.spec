# -*- mode: python ; coding: utf-8 -*-
# Builds both Python programs of the desktop app into ONE onedir folder (common_spec.BUNDLE_DIR):
#
#   kanban-mcp-stdio/
#     kanban-server[.exe]     the HTTP server the app starts
#     kanban-mcp-stdio[.exe]  the stdio MCP server that AI clients start
#     _internal/              Python runtime + libraries, shared by both
#
# Two separate onedir builds used to carry two copies of _internal/ (about 50 MB each).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(SPEC)))

from PyInstaller.utils.hooks import collect_submodules, copy_metadata
from common_spec import BUNDLE_DIR, get_base_analysis_args

block_cipher = None


def submodules(package):
    # The CLI subpackages are excluded (common_spec.EXCLUDES); asking for them as hidden imports only logs errors
    return collect_submodules(package, filter=lambda name: not name.startswith(f'{package}.cli'))


def analysis(entry_point, app_name, extra_hidden, extra_meta):
    base = get_base_analysis_args(entry_point, app_name)
    return Analysis(
        base['scripts'],
        pathex=base['pathex'],
        binaries=[],
        datas=base['datas'] + extra_meta,
        hiddenimports=base['hiddenimports'] + extra_hidden,
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=base['excludes'],
        win_no_prefer_redirects=False,
        win_private_assemblies=False,
        cipher=block_cipher,
        noarchive=False,
    )


def executable(a, name):
    pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
    return EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,  # onedir: libs stay on disk, so launch skips the per-run temp extraction
        name=name,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,  # the server prints READY port=N on stdout; the stdio server speaks MCP on stdout
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )


server_a = analysis(
    'server/main.py',
    'kanban-server',
    # runner: the AI runner process is this same program started with --runner (server/runner, AI v2)
    submodules('uvicorn') + submodules('fastapi') + submodules('starlette') + ['runner', 'runner.main'],
    copy_metadata('fastapi') + copy_metadata('starlette') + copy_metadata('uvicorn'),
)
stdio_a = analysis(
    'server/mcp_stdio.py',
    'kanban-mcp-stdio',
    submodules('mcp'),
    copy_metadata('mcp'),
)

server_exe = executable(server_a, 'kanban-server')
stdio_exe = executable(stdio_a, 'kanban-mcp-stdio')

# One COLLECT: files both analyses found (the same file from the same venv) are written once.
coll = COLLECT(
    server_exe,
    server_a.binaries,
    server_a.datas,
    stdio_exe,
    stdio_a.binaries,
    stdio_a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=BUNDLE_DIR,
)
