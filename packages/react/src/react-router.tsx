import { BugCapsule } from '@bugcapsule/web';
import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * React Router integration: records every location change with its
 * navigation type (`push`, `pop`, `replace`) as a `route` event with source
 * `react_router`. Render it once inside the router:
 *
 * ```tsx
 * <BrowserRouter><BugCapsuleRouteListener /><Routes>…</Routes></BrowserRouter>
 * ```
 *
 * Combine with `historyIntegration()` for checkpoints (the current location
 * is restored before the app renders); duplicate locations are recorded once.
 */
export function BugCapsuleRouteListener(): null {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    BugCapsule.route(`${location.pathname}${location.search}${location.hash}`, 'react_router', type.toLowerCase());
  }, [location.pathname, location.search, location.hash, type]);
  return null;
}
