"""add_routes() gives the app the same routes as include_router(), without building them twice."""

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute

import main
from api.routing import add_routes


def _route_key(route, app: FastAPI) -> tuple:
    if not isinstance(route, APIRoute):
        return (
            type(route).__name__,
            route.path,
            getattr(route, "name", None),
            getattr(route, "endpoint", None),
        )
    return (
        route.path,
        tuple(sorted(route.methods)),
        route.name,
        route.unique_id,
        tuple(route.tags),
        route.response_model,
        route.status_code,
        route.include_in_schema,
        route.response_class,
        len(route.dependencies),
        route.deprecated,
        route.dependency_overrides_provider is app,
    )


def test_the_app_has_the_routes_include_router_would_give():
    reference = FastAPI()
    for router in main.ROUTERS:
        reference.include_router(router)

    endpoints = {route.endpoint for router in main.ROUTERS for route in router.routes}
    added = [
        route
        for route in main.app.routes
        if getattr(route, "endpoint", None) in endpoints
    ]

    assert [_route_key(r, main.app) for r in added] == [
        _route_key(r, reference)
        for r in reference.router.routes[len(FastAPI().routes) :]
    ]
    assert len(added) == sum(len(router.routes) for router in main.ROUTERS)


def test_docs_ai_routes_have_their_tag_once():
    docs_ai = [
        r for r in main.app.routes if isinstance(r, APIRoute) and "docs-ai" in r.tags
    ]
    assert docs_ai
    assert all(r.tags == ["docs-ai"] for r in docs_ai)


def _router() -> APIRouter:
    router = APIRouter(tags=["things"])

    @router.get("/things")
    def things() -> list[str]:
        return []

    return router


async def test_dependency_overrides_reach_added_routes():
    """app.dependency_overrides (how tests swap the database) applies to added routes."""
    import httpx
    from fastapi import Depends

    def real() -> str:
        return "real"

    router = APIRouter()

    @router.get("/who")
    def who(name: str = Depends(real)) -> str:
        return name

    app = FastAPI()
    add_routes(app, router)
    app.dependency_overrides[real] = lambda: "override"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/who")).json() == "override"


def test_routes_are_added_as_built():
    app = FastAPI()
    router = _router()
    add_routes(app, router)
    assert app.routes[-1] is router.routes[0]


def test_a_target_that_changes_routes_goes_through_include_router():
    target = APIRouter(prefix="/api")
    router = _router()
    add_routes(target, router)
    assert target.routes[0] is not router.routes[0]
    assert target.routes[0].path == "/api/things"


def test_a_router_with_startup_work_goes_through_include_router():
    app = FastAPI()
    router = _router()
    started = []
    router.add_event_handler("startup", lambda: started.append(True))
    add_routes(app, router)
    assert app.routes[-1] is not router.routes[0]
    assert app.router.on_startup
