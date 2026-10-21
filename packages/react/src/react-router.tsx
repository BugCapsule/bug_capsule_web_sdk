import { BugCapsule } from '@bugcapsule/web';
import { useEffect } from 'react';
import { matchRoutes, useLocation, useNavigationType, type RouteObject } from 'react-router';

/** `/shop` + `product/:id` → `/shop/product/:id`: the route pattern of the matched branch. */
export function routePattern(matches: { route: { path?: string } }[] | null): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  const joined = matches
    .map((m) => m.route.path ?? '')
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
  return joined ? (joined.startsWith('/') ? joined : `/${joined}`) : '/';
}

/**
 * React Router integration: records every location change with its
 * navigation type (`push`, `pop`, `replace`) as a `route` event with source
 * `react_router`, and names pageload/navigation transactions after the
 * matched route pattern (`/product/:id`) when `routes` is given (otherwise
 * id-like path segments are replaced by `:id`). Render it once inside the
 * router:
 *
 * ```tsx
 * <BrowserRouter><BugCapsuleRouteListener routes={routes} /><Routes>…</Routes></BrowserRouter>
 * ```
 *
 * Combine with `historyIntegration()` for checkpoints (the current location
 * is restored before the app renders); duplicate locations are recorded once.
 */
export function BugCapsuleRouteListener(props: { routes?: RouteObject[] } = {}): null {
  const location = useLocation();
  const type = useNavigationType();
  const { routes } = props;
  useEffect(() => {
    let name: string | undefined;
    if (routes) {
      try {
        name = routePattern(matchRoutes(routes, location));
      } catch {
        name = undefined;
      }
    }
    BugCapsule.route(`${location.pathname}${location.search}${location.hash}`, 'react_router', type.toLowerCase(), name);
  }, [location.pathname, location.search, location.hash, type, routes]);
  return null;
}
