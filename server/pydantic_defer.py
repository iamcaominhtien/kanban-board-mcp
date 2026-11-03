"""Build pydantic schemas on first use instead of at class creation, to make the server start faster.

Import this before anything that defines a pydantic model (main.py and mcp_stdio.py import it first).
Every model class normally builds its validator and serializer when the class is created: ours,
SQLModel's, FastAPI's OpenAPI models and the MCP SDK's types. Each route also builds a TypeAdapter
per parameter and response. Most of these are not needed to answer the first request (the OpenAPI
models only for /openapi.json), and building them all took about 0.5 s of every start. With
``defer_build`` each is built the first time it validates or serializes.

``BaseModel.model_config`` is the config every model class inherits, so this reaches the models of
the libraries too. Models created before this module is imported are left as they are.
"""

import warnings

import pydantic
from pydantic.warnings import UnsupportedFieldAttributeWarning

pydantic.BaseModel.model_config["defer_build"] = True

# FastAPI builds a TypeAdapter for each route parameter from its FieldInfo (alias and all), which
# pydantic >= 2.12 warns about, so FastAPI silences this warning around the build
# (fastapi/_compat/v2.py, ModelField.__post_init__). Deferred, the build happens at the route's
# first request, outside that silencing, and the warning would land in the log once per route.
warnings.filterwarnings("ignore", category=UnsupportedFieldAttributeWarning)
