# -*- mode: python ; coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(SPEC)))

from PyInstaller.utils.hooks import collect_submodules, copy_metadata
from common_spec import get_base_analysis_args

block_cipher = None

# Server-specific extras
uvicorn_hidden = collect_submodules('uvicorn')
fastapi_hidden = collect_submodules('fastapi')
starlette_hidden = collect_submodules('starlette')

# Metadata for server-specific packages only (sqlmodel/anyio already in common_spec)
extra_meta = (
    copy_metadata('fastapi') +
    copy_metadata('starlette') +
    copy_metadata('uvicorn')
)

base = get_base_analysis_args('server/main.py', 'kanban-server')

a = Analysis(
    base['scripts'],
    pathex=base['pathex'],
    binaries=[],
    datas=base['datas'] + extra_meta,
    hiddenimports=base['hiddenimports'] + uvicorn_hidden + fastapi_hidden + starlette_hidden,
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
    name='kanban-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # needs stdout for READY port=N signal
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
