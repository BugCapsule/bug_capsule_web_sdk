# @bugcapsule/react

React helpers for [`@bugcapsule/web`](../web):

* `useBugCapsuleAction(id, handler)`: semantic action (recorded, replayed by id).
* `useTrackedInput(id, { sensitive })`: ref callback for uncontrolled inputs.
* `useTrackedState(id, initial)`: controlled value recorded and replayable.
* `useBugCapsuleState(key, value, restore)`: component/store state in checkpoints.
* `<BugCapsuleErrorBoundary fallback onError>`: reports render errors as a
  failure (capsule) and a handled error event with
  `contexts.react.componentStack`; `fallback(error, reset, eventId)`.
* `reactErrorHandler('uncaught' | 'caught' | 'recoverable')`: React 19 root
  callbacks (`createRoot(el, { onUncaughtError: reactErrorHandler() })`).
* `<BugCapsuleFeedbackWidget theme={…} />` / `useFeedbackWidget(options)`: the
  opt-in user feedback widget while mounted.
* `<BugCapsuleCaptureButton>`: QA capture button (not rendered in production mode).
* `@bugcapsule/react/react-router`: `<BugCapsuleRouteListener routes={routes} />` records
  location changes with `push`/`pop`/`replace` (React Router 6.4+, tested with 7)
  and names pageload/navigation transactions after the matched route pattern
  (`/product/:id`; without `routes`, id-like segments become `:id`).
