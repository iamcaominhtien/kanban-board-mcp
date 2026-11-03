"""Adding a router's routes without building them a second time."""

from fastapi import APIRouter, FastAPI
from fastapi.datastructures import DefaultPlaceholder
from fastapi.routing import APIRoute, APIWebSocketRoute, request_response


def _changes_routes(target: APIRouter) -> bool:
    """Whether ``target.include_router()`` would change the routes it takes in."""
    return bool(
        target.prefix
        or target.tags
        or target.dependencies
        or target.responses
        or target.callbacks
        or target.deprecated
        or not target.include_in_schema
        or not isinstance(target.default_response_class, DefaultPlaceholder)
        or not isinstance(target.generate_unique_id_function, DefaultPlaceholder)
    )


def _has_lifecycle(router: APIRouter) -> bool:
    """Whether the router has startup/shutdown work that ``include_router()`` would carry over."""
    return bool(
        router.on_startup
        or router.on_shutdown
        or type(router.lifespan_context).__name__ != "_DefaultLifespan"
    )


def add_routes(target: FastAPI | APIRouter, router: APIRouter) -> None:
    """Add ``router``'s routes to ``target`` as they are, the same as ``target.include_router(router)``.

    ``include_router()`` builds every route again: FastAPI analyses the endpoint's signature once more
    and pydantic rebuilds the schemas of its parameters and response. For the ~660 routes of the app
    that took about 0.65 s of every start. When the target adds no prefix, tags, dependencies or other
    settings, the routes the router already built are the final ones and are added directly, except
    for the target's dependency-override provider (below). Anything else goes through
    ``include_router()``.
    """
    target_router = target.router if isinstance(target, FastAPI) else target
    if (
        _changes_routes(target_router)
        or _has_lifecycle(router)
        # include_router() refuses an empty path; keep that check
        or any(not getattr(route, "path", "/") for route in router.routes)
    ):
        target.include_router(router)
        return
    provider = target_router.dependency_overrides_provider
    for route in router.routes:
        if isinstance(route, APIWebSocketRoute):
            # few of them: built again, the way include_router() does
            target_router.add_api_websocket_route(
                route.path,
                route.endpoint,
                name=route.name,
                dependencies=route.dependencies,
            )
            continue
        if (
            isinstance(route, APIRoute)
            and route.dependency_overrides_provider is not provider
        ):
            # The handler looks up app.dependency_overrides through the provider it was made with
            # (none for a route built in an APIRouter). Making the handler again is cheap: the
            # signature analysis and schemas stay as they are.
            route.dependency_overrides_provider = provider
            route.app = request_response(route.get_route_handler())
        target_router.routes.append(route)
