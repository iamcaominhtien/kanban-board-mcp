# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

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
        ('server/alembic', 'alembic'),
        ('server/alembic.ini', '.'),
    ]

    hidden_imports = (
        sqlmodel_hidden + anyio_hidden + alembic_hidden + aiosqlite_hidden +
        sqlalchemy_async_hidden +
        ['sqlalchemy.dialects.sqlite', 'multiprocessing.freeze_support']
    )

    return {
        'scripts': [entry_point],
        'pathex': ['.'],
        'datas': alembic_data + pydantic_meta,
        'hiddenimports': hidden_imports,
    }
