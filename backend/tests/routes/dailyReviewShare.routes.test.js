function routePaths(router) {
  return (router.stack || [])
    .map((layer) => layer?.route?.path)
    .filter((path) => typeof path === 'string');
}

function hasRoute(router, path, method) {
  return (router.stack || []).some((layer) => {
    const route = layer?.route;
    return route?.path === path && Boolean(route.methods?.[method]);
  });
}

describe('daily review share public routes', () => {
  test('exposes token-scoped day/trades/positions/chart endpoints without auth middleware in-stack', () => {
    const router = require('../../src/routes/dailyReviewShare.routes');
    const paths = routePaths(router);

    expect(paths).toEqual(expect.arrayContaining([
      '/:token',
      '/:token/day',
      '/:token/trades',
      '/:token/positions',
      '/:token/trades/:id/chart-data'
    ]));

    expect(hasRoute(router, '/:token/trades/:id/chart-data', 'get')).toBe(true);
  });

  test('chart-data route resolves the share token before serving chart data', () => {
    const router = require('../../src/routes/dailyReviewShare.routes');
    const layer = (router.stack || []).find(
      (entry) => entry?.route?.path === '/:token/trades/:id/chart-data'
    );

    expect(layer).toBeTruthy();
    // Express stacks middleware + handler on the route; the first handle must be
    // resolveDailyShareToken so unauthenticated guests get a real req.user.
    const handlers = layer.route.stack.map((s) => s.handle.name);
    expect(handlers[0]).toBe('resolveDailyShareToken');
    expect(handlers).toContain('getTradeChartData');
  });
});
