import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchRoutes } from 'react-router';
import { routePattern } from '../../packages/react/src/react-router.js';

describe('routePattern', () => {
  it('joins the matched branch into the route pattern', () => {
    const routes = [{ path: '/' }, { path: '/shop', children: [{ index: true }, { path: 'product/:productId' }] }, { path: '*' }];
    assert.equal(routePattern(matchRoutes(routes, '/shop/product/42')), '/shop/product/:productId');
    assert.equal(routePattern(matchRoutes(routes, '/shop')), '/shop');
    assert.equal(routePattern(matchRoutes(routes, '/')), '/');
    assert.equal(routePattern(matchRoutes(routes, '/nope/123')), '/*');
    assert.equal(routePattern(null), undefined);
  });
});
