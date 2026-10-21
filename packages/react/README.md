# @bugcapsule/react

React helpers for [`@bugcapsule/web`](../web):

* `useBugCapsuleAction(id, handler)`: semantic action (recorded, replayed by id).
* `useTrackedInput(id, { sensitive })`: ref callback for uncontrolled inputs.
* `useTrackedState(id, initial)`: controlled value recorded and replayable.
* `useBugCapsuleState(key, value, restore)`: component/store state in checkpoints.
* `<BugCapsuleErrorBoundary fallback>`: reports render errors.
* `<BugCapsuleCaptureButton>`: QA capture button (not rendered in production mode).
* `@bugcapsule/react/react-router`: `<BugCapsuleRouteListener />` records
  location changes with `push`/`pop`/`replace` (React Router 6.4+, tested with 7).
