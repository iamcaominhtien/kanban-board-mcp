# -*- mode: python ; coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(SPEC)))

from PyInstaller.utils.hooks import collect_submodules, copy_metadata
from common_spec import get_base_analysis_args

block_cipher = None

# MCP-specific extras
mcp_hidden = collect_submodules('mcp')
extra_meta = copy_metadata('mcp')

base = get_base_analysis_args('server/mcp_stdio.py', 'kanban-mcp-stdio')

a = Analysis(
    base['scripts'],
    pathex=base['pathex'],
    binaries=[],
    datas=base['datas'] + extra_meta,
    hiddenimports=base['hiddenimports'] + mcp_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='kanban-mcp-stdio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # stdio mode must use stdout
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
