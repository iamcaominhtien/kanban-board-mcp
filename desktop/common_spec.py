# -*- mode: python ; coding: utf-8 -*-
import os

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

_HERE = os.path.dirname(os.path.abspath(__file__))
_WORKSPACE_ROOT = os.path.dirname(_HERE)

def get_base_analysis_args(entry_point, app_name):
    # Common hidden imports for both binaries
    sqlmodel_hidden = collect_submodules('sqlmodel')
    anyio_hidden = collect_submodules('anyio')
    alembic_hidden = collect_submodules('alembic')
    aiosqlite_hidden = collect_submodules('aiosqlite')
    sqlalchemy_async_hidden = ['sqlalchemy.ext.asyncio']

    # Common metadata
    pydantic_meta = copy_metadata('pydantic')
    pydantic_meta += copy_metadata('pydantic_core')
    pydantic_meta += copy_metadata('sqlmodel')
    pydantic_meta += copy_metadata('anyio')

    # Common data files (Alembic)
    alembic_data = collect_data_files('alembic')
    alembic_data += [
        (os.path.join(_WORKSPACE_ROOT, 'server', 'alembic'), 'alembic'),
        (os.path.join(_WORKSPACE_ROOT, 'server', 'alembic.ini'), '.'),
    ]

    hidden_imports = (
        sqlmodel_hidden + anyio_hidden + alembic_hidden + aiosqlite_hidden +
        sqlalchemy_async_hidden +
        ['sqlalchemy.dialects.sqlite', 'multiprocessing.freeze_support']
    )

    return {
        'scripts': [os.path.join(_WORKSPACE_ROOT, entry_point)],
        'pathex': [_WORKSPACE_ROOT, os.path.join(_WORKSPACE_ROOT, 'server')],
        'datas': alembic_data + pydantic_meta,
        'hiddenimports': hidden_imports,
    }
