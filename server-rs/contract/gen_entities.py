"""Generate the SeaORM entities of `kb-db` from the SQLModel tables of the Python server.

Run from `server/` with its virtualenv:

    .venv/bin/python ../server-rs/contract/gen_entities.py

Writes `server-rs/crates/kb-db/src/entities/<table>.rs` and `mod.rs`. One module per table: the `Model` (a row), and
`new()`, an `ActiveModel` filled with the defaults the Python model gives a new row (ids, times, "[]"...), so a port
sets only what the Python code sets. The script is deleted with the Python server; from then on the entities are
edited by hand, with the migrations.
"""

import inspect
import keyword
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from sqlalchemy import BigInteger, Boolean, Float, Integer, String  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

import models  # noqa: E402,F401 - registers every table

OUT = Path(__file__).resolve().parent.parent / "crates" / "kb-db" / "src" / "entities"
RUST_KEYWORDS = {
    "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super",
    "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box",
    "do", "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen",
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HEX_RE = re.compile(r"^[0-9a-f]{32}$")
PREFIXED_RE = re.compile(r"^([a-z]+_)([0-9a-f]+)$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$")


def rust_type(column) -> str:
    t = column.type
    t = getattr(t, "impl", t)  # AutoString and LongText are decorators around VARCHAR
    try:
        py = t.python_type
    except NotImplementedError:
        py = None
    if isinstance(t, Boolean) or py is bool:
        base = "bool"
    elif isinstance(t, BigInteger):
        base = "i64"
    elif isinstance(t, Integer) or py is int:
        base = "i32"
    elif isinstance(t, Float) or py is float:
        base = "f64"
    elif isinstance(t, String) or py is str:
        base = "String"
    else:
        raise SystemExit(f"unmapped column type {t!r} on {column.table.name}.{column.name}")
    return f"Option<{base}>" if column.nullable else base


def field_name(name: str) -> str:
    return f"r#{name}" if name in RUST_KEYWORDS else name


def rust_literal(value, column) -> str | None:
    nullable = column.nullable
    if value is None:
        return "None" if nullable else None
    if isinstance(value, bool):
        lit = "true" if value else "false"
    elif isinstance(value, int):
        lit = str(value)
    elif isinstance(value, float):
        lit = repr(value)
        if "." not in lit and "e" not in lit and "inf" not in lit and "nan" not in lit:
            lit += ".0"
    elif isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        lit = f'"{escaped}".to_string()'
    else:
        return None
    return f"Some({lit})" if nullable else lit


def default_expr(model_field, column) -> tuple[str | None, str]:
    """The Rust expression for the Python default of a field, and a note for the doc comment."""
    from pydantic_core import PydanticUndefined

    factory = model_field.default_factory
    if factory is not None:
        try:
            a, b = factory(), factory()
        except Exception as exc:  # noqa: BLE001
            return None, f"default_factory raised {exc!r}"
        if isinstance(a, str) and a != b:
            wrap = (lambda e: f"Some({e})") if column.nullable else (lambda e: e)
            if UUID_RE.match(a):
                return wrap("kb_base::time::uuid4()"), "uuid4"
            if HEX_RE.match(a):
                return wrap("kb_base::time::uuid4_hex()"), "uuid4().hex"
            if ISO_RE.match(a):
                return wrap("kb_base::time::now_iso()"), "now"
            m = PREFIXED_RE.match(a)
            if m and PREFIXED_RE.match(b) and len(a) == len(b):
                return wrap(f'kb_base::time::prefixed_id("{m.group(1)}", {len(m.group(2))})'), "prefixed id"
            return None, f"default_factory gives a changing value like {a!r}"
        if isinstance(a, str) and ISO_RE.match(a):
            wrap = (lambda e: f"Some({e})") if column.nullable else (lambda e: e)
            return wrap("kb_base::time::now_iso()"), "now"
        lit = rust_literal(a, column)
        return lit, "" if lit else f"default_factory gives {a!r}"
    if model_field.default is PydanticUndefined:
        return None, "required"
    lit = rust_literal(model_field.default, column)
    return lit, "" if lit else f"default {model_field.default!r}"


def field_comments(cls) -> dict[str, list[str]]:
    """The `#` comments written above (or after) each field of a model class."""
    out: dict[str, list[str]] = {}
    try:
        lines = inspect.getsource(cls).splitlines()
    except (OSError, TypeError):
        return out
    pending: list[str] = []
    for line in lines[1:]:
        stripped = line.strip()
        if stripped.startswith("#"):
            pending.append(stripped.lstrip("#").strip())
            continue
        m = re.match(r"^    ([a-z_][a-z0-9_]*)\s*:", line)
        if m:
            comment = list(pending)
            trailing = re.search(r"\s#\s?(.*)$", line)
            if trailing and "noqa" not in trailing.group(1):
                comment.append(trailing.group(1).strip())
            if comment:
                out[m.group(1)] = comment
        if stripped and not stripped.startswith("#"):
            pending = []
    return out


def doc_lines(text: str, indent: str) -> list[str]:
    out = []
    for line in inspect.cleandoc(text).splitlines():
        out.append(f"{indent}/// {line}".rstrip())
    return out


def table_classes() -> dict[str, type]:
    out = {}
    for name, obj in vars(models).items():
        if inspect.isclass(obj) and issubclass(obj, SQLModel) and getattr(obj, "__table__", None) is not None:
            out[obj.__table__.name] = obj
    return out


def generate() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.rs"):
        old.unlink()
    classes = table_classes()
    names = sorted(classes)
    missing_defaults = []
    for table_name in names:
        cls = classes[table_name]
        table = cls.__table__
        comments = field_comments(cls)
        pk = [c.name for c in table.primary_key.columns]
        lines = [
            f"//! `{table_name}` (Python model `{cls.__name__}`). Generated by `contract/gen_entities.py`.",
            "",
            "use sea_orm::ActiveValue::{NOTSET_IMPORT};",
            "use sea_orm::entity::prelude::*;",
            "use serde::{Deserialize, Serialize};",
            "",
        ]
        if cls.__doc__ and not cls.__doc__.startswith(cls.__name__ + "("):
            lines += doc_lines(cls.__doc__, "")
        lines += [
            "#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]",
            f'#[sea_orm(table_name = "{table_name}")]',
            "pub struct Model {",
        ]
        news = []
        for column in table.columns:
            name = column.name
            attrs = []
            if name in pk:
                auto = bool(column.autoincrement is True or (column.autoincrement == "auto" and len(pk) == 1 and isinstance(column.type, Integer)))
                attrs.append("primary_key" if auto else "primary_key, auto_increment = false")
            if name in RUST_KEYWORDS:
                attrs.append(f'column_name = "{name}"')
            for comment in comments.get(name, []):
                lines.append(f"    /// {comment}".rstrip())
            if attrs:
                lines.append(f"    #[sea_orm({', '.join(attrs)})]")
            if name in RUST_KEYWORDS:
                lines.append(f'    #[serde(rename = "{name}")]')
            lines.append(f"    pub {field_name(name)}: {rust_type(column)},")
            model_field = cls.model_fields.get(name)
            is_auto_pk = name in pk and "auto_increment = false" not in " ".join(attrs)
            if is_auto_pk:
                news.append((name, None, "the database numbers it"))
            elif model_field is None:
                news.append((name, None, "no model field"))
            else:
                expr, note = default_expr(model_field, column)
                news.append((name, expr, note))
                if expr is None and note != "required":
                    missing_defaults.append(f"{table_name}.{name}: {note}")
        lines += ["}", "", "#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]", "pub enum Relation {}", "", "impl ActiveModelBehavior for ActiveModel {}", ""]
        required = [n for n, e, note in news if e is None and note == "required"]
        lines.append(f"/// A new row with the defaults of the Python model `{cls.__name__}`.")
        if required:
            lines.append(f"/// Set before saving: {', '.join(f'`{n}`' for n in required)}.")
        lines += ["pub fn new() -> ActiveModel {", "    ActiveModel {"]
        for name, expr, note in news:
            if expr is None:
                lines.append(f"        {field_name(name)}: NotSet,")
            else:
                lines.append(f"        {field_name(name)}: Set({expr}),")
        lines += ["    }", "}", ""]
        text = "\n".join(lines)
        text = text.replace("{NOTSET_IMPORT}", "{NotSet, Set}" if ": NotSet," in text else "Set")
        (OUT / f"{table_name}.rs").write_text(text, encoding="utf-8")
    mod = [
        "//! One module per table, generated from the Python models by `contract/gen_entities.py`.",
        "//!",
        "//! Columns are what the database holds: times are ISO strings, lists and objects are JSON text. Links between",
        "//! tables are kept by the app, never enforced by the database (`PRAGMA foreign_keys` stays off).",
        "",
    ]
    mod += [f"pub mod {field_name(n)};" for n in names]
    mod += ["", "/// Every table of the app, in the order the Python metadata sorts them (parents before children)."]
    mod.append("pub const TABLES: &[&str] = &[")
    for t in SQLModel.metadata.sorted_tables:
        mod.append(f'    "{t.name}",')
    mod += ["];", ""]
    mod += [
        "/// A column of a table, as the Python metadata described it.",
        "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
        "pub struct ColumnMeta {",
        "    pub name: &'static str,",
        "    /// \"str\" | \"int\" | \"bigint\" | \"float\" | \"bool\".",
        "    pub kind: &'static str,",
        "    pub nullable: bool,",
        "    pub primary_key: bool,",
        "    /// A long text (LONGTEXT on MySQL); false for keys and indexed columns, which are VARCHAR(255) there.",
        "    pub long_text: bool,",
        "    /// The column this one points at (`table`, `column`); the database does not enforce it.",
        "    pub foreign_key: Option<(&'static str, &'static str)>,",
        "}",
        "",
        "/// A table: its columns in order.",
        "#[derive(Debug, Clone, Copy, PartialEq, Eq)]",
        "pub struct TableMeta {",
        "    pub name: &'static str,",
        "    pub columns: &'static [ColumnMeta],",
        "}",
        "",
        "impl TableMeta {",
        "    /// The column called `name`.",
        "    pub fn column(&self, name: &str) -> Option<&'static ColumnMeta> {",
        "        self.columns.iter().find(|c| c.name == name)",
        "    }",
        "}",
        "",
        "/// The table called `name`.",
        "pub fn table_meta(name: &str) -> Option<&'static TableMeta> {",
        "    META.iter().find(|t| t.name == name)",
        "}",
        "",
        "/// Every table with its columns, in the order of `TABLES` (parents before children).",
        "pub const META: &[TableMeta] = &[",
    ]
    for t in SQLModel.metadata.sorted_tables:
        mod.append("    TableMeta {")
        mod.append(f'        name: "{t.name}",')
        mod.append("        columns: &[")
        for c in t.columns:
            rt = rust_type(c).replace("Option<", "").replace(">", "")
            kind = {"String": "str", "i32": "int", "i64": "bigint", "f64": "float", "bool": "bool"}[rt]
            fks = sorted(c.foreign_keys, key=lambda f: f.target_fullname)
            fk = f'Some(("{fks[0].column.table.name}", "{fks[0].column.name}"))' if fks else "None"
            long_text = "true" if type(c.type).__name__ == "LongText" else "false"
            mod.append(
                f'            ColumnMeta {{ name: "{c.name}", kind: "{kind}", nullable: {str(bool(c.nullable)).lower()}, '
                f"primary_key: {str(bool(c.primary_key)).lower()}, long_text: {long_text}, foreign_key: {fk} }},"
            )
        mod.append("        ],")
        mod.append("    },")
    mod += ["];", ""]
    (OUT / "mod.rs").write_text("\n".join(mod), encoding="utf-8")
    print(f"{len(names)} entities written to {OUT}")
    for m in missing_defaults:
        print("no default generated:", m)


if __name__ == "__main__":
    generate()
