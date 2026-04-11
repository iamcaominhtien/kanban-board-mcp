# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

block_cipher = None

mcp_hidden = collect_submodules('mcp')
sqlmodel_hidden = collect_submodules('sqlmodel')
anyio_hidden = collect_submodules('anyio')

pydantic_meta = copy_metadata('pydantic')
pydantic_meta += copy_metadata('pydantic_core')
pydantic_meta += copy_metadata('mcp')
pydantic_meta += copy_metadata('sqlmodel')
pydantic_meta += copy_metadata('anyio')

alembic_data = collect_data_files('alembic')
alembic_data += [
    ('server/alembic', 'alembic'),
    ('server/alembic.ini', '.'),
]

a = Analysis(
    ['server/mcp_stdio.py'],
    pathex=['.'],
    binaries=[],
    datas=alembic_data + pydantic_meta,
    hiddenimports=(
        mcp_hidden + sqlmodel_hidden + anyio_hidden +
        ['aiosqlite', 'sqlalchemy.dialects.sqlite', 'multiprocessing.freeze_support']
    ),
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
