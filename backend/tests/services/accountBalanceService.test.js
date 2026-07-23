const {
  parseSchwabAccount,
  tradeNotional,
  equityPercents,
  openDayPlFromSchwabPositions,
  heatToStop,
  defaultHeatForPosition,
  DEFAULT_HEAT_FLOOR
} = require('../../src/services/accountBalanceService');

describe('parseSchwabAccount', () => {
  it('maps Schwab balances into a TOS-like strip', () => {
    const parsed = parseSchwabAccount({
      accountNumber: '12345119',
      type: 'MARGIN',
      currentBalances: {
        liquidationValue: 1046313.48,
        cashBalance: 788631.64,
        availableFunds: 904474.77,
        buyingPower: 2105636,
        dayTradingBuyingPower: 4187017,
        intradayBuyingPowerAmount: 3617899.08,
        longMarketValue: 257681.84,
        shortBalance: 0
      },
      initialBalances: {
        liquidationValue: 1055741.34,
        equity: 1055741.34
      }
    });

    expect(parsed.account).toBe('****5119');
    expect(parsed.netLiq).toBe(1046313.48);
    expect(parsed.sodNetLiq).toBe(1055741.34);
    expect(parsed.cash).toBe(788631.64);
    expect(parsed.intradayBuyingPower).toBe(3617899.08);
    expect(parsed.dayPl).toBeNull();
  });

  it('prefers aggregatedBalance Net Liq (includes futures, matches TOS)', () => {
    const parsed = parseSchwabAccount({
      aggregatedBalance: {
        currentLiquidationValue: 1062317.4,
        liquidationValue: 1062317.4,
        currentIntradayBuyingPowerAmount: 3660603.12
      },
      securitiesAccount: {
        accountNumber: '12345119',
        type: 'MARGIN',
        currentBalances: {
          liquidationValue: 1045423.59,
          cashBalance: 788631.64,
          availableFunds: 904365.98,
          buyingPower: 2105636,
          intradayBuyingPowerAmount: 3617463.92,
          longMarketValue: 256791.95,
          shortBalance: 0
        },
        initialBalances: {
          liquidationValue: 1055741.34,
          equity: 1055741.34
        }
      }
    });

    expect(parsed.netLiq).toBe(1062317.4);
    expect(parsed.securitiesNetLiq).toBe(1045423.59);
    expect(parsed._futuresNetLiqGap).toBe(16893.81);
    expect(parsed.sodNetLiq).toBe(1055741.34);
    expect(parsed.intradayBuyingPower).toBe(3660603.12);
  });
});

describe('openDayPlFromSchwabPositions', () => {
  const payload = [{
    securitiesAccount: {
      accountNumber: '12345119',
      positions: [
        {
          instrument: { symbol: 'SOXS', assetType: 'COLLECTIVE_INVESTMENT' },
          longQuantity: 1500,
          shortQuantity: 0,
          averagePrice: 52.3,
          marketValue: 81060,
          currentDayProfitLoss: 6796
        },
        {
          instrument: { symbol: 'BROS', assetType: 'EQUITY' },
          longQuantity: 300,
          shortQuantity: 0,
          averagePrice: 69.02,
          marketValue: 19851,
          currentDayProfitLoss: -692
        }
      ]
    }
  }];

  it('uses unrealized-from-avg for same-day opens, day P/L for overnight', () => {
    const overnight = new Set(['BROS']);
    const openDay = openDayPlFromSchwabPositions(payload, [], overnight);
    // SOXS: 81060 - 52.3*1500 = 2610; BROS overnight: -692
    expect(openDay).toBe(1918);
  });
});

describe('tradeNotional + equityPercents', () => {
  it('uses futures point value for notional', () => {
    const notional = tradeNotional({
      symbol: 'MNQU26',
      entry_price: 25000,
      quantity: 2,
      instrument_type: 'future',
      point_value: 2
    });
    expect(notional).toBe(100000);

    const pct = equityPercents(notional, 2000, 1000000);
    expect(pct.equity_used_pct).toBe(10);
    expect(pct.equity_pnl_pct).toBe(0.2);
  });

  it('defaults stock multiplier to 1', () => {
    expect(tradeNotional({
      symbol: 'AAPL',
      entry_price: 100,
      quantity: 10,
      instrument_type: 'stock'
    })).toBe(1000);
  });
});

describe('open heat helpers', () => {
  it('computes long/short dollars to stop from mark', () => {
    expect(heatToStop('long', 78.28, 76.83, 1000, 1)).toBe(1450);
    expect(heatToStop('short', 23, 24.5, 100, 1)).toBe(150);
    expect(heatToStop('long', 76, 76.83, 1000, 1)).toBe(0);
  });

  it('defaults unprotected heat to max($1500, half open profit) per position', () => {
    expect(defaultHeatForPosition(0)).toBe(DEFAULT_HEAT_FLOOR);
    expect(defaultHeatForPosition(-500)).toBe(DEFAULT_HEAT_FLOOR);
    expect(defaultHeatForPosition(4000)).toBe(2000);
  });
});
