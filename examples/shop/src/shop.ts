import { BugCapsule } from '@bugcapsule/web';

export const API = import.meta.env.VITE_SHOP_API_URL || 'http://127.0.0.1:4318';
const fixes = new Set((import.meta.env.VITE_BUGCAPSULE_DEMO_FIX ?? '').split(',').map((s: string) => s.trim()));
export const fixed = (bug: 'race' | 'discontinued' | 'legacy' | 'coupon') => fixes.has(bug);

export interface Price {
  amount: number;
  currency: string;
}
export interface CartItem {
  sku: string;
  name: string;
  qty: number;
  price: Price | null;
  discontinued?: boolean;
}
export interface Profile {
  name: string;
  tier: 'gold' | 'silver';
}
export interface Recommendation {
  sku: string;
  name: string;
  boost: Record<string, number>;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getProfile = () => json<Profile>('/api/profile');
export const getRecommendations = () => json<{ items: Recommendation[] }>('/api/recommendations');
export const getCart = () => json<{ cartId: string; items: CartItem[] }>('/api/cart');
export const checkout = (cartId: string) =>
  json<{ orderId: string }>('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cartId, timestamp: BugCapsule.now(), nonce: Math.random().toString(36).slice(2) }),
  });
export const getOrders = () => json<{ orders: { orderId: string; status: string }[] }>('/api/orders');

/** Bug 1 (data-dependent): a discontinued item has `price: null`. */
export function cartTotal(items: CartItem[], coupon: string): number {
  const subtotal = items.reduce((sum, item) => {
    if (fixed('discontinued') && item.price === null) return sum;
    return sum + item.price!.amount * item.qty;
  }, 0);
  const discount = coupon.trim().toUpperCase() === 'SAVE100' ? 10000 : 0;
  const total = subtotal - discount;
  // Wrong behaviour that does not throw becomes a checkable failure.
  BugCapsule.check('cart_total_non_negative', fixed('coupon') || total >= 0, `total ${total}`);
  return fixed('coupon') ? Math.max(0, total) : total;
}

/** v0.9 stored the cart as a list of SKU strings; v1 stores objects. */
export function simulateUpgradeFromV09(): void {
  localStorage.setItem('shop.cart.version', '0.9');
  localStorage.setItem('shop.cart', JSON.stringify(['A1', 'B2']));
}

export function saveCart(items: CartItem[]): void {
  localStorage.setItem('shop.cart.version', '1');
  localStorage.setItem('shop.cart', JSON.stringify(items.map((i) => ({ sku: i.sku, qty: i.qty }))));
}

/** Bug 3 (state-restoration-dependent): reading a v0.9 cart crashes. */
export function loadSavedCart(): { sku: string; qty: number }[] {
  const raw = localStorage.getItem('shop.cart');
  if (!raw) return [];
  const saved = JSON.parse(raw) as unknown[];
  if (fixed('legacy') && localStorage.getItem('shop.cart.version') !== '1') {
    return saved.map((s) => (typeof s === 'string' ? { sku: s, qty: 1 } : (s as { sku: string; qty: number })));
  }
  return (saved as { sku: string; qty: number }[]).map((item) => ({ sku: item.sku.toUpperCase(), qty: item.qty }));
}
