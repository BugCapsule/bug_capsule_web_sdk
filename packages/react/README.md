# @bugcapsule/react

React hooks and components for [`@bugcapsule/web`](https://www.npmjs.com/package/@bugcapsule/web).

```bash
npm install @bugcapsule/web@beta @bugcapsule/react@beta   # same version for both
```

Requires React 18+. The React Router listener needs React Router 6.4+.
Setup guide: [docs.bugcapsule.com/web](https://docs.bugcapsule.com/web.html).

```tsx
import { BugCapsuleErrorBoundary, BugCapsuleCaptureButton } from '@bugcapsule/react';
import { BugCapsuleRouteListener } from '@bugcapsule/react/react-router';

<BrowserRouter>
  <BugCapsuleRouteListener />
  <BugCapsuleErrorBoundary fallback={<Oops />}><Routes>…</Routes></BugCapsuleErrorBoundary>
  <BugCapsuleCaptureButton />
</BrowserRouter>
```

## API


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
