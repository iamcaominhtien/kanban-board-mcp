# -*- mode: python ; coding: utf-8 -*-
import os

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

_HERE = os.path.dirname(os.path.abspath(__file__))
_WORKSPACE_ROOT = os.path.dirname(_HERE)

# Both programs live in one folder and share its _internal/ (the Python runtime and the libraries), so they are
# installed once. The folder keeps the stdio binary's old name: MCP clients outside the app (Claude Desktop, VS Code,
# Cursor) store Resources/kanban-mcp-stdio/kanban-mcp-stdio as their command, and it must not move.
BUNDLE_DIR = 'kanban-mcp-stdio'

# Stdlib / dev-only packages the apps never import; leaving them out shrinks the bundle.
EXCLUDES = [
    'tkinter', '_tkinter', 'turtle', 'idlelib', 'lib2to3', 'pydoc_data',
    'pytest', '_pytest', 'IPython', 'matplotlib', 'numpy', 'pandas', 'PIL',
    # Command-line tools that come with fastapi[standard] and mcp[cli] (`fastapi run`, `fastapi deploy`, `mcp dev`),
    # and what only they use. collect_submodules('fastapi'/'mcp') would otherwise pull them in. The servers import
    # rich only inside a try/except (mcp's logging) and httpx imports its CLI the same way.
    'fastapi.cli', 'fastapi_cli', 'fastapi_cloud_cli', 'rich_toolkit', 'rignore', 'fastar', 'sentry_sdk',
    'mcp.cli', 'typer', 'rich', 'pygments', 'markdown_it', 'mdurl', 'httpx._main',
    # Build tools. Not setuptools / pkg_resources / distutils: on Windows something imports distutils, and
    # PyInstaller's distutils hook aliases it to setuptools._distutils, which fails when either is excluded
    # ("Target module "distutils" already imported as ExcludedModule").
    'pip',
]

def get_base_analysis_args(entry_point, app_name):
    # Common hidden imports for both binaries
    sqlmodel_hidden = collect_submodules('sqlmodel')
    anyio_hidden = collect_submodules('anyio')
    alembic_hidden = collect_submodules('alembic')
    aiosqlite_hidden = collect_submodules('aiosqlite')
    sqlalchemy_async_hidden = ['sqlalchemy.ext.asyncio']
    # PostgreSQL and MySQL/MariaDB (App settings › Storage & backup › Database): their async drivers and SQLAlchemy
    # dialects are imported by name from a connection URL, so PyInstaller cannot see them
    server_db_hidden = (
        collect_submodules('asyncpg') + collect_submodules('aiomysql') + collect_submodules('pymysql') +
        ['sqlalchemy.dialects.postgresql', 'sqlalchemy.dialects.postgresql.asyncpg',
         'sqlalchemy.dialects.mysql', 'sqlalchemy.dialects.mysql.aiomysql']
    )
    # API keys: the encryption key lives in the OS keychain; keyring is imported lazily and finds its
    # backends through entry points, so both the modules and the metadata must be bundled
    keyring_hidden = collect_submodules('keyring')
    # Time zones: zoneinfo falls back to the tzdata package when the OS has no tz database (Windows,
    # trimmed Linux). PyInstaller's zoneinfo hook only adds tzdata on Windows; naming it here bundles
    # it everywhere, and the tzdata hook (pyinstaller-hooks-contrib) collects its data files
    tzdata_hidden = ['tzdata']

    # Common metadata
    pydantic_meta = copy_metadata('pydantic')
    pydantic_meta += copy_metadata('pydantic_core')
    pydantic_meta += copy_metadata('sqlmodel')
    pydantic_meta += copy_metadata('anyio')
    pydantic_meta += copy_metadata('keyring')

    # Common data files (Alembic)
    alembic_data = collect_data_files('alembic')
    alembic_data += [
        (os.path.join(_WORKSPACE_ROOT, 'server', 'alembic'), 'alembic'),
        (os.path.join(_WORKSPACE_ROOT, 'server', 'alembic.ini'), '.'),
        # the design guide's exemplar boards, which the board's canvas-design skill carries (services/canvas_design.py)
        (os.path.join(_WORKSPACE_ROOT, 'server', 'services', 'design_examples'), os.path.join('services', 'design_examples')),
        # the slides skill's guide.md, themes, scripts and examples, read when the shared skills are built at import
        # (services/slides_skill); without them both programs exit on start
        (os.path.join(_WORKSPACE_ROOT, 'server', 'services', 'slides_skill'), os.path.join('services', 'slides_skill')),
        # the BA's document templates, which its role-ba skill and the Docs page templates read (services/ba_templates)
        (os.path.join(_WORKSPACE_ROOT, 'server', 'services', 'ba_templates'), os.path.join('services', 'ba_templates')),
        # the assistants' feature skills (SKILL.md files), shipped to every assistant turn as a plugin (services/assistant/skills.py)
        (os.path.join(_WORKSPACE_ROOT, 'server', 'services', 'assistant', 'skills'), os.path.join('services', 'assistant', 'skills')),
    ]

    hidden_imports = (
        sqlmodel_hidden + anyio_hidden + alembic_hidden + aiosqlite_hidden +
        sqlalchemy_async_hidden + server_db_hidden + keyring_hidden + tzdata_hidden +
        ['sqlalchemy.dialects.sqlite', 'multiprocessing.freeze_support', 'psutil']
    )

    return {
        'scripts': [os.path.join(_WORKSPACE_ROOT, entry_point)],
        'pathex': [_WORKSPACE_ROOT, os.path.join(_WORKSPACE_ROOT, 'server')],
        'datas': alembic_data + pydantic_meta,
        'hiddenimports': hidden_imports,
        'excludes': EXCLUDES,
    }
