"""Golden vectors for `delete_project` in crates/kb-board/src/projects.rs: which rows of each table go with a project.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_project_delete.py
Writes `project_delete.json` next to this file: the tables in the order `services/projects.py:delete_project` walks
them (`reversed(SQLModel.metadata.sorted_tables)`), each with the condition `_owned_by` gives for project `P`
(null for a table that is not tied to a project).
"""

import json
import os
import re
import sys
import tempfile
from pathlib import Path

# importing the models must not open the developer's own database
_tmp = tempfile.mkdtemp(prefix="golden-project-delete-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`: the script's own folder is not where `services` is

from sqlmodel import SQLModel  # noqa: E402

import models  # noqa: E402,F401
from services.projects import _owned_by  # noqa: E402

OUT = Path(__file__).with_name("project_delete.json")

tables = []
for table in reversed(SQLModel.metadata.sorted_tables):
    condition = _owned_by(table, "P")
    sql = None
    if condition is not None:
        sql = re.sub(r"\s+", " ", str(condition.compile(compile_kwargs={"literal_binds": True})))
    tables.append({"table": table.name, "where": sql})

OUT.write_text(json.dumps({"tables": tables}, indent=1) + "\n", encoding="utf-8")
print(f"{OUT.name}: {len(tables)} tables, {sum(1 for t in tables if t['where'])} tied to a project", file=sys.stderr)
