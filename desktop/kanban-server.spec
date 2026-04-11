# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

block_cipher = None

# Collect all uvicorn submodules and data files
uvicorn_hidden = collect_submodules('uvicorn')
fastapi_hidden = collect_submodules('fastapi')
sqlmodel_hidden = collect_submodules('sqlmodel')
anyio_hidden = collect_submodules('anyio')
starlette_hidden = collect_submodules('starlette')

# Collect metadata required by pydantic v2 and others
pydantic_meta = copy_metadata('pydantic')
pydantic_meta += copy_metadata('pydantic_core')
pydantic_meta += copy_metadata('fastapi')
pydantic_meta += copy_metadata('starlette')
pydantic_meta += copy_metadata('uvicorn')
pydantic_meta += copy_metadata('sqlmodel')
pydantic_meta += copy_metadata('anyio')

# Alembic needs its migration scripts as data files
alembic_data = collect_data_files('alembic')
alembic_data += [
    ('server/alembic', 'alembic'),
    ('server/alembic.ini', '.'),
]

a = Analysis(
    ['server/main.py'],
    pathex=['.'],
    binaries=[],
    datas=alembic_data + pydantic_meta,
    hiddenimports=(
        uvicorn_hidden + fastapi_hidden + sqlmodel_hidden +
        anyio_hidden + starlette_hidden +
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
