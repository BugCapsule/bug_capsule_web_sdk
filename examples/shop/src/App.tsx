import { BugCapsule } from '@bugcapsule/web';
import { BugCapsuleCaptureButton, BugCapsuleErrorBoundary, useBugCapsuleAction, useBugCapsuleState, useTrackedState } from '@bugcapsule/react';
import { BugCapsuleRouteListener } from '@bugcapsule/react/react-router';
import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import {
  cartTotal,
  checkout,
  fixed,
  getCart,
  getOrders,
  getProfile,
  getRecommendations,
  saveCart,
  simulateUpgradeFromV09,
  type CartItem,
  type Profile,
  type Recommendation,
} from './shop';

export function App() {
  return (
    <BrowserRouter>
      <BugCapsuleRouteListener />
      <header style={{ display: 'flex', gap: 16, padding: 12, borderBottom: '1px solid #ddd' }}>
        <strong>BugCapsule Shop</strong>
        <Link to="/">Home</Link>
        <Link to="/cart" data-testid="nav-cart">Cart</Link>
        <Link to="/orders">Orders</Link>
        <span style={{ flex: 1 }} />
        <BugCapsuleCaptureButton />
      </header>
      <main style={{ padding: 16 }}>
        <BugCapsuleErrorBoundary fallback={(e, reset) => <ErrorView error={e} reset={reset} />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/orders" element={<Orders />} />
          </Routes>
        </BugCapsuleErrorBoundary>
      </main>
    </BrowserRouter>
  );
}

function ErrorView({ error, reset }: { error: unknown; reset: () => void }) {
  return (
    <div role="alert">
      <p>Something went wrong: {String((error as Error)?.message ?? error)}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}

function Home() {
  const [picks, setPicks] = useState<{ name: string; score: number }[]>([]);
  const [status, setStatus] = useState('');

  // Bug 2 (timing-sensitive): recommendations are scored with the profile's
  // tier, which is only set if the profile response arrives first.
  const refresh = useBugCapsuleAction('home.refreshPicks', async () => {
    setStatus('Loading…');
    let profile: Profile | null = null;
    const profileRequest = getProfile().then((p) => (profile = p));
    const recs = getRecommendations().then(async ({ items }: { items: Recommendation[] }) => {
      if (fixed('race')) await profileRequest;
      return items.map((r) => ({ name: r.name, score: r.boost[profile!.tier] ?? 0 }));
    });
    const [, scored] = await Promise.all([profileRequest, recs]);
    setPicks(scored);
    setStatus(`Picks for ${(profile as Profile | null)?.name ?? 'you'}`);
  });

  return (
    <section>
      <h1>Home</h1>
      <p>
        <button data-bugcapsule-action="home.refreshPicks" onClick={() => void refresh()}>
          Refresh picks
        </button>{' '}
        <button data-testid="upgrade" onClick={useBugCapsuleAction('home.simulateUpgrade', () => { simulateUpgradeFromV09(); setStatus('Saved a v0.9 cart. Reload the page.'); })}>
          Simulate upgrade from v0.9
        </button>
      </p>
      <p data-testid="status">{status}</p>
      <ul>{picks.map((p) => <li key={p.name}>{p.name} ({p.score})</li>)}</ul>
    </section>
  );
}

function Cart() {
  const [cart, setCart] = useState<{ cartId: string; items: CartItem[] } | null>(null);
  const [coupon, setCoupon] = useTrackedState('cart.coupon', '');
  const [result, setResult] = useState('');
  useBugCapsuleState('cart', cart, setCart);

  useEffect(() => {
    let live = true;
    getCart().then((c) => {
      if (!live) return;
      setCart(c);
      saveCart(c.items);
    });
    return () => {
      live = false;
    };
  }, []);

  const applyCoupon = useBugCapsuleAction('cart.applyCoupon', () => {
    if (!cart) return;
    setResult(`Total: $${(cartTotal(cart.items, coupon) / 100).toFixed(2)}`);
  });
  const placeOrder = useBugCapsuleAction('cart.checkout', async () => {
    if (!cart) return;
    const total = cartTotal(cart.items, coupon);
    const order = await checkout(cart.cartId);
    setResult(`Order ${order.orderId} placed ($${(total / 100).toFixed(2)})`);
    BugCapsule.log(`order placed ${order.orderId}`);
  });

  if (!cart) return <p>Loading cart…</p>;
  return (
    <section>
      <h1>Cart</h1>
      <ul>
        {cart.items.map((i) => (
          <li key={i.sku}>
            {i.name} × {i.qty} — {i.price ? `$${(i.price.amount / 100).toFixed(2)}` : <em>unavailable</em>}
          </li>
        ))}
      </ul>
      <label>
        Coupon <input data-testid="coupon" value={coupon} onChange={(e) => setCoupon(e.target.value)} />
      </label>{' '}
      <button data-bugcapsule-action="cart.applyCoupon" onClick={applyCoupon}>Apply</button>{' '}
      <button data-bugcapsule-action="cart.checkout" onClick={() => void placeOrder()}>Checkout</button>
      <p data-testid="result">{result}</p>
      <label>
        Card number <input type="password" autoComplete="off" data-testid="card" />
      </label>
    </section>
  );
}

function Orders() {
  const [orders, setOrders] = useState<{ orderId: string; status: string }[] | null>(null);
  useEffect(() => {
    void getOrders().then((o) => setOrders(o.orders));
  }, []);
  return (
    <section>
      <h1>My orders</h1>
      {orders === null ? <p>Loading…</p> : orders.length === 0 ? <p>No orders yet.</p> : <ul>{orders.map((o) => <li key={o.orderId}>{o.orderId}: {o.status}</li>)}</ul>}
    </section>
  );
}
