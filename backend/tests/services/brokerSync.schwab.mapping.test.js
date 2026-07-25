/**
 * Regression coverage for the Schwab API-payload -> TradeTally trade mapping layer.
 *
 * Pins the behavior of:
 *  - parseTransactionDetails (single transaction -> normalized fill)
 *  - parseTransactions / matchTransactions / groupTrades (fills -> complete trades)
 *  - _parseSchwabOptionSymbol (OCC-style option symbol parsing)
 *  - isDuplicateTrade dedupe key construction (exit orderId|datetime)
 */

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

jest.mock('../../src/models/Trade', () => ({
  create: jest.fn()
}));

jest.mock('../../src/models/BrokerConnection', () => ({
  updateSyncLog: jest.fn(),
  updateSchwabTokens: jest.fn(),
  updateStatus: jest.fn()
}));

jest.mock('../../src/services/analyticsCache', () => ({
  invalidateUserCache: jest.fn(),
  invalidate: jest.fn()
}));

jest.mock('../../src/utils/cache', () => ({
  data: {},
  del: jest.fn()
}));

jest.mock('../../src/config/database', () => ({
  query: jest.fn()
}));

const schwabService = require('../../src/services/brokerSync/schwabService');

/**
 * Builds a realistic Schwab /transactions payload entry.
 * Shape mirrors what parseTransactionDetails consumes: type, transferItems with
 * an instrument item plus fee items, orderId/activityId, time + tradeDate.
 */
function schwabEquityTx({
  orderId,
  time,
  tradeDate,
  symbol = 'AAPL',
  cusip = '037833100',
  price,
  amount,
  positionEffect,
  netAmount,
  commissionCost = 0,
  feeItems = [],
  accountIdentifier = '****1234'
}) {
  const transferItems = [
    {
      instrument: { assetType: 'EQUITY', symbol, cusip },
      price,
      amount,
      cost: -(price * amount),
      positionEffect
    }
  ];
  if (commissionCost) {
    transferItems.push({
      instrument: { assetType: 'CURRENCY', symbol: 'USD' },
      feeType: 'COMMISSION',
      cost: -Math.abs(commissionCost)
    });
  }
  for (const fee of feeItems) {
    transferItems.push({
      instrument: { assetType: 'CURRENCY', symbol: 'USD' },
      feeType: fee.feeType,
      cost: -Math.abs(fee.cost)
    });
  }

  return {
    activityId: Number(String(orderId).replace(/\D/g, '') || 1),
    type: 'TRADE',
    status: 'VALID',
    orderId,
    time,
    tradeDate: tradeDate || time,
    netAmount,
    _accountIdentifier: accountIdentifier,
    transferItems
  };
}

function schwabOptionTx({
  orderId,
  time,
  symbol,
  putCall,
  strikePrice,
  expirationDate,
  underlyingSymbol,
  price,
  amount,
  positionEffect,
  netAmount,
  commissionCost = 0,
  accountIdentifier = '****1234'
}) {
  const instrument = { assetType: 'OPTION', symbol };
  if (putCall !== undefined) instrument.putCall = putCall;
  if (strikePrice !== undefined) instrument.strikePrice = strikePrice;
  if (expirationDate !== undefined) instrument.expirationDate = expirationDate;
  if (underlyingSymbol !== undefined) instrument.underlyingSymbol = underlyingSymbol;

  const transferItems = [
    { instrument, price, amount, positionEffect }
  ];
  if (commissionCost) {
    transferItems.push({
      instrument: { assetType: 'CURRENCY', symbol: 'USD' },
      feeType: 'COMMISSION',
      cost: -Math.abs(commissionCost)
    });
  }

  return {
    type: 'TRADE',
    orderId,
    time,
    tradeDate: time,
    netAmount,
    _accountIdentifier: accountIdentifier,
    transferItems
  };
}

describe('Schwab parseTransactionDetails (single transaction mapping)', () => {
  test('maps an equity buy (OPENING, positive amount) field-by-field', () => {
    const parsed = schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 1006200000001,
      time: '2026-03-06T14:30:05Z',
      tradeDate: '2026-03-06T14:30:05+0000',
      symbol: 'AAPL',
      price: 100.25,
      amount: 10,
      positionEffect: 'OPENING',
      netAmount: -1004.04,
      commissionCost: 1.5,
      feeItems: [{ feeType: 'SEC_FEE', cost: 0.04 }]
    }));

    expect(parsed).toEqual({
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      signedQuantity: 10,
      price: 100.25,
      time: '2026-03-06T14:30:05Z',
      matchingSymbol: 'AAPL',
      positionEffect: 'OPENING',
      commission: 1.5,
      fees: 0.04,
      netAmount: -1004.04,
      instrumentType: 'stock',
      optionType: null,
      strikePrice: null,
      expirationDate: null,
      underlyingSymbol: null,
      pointValue: null,
      contractMonth: null,
      contractYear: null,
      underlyingAsset: null,
      cusip: '037833100',
      orderId: '1006200000001',
      accountIdentifier: '****1234'
    });
  });

  test('fill-net reconcile drops futures opens when stream is flat', () => {
    const fills = [
      {
        accountIdentifier: '****5119',
        matchingSymbol: 'MNQU26',
        symbol: 'MNQU26',
        instrumentType: 'future',
        signedQuantity: 3
      },
      {
        accountIdentifier: '****5119',
        matchingSymbol: 'MNQU26',
        symbol: 'MNQU26',
        instrumentType: 'future',
        signedQuantity: -3
      }
    ];
    const trades = [
      {
        symbol: 'MNQU26',
        matchingSymbol: 'MNQU26',
        accountIdentifier: '****5119',
        instrumentType: 'future',
        side: 'long',
        quantity: 3,
        entryPrice: 28995.75,
        exitPrice: null,
        entryTime: '2026-07-20T14:26:05+0000',
        exitTime: null
      },
      {
        symbol: 'MNQU26',
        matchingSymbol: 'MNQU26',
        accountIdentifier: '****5119',
        instrumentType: 'future',
        side: 'long',
        quantity: 3,
        entryPrice: 28900,
        exitPrice: 28950,
        entryTime: '2026-07-20T13:00:00+0000',
        exitTime: '2026-07-20T14:00:00+0000'
      }
    ];

    const reconciled = schwabService.reconcileOpenFuturesWithFillNet(trades, fills);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].exitPrice).toBe(28950);
  });

  test('fill-net map only includes futures symbols from the fill stream', () => {
    const map = schwabService.buildFillNetPositionMap([
      {
        accountIdentifier: '****5119',
        matchingSymbol: 'MNQU26',
        instrumentType: 'future',
        signedQuantity: 3
      },
      {
        accountIdentifier: '****5119',
        matchingSymbol: 'MNQU26',
        instrumentType: 'future',
        signedQuantity: -3
      },
      {
        accountIdentifier: '****5119',
        matchingSymbol: 'AAPL',
        instrumentType: 'stock',
        signedQuantity: 10
      }
    ]);
    expect(map.get('****5119|MNQU26')).toBe(0);
    expect(map.has('****5119|AAPL')).toBe(false);
  });

  test('maps a short-sale entry (OPENING, negative amount) to side short with absolute quantity', () => {
    const parsed = schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 1006200000010,
      time: '2026-03-06T15:10:00Z',
      symbol: 'TSLA',
      price: 200,
      amount: -50,
      positionEffect: 'OPENING',
      netAmount: 10000
    }));

    expect(parsed).toMatchObject({
      symbol: 'TSLA',
      side: 'short',
      quantity: 50,
      price: 200,
      positionEffect: 'OPENING'
    });
  });

  test('sums multiple non-commission fee items separately from commission', () => {
    const parsed = schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 1006200000011,
      time: '2026-03-06T15:20:00Z',
      price: 10,
      amount: 100,
      positionEffect: 'OPENING',
      commissionCost: 0.65,
      feeItems: [
        { feeType: 'SEC_FEE', cost: 0.02 },
        { feeType: 'TAF_FEE', cost: 0.01 }
      ]
    }));

    expect(parsed.commission).toBeCloseTo(0.65, 10);
    expect(parsed.fees).toBeCloseTo(0.03, 10);
  });

  test('maps option fields from the instrument when Schwab provides them', () => {
    const parsed = schwabService.parseTransactionDetails(schwabOptionTx({
      orderId: 'opt-open-1',
      time: '2026-06-01T14:35:00Z',
      symbol: 'SPY   260618C00500000',
      putCall: 'CALL',
      strikePrice: 500,
      expirationDate: '2026-06-18',
      underlyingSymbol: 'SPY',
      price: 3.5,
      amount: 2,
      positionEffect: 'OPENING'
    }));

    expect(parsed).toMatchObject({
      symbol: 'SPY',
      matchingSymbol: 'SPY 260618C00500000',
      side: 'long',
      quantity: 2,
      price: 3.5,
      instrumentType: 'option',
      optionType: 'call',
      strikePrice: 500,
      expirationDate: '2026-06-18',
      underlyingSymbol: 'SPY'
    });
  });

  test('normalizes lowercase/padded underlying symbols from the instrument', () => {
    const parsed = schwabService.parseTransactionDetails(schwabOptionTx({
      orderId: 'opt-open-case',
      time: '2026-06-01T14:35:00Z',
      symbol: 'MRVL  260220P00065000',
      putCall: 'PUT',
      strikePrice: 65,
      expirationDate: '2026-02-20',
      underlyingSymbol: ' mrvl ',
      price: 1.5,
      amount: 1,
      positionEffect: 'OPENING'
    }));

    expect(parsed.underlyingSymbol).toBe('MRVL');
    expect(parsed.symbol).toBe('MRVL');
  });

  test('falls back to OCC symbol parsing when instrument lacks option metadata', () => {
    const parsed = schwabService.parseTransactionDetails(schwabOptionTx({
      orderId: 'opt-open-2',
      time: '2026-01-05T16:00:00Z',
      symbol: 'TSLA  260116P00200500',
      price: 4.1,
      amount: 1,
      positionEffect: 'OPENING'
    }));

    expect(parsed).toMatchObject({
      symbol: 'TSLA',
      instrumentType: 'option',
      optionType: 'put',
      strikePrice: 200.5,
      expirationDate: '2026-01-16',
      underlyingSymbol: 'TSLA'
    });
  });

  test('returns null for non-TRADE types, fee-only items, currency symbols, and zero price/amount', () => {
    expect(schwabService.parseTransactionDetails({
      type: 'DIVIDEND_OR_INTEREST',
      transferItems: [{ instrument: { assetType: 'EQUITY', symbol: 'AAPL' }, price: 1, amount: 1 }]
    })).toBeNull();

    expect(schwabService.parseTransactionDetails({
      type: 'TRADE',
      transferItems: [{ instrument: { assetType: 'CURRENCY', symbol: 'USD' }, feeType: 'COMMISSION', cost: -1 }]
    })).toBeNull();

    expect(schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 'x', time: '2026-03-06T15:00:00Z', symbol: 'USD', price: 1, amount: 1, positionEffect: 'OPENING'
    }))).toBeNull();

    expect(schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 'x', time: '2026-03-06T15:00:00Z', price: 0, amount: 10, positionEffect: 'OPENING'
    }))).toBeNull();

    expect(schwabService.parseTransactionDetails(schwabEquityTx({
      orderId: 'x', time: '2026-03-06T15:00:00Z', price: 10, amount: 0, positionEffect: 'OPENING'
    }))).toBeNull();
  });

  test('falls back to tradeDate when time is missing, preferring whichever has intraday precision', () => {
    const tx = schwabEquityTx({
      orderId: 'no-time-1',
      time: undefined,
      tradeDate: '2026-03-06T14:45:30+0000',
      price: 10,
      amount: 5,
      positionEffect: 'OPENING'
    });
    delete tx.time;

    const parsed = schwabService.parseTransactionDetails(tx);
    expect(parsed.time).toBe('2026-03-06T14:45:30+0000');
  });

  test('picks FUTURE leg even when CURRENCY cash legs come first without feeType', () => {
    // Mirrors live Schwab TOS futures payloads: several CURRENCY rows precede the contract.
    const parsed = schwabService.parseTransactionDetails({
      type: 'TRADE',
      orderId: 9001,
      time: '2026-07-20T14:30:00+0000',
      tradeDate: '2026-07-20T04:00:00+0000',
      netAmount: -75177.72,
      _accountIdentifier: '****5119',
      transferItems: [
        {
          instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' },
          feeType: 'COMMISSION',
          amount: 4.5,
          cost: -4.5
        },
        {
          instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' },
          amount: 0,
          cost: 0
        },
        {
          instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' },
          feeType: 'FUTURES_EXCHANGE_FEE',
          amount: 0.7,
          cost: -0.7
        },
        {
          instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' },
          amount: 0.02,
          cost: -0.02
        },
        {
          instrument: {
            assetType: 'FUTURE',
            symbol: '/MESU26:XCME',
            description: 'Micro E-mini S&P 500 Stock Price Index Futures, Sep-26'
          },
          amount: 2,
          price: 7517.25,
          cost: -75172.5,
          positionEffect: 'OPENING'
        }
      ]
    });

    expect(parsed).not.toBeNull();
    expect(parsed.instrumentType).toBe('future');
    expect(parsed.symbol).toBe('MESU26');
    expect(parsed.matchingSymbol).toBe('MESU26');
    expect(parsed.underlyingSymbol).toBe('MES');
    expect(parsed.underlyingAsset).toBe('MES');
    expect(parsed.contractMonth).toBe('09');
    expect(parsed.contractYear).toBe(2026);
    expect(parsed.pointValue).toBe(5);
    expect(parsed.quantity).toBe(2);
    expect(parsed.price).toBe(7517.25);
    expect(parsed.side).toBe('long');
    expect(parsed.commission).toBe(4.5);
    expect(parsed.fees).toBe(0.7);
  });
});

describe('Schwab futures matching', () => {
  test('matches MES open/close with futures point-value P&L', () => {
    const openTx = {
      type: 'TRADE',
      orderId: 9001,
      time: '2026-07-20T14:30:00+0000',
      netAmount: -37586,
      _accountIdentifier: '****5119',
      transferItems: [
        { instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, amount: 0, cost: 0 },
        {
          instrument: { assetType: 'FUTURE', symbol: '/MESU26:XCME' },
          amount: 1,
          price: 7500,
          positionEffect: 'OPENING'
        }
      ]
    };
    const closeTx = {
      type: 'TRADE',
      orderId: 9002,
      time: '2026-07-20T15:00:00+0000',
      netAmount: 37550,
      _accountIdentifier: '****5119',
      transferItems: [
        { instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, amount: 0, cost: 0 },
        {
          instrument: { assetType: 'FUTURE', symbol: '/MESU26:XCME' },
          amount: -1,
          price: 7510,
          positionEffect: 'CLOSING'
        }
      ]
    };

    const trades = schwabService.parseTransactions([openTx, closeTx]);
    const futures = trades.filter(t => t.instrumentType === 'future');
    expect(futures).toHaveLength(1);
    expect(futures[0].symbol).toBe('MESU26');
    expect(futures[0].quantity).toBe(1);
    expect(futures[0].entryPrice).toBe(7500);
    expect(futures[0].exitPrice).toBe(7510);
    // MES point value $5: (7510-7500) * 1 * 5 = 50
    expect(futures[0].pnl).toBe(50);
  });
});

describe('Schwab parseTransactions (full payload -> trades)', () => {
  test('stock round trip: buy then sell produces one long trade with exact fields', () => {
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 1006200000001,
        time: '2026-03-06T14:30:05Z',
        symbol: 'AAPL',
        price: 100.25,
        amount: 10,
        positionEffect: 'OPENING',
        netAmount: -1004.04,
        commissionCost: 1.5,
        feeItems: [{ feeType: 'SEC_FEE', cost: 0.04 }]
      }),
      schwabEquityTx({
        orderId: 1006200000002,
        time: '2026-03-06T19:45:30Z',
        symbol: 'AAPL',
        price: 103.75,
        amount: -10,
        positionEffect: 'CLOSING',
        netAmount: 1035.94,
        commissionCost: 1.5,
        feeItems: [{ feeType: 'SEC_FEE', cost: 0.06 }]
      })
    ]);

    expect(trades).toHaveLength(1);
    const trade = trades[0];

    expect(trade.symbol).toBe('AAPL');
    expect(trade.side).toBe('long');
    expect(trade.quantity).toBe(10);
    expect(trade.entryPrice).toBe(100.25);
    expect(trade.exitPrice).toBe(103.75);
    // Times and tradeDate are taken from the payload strings verbatim - no timezone shift.
    expect(trade.entryTime).toBe('2026-03-06T14:30:05Z');
    expect(trade.exitTime).toBe('2026-03-06T19:45:30Z');
    expect(trade.tradeDate).toBe('2026-03-06');
    expect(trade.commission).toBe(3); // 1.50 entry + 1.50 exit
    expect(trade.fees).toBeCloseTo(0.1, 10); // 0.04 entry + 0.06 exit
    expect(trade.pnl).toBe(35); // (103.75 - 100.25) * 10
    expect(trade.broker).toBe('schwab');
    expect(trade.instrumentType).toBe('stock');
    expect(trade.optionType).toBeNull();
    expect(trade.strikePrice).toBeNull();
    expect(trade.expirationDate).toBeNull();
    expect(trade.cusip).toBe('037833100');
    expect(trade.accountIdentifier).toBe('****1234');

    expect(trade.executionData).toEqual([
      {
        datetime: '2026-03-06T14:30:05Z',
        price: 100.25,
        quantity: 10,
        side: 'long',
        type: 'entry',
        orderId: '1006200000001'
      },
      {
        datetime: '2026-03-06T19:45:30Z',
        price: 103.75,
        quantity: 10,
        side: 'short', // CLOSING with negative amount maps to a sell-direction execution
        type: 'exit',
        orderId: '1006200000002'
      }
    ]);
  });

  test('does not FIFO-match closes across different Schwab accounts', () => {
    // Regression: multi-account sync concatenated all fills and matched by
    // symbol only, so a taxable sell could close IRA lots (and leave false
    // open remnants on the taxable account).
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 1006400000001,
        time: '2026-07-13T14:41:45Z',
        symbol: 'LABU',
        price: 270.95,
        amount: 200,
        positionEffect: 'OPENING',
        accountIdentifier: '****5119'
      }),
      schwabEquityTx({
        orderId: 1006400000002,
        time: '2026-07-01T15:00:00Z',
        symbol: 'LABU',
        price: 180,
        amount: 50,
        positionEffect: 'OPENING',
        accountIdentifier: '****7790'
      }),
      // Sell in IRA should close the IRA lot only — not the taxable buy
      schwabEquityTx({
        orderId: 1006400000003,
        time: '2026-07-16T14:32:03Z',
        symbol: 'LABU',
        price: 263.705,
        amount: -200,
        positionEffect: 'CLOSING',
        accountIdentifier: '****7790'
      })
    ]);

    const taxable = trades.filter(t => t.accountIdentifier === '****5119');
    const ira = trades.filter(t => t.accountIdentifier === '****7790');

    expect(taxable).toHaveLength(1);
    expect(taxable[0].quantity).toBe(200);
    expect(taxable[0].exitPrice).toBeNull();
    expect(taxable[0].exitTime).toBeNull();

    const iraClosed = ira.filter(t => t.exitPrice != null);
    const iraOpen = ira.filter(t => t.exitPrice == null);
    // 50 matched to the IRA open lot + 150 orphan close (opened before window)
    expect(iraClosed.reduce((sum, t) => sum + t.quantity, 0)).toBe(200);
    expect(iraClosed.some(t => t.entryPrice != null && t.quantity === 50)).toBe(true);
    expect(iraClosed.some(t => t.entryPrice == null && t.quantity === 150)).toBe(true);
    // Remaining IRA sell must NOT close the taxable account's open lot.
    expect(iraOpen).toHaveLength(0);
    expect(iraClosed.every(t => t.accountIdentifier === '****7790')).toBe(true);
  });

  test('same-day open remainder is not merged into the closed group', () => {
    // Regression: group key used exit-date for closes and entry-date for opens.
    // On a same-day partial exit those dates match, so leftover qty was absorbed
    // into a "closed" trade with entry qty > exit qty.
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 1007175248272,
        time: '2026-07-14T18:26:34Z',
        symbol: 'ETHU',
        price: 15.8761,
        amount: 100,
        positionEffect: 'OPENING',
        accountIdentifier: '****5119'
      }),
      schwabEquityTx({
        orderId: 1007191418168,
        time: '2026-07-14T20:00:00Z',
        symbol: 'ETHU',
        price: 16.465,
        amount: -72,
        positionEffect: 'CLOSING',
        accountIdentifier: '****5119'
      })
    ]);

    const closed = trades.filter(t => t.exitPrice != null);
    const open = trades.filter(t => t.exitPrice == null);

    expect(closed).toHaveLength(1);
    expect(closed[0].quantity).toBe(72);
    expect(closed[0].entryPrice).toBeCloseTo(15.8761, 4);
    expect(closed[0].exitPrice).toBeCloseTo(16.465, 4);

    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(28);
    expect(open[0].exitPrice).toBeNull();
    expect(open[0].exitTime).toBeNull();
  });

  test('buildBrokerEquityPositionMap includes ETF COLLECTIVE_INVESTMENT holdings', () => {
    const map = schwabService.buildBrokerEquityPositionMap([
      {
        securitiesAccount: {
          accountNumber: '88197790',
          positions: [
            {
              instrument: { symbol: 'TQQQ', assetType: 'COLLECTIVE_INVESTMENT', type: 'EXCHANGE_TRADED_FUND' },
              longQuantity: 900,
              shortQuantity: 0,
              averagePrice: 65.98
            },
            {
              instrument: { symbol: 'SPY   260618C00500000', assetType: 'OPTION' },
              longQuantity: 1,
              shortQuantity: 0
            }
          ]
        }
      }
    ]);

    expect([...map.keys()]).toEqual(['****7790|TQQQ']);
    expect(map.get('****7790|TQQQ')).toMatchObject({ quantity: 900, side: 'long' });
  });

  test('reconcileOpenTradesWithBrokerPositions drops phantom equity opens when broker is flat', () => {
    const trades = [
      {
        symbol: 'ETHU',
        side: 'long',
        quantity: 28,
        entryPrice: 15.8761,
        exitPrice: null,
        entryTime: '2026-07-14T18:26:34Z',
        exitTime: null,
        tradeDate: '2026-07-14',
        instrumentType: 'stock',
        accountIdentifier: '****5119',
        executionData: [{ type: 'entry', quantity: 28, price: 15.8761, datetime: '2026-07-14T18:26:34Z' }]
      },
      {
        symbol: 'BROS',
        side: 'long',
        quantity: 250,
        entryPrice: 68.65,
        exitPrice: null,
        entryTime: '2026-07-17T14:00:00Z',
        exitTime: null,
        tradeDate: '2026-07-17',
        instrumentType: 'stock',
        accountIdentifier: '****5119',
        executionData: [{ type: 'entry', quantity: 250, price: 68.65, datetime: '2026-07-17T14:00:00Z' }]
      }
    ];

    const brokerPositions = new Map([
      ['****5119|BROS', { symbol: 'BROS', accountIdentifier: '****5119', quantity: 250, side: 'long', averagePrice: 68.65 }]
    ]);

    const reconciled = schwabService.reconcileOpenTradesWithBrokerPositions(trades, brokerPositions);
    expect(reconciled.find(t => t.symbol === 'ETHU')).toBeUndefined();
    expect(reconciled.find(t => t.symbol === 'BROS')).toMatchObject({ quantity: 250, exitPrice: null });
  });

  test('reconcileOpenTradesWithBrokerPositions trims oldest open lots down to broker qty', () => {
    const trades = [
      {
        symbol: 'MSCI',
        side: 'long',
        quantity: 25,
        entryPrice: 634,
        exitPrice: null,
        entryTime: '2026-07-16T14:00:00Z',
        exitTime: null,
        instrumentType: 'stock',
        accountIdentifier: '****5119',
        commission: 1,
        executionData: [{ type: 'entry', quantity: 25, price: 634 }]
      },
      {
        symbol: 'MSCI',
        side: 'long',
        quantity: 10,
        entryPrice: 640,
        exitPrice: null,
        entryTime: '2026-07-17T14:00:00Z',
        exitTime: null,
        instrumentType: 'stock',
        accountIdentifier: '****5119',
        commission: 0.4,
        executionData: [{ type: 'entry', quantity: 10, price: 640 }]
      }
    ];

    const brokerPositions = new Map([
      ['****5119|MSCI', { symbol: 'MSCI', accountIdentifier: '****5119', quantity: 30, side: 'long', averagePrice: 635 }]
    ]);

    const reconciled = schwabService.reconcileOpenTradesWithBrokerPositions(trades, brokerPositions);
    const opens = reconciled.filter(t => t.symbol === 'MSCI');
    expect(opens.reduce((sum, t) => sum + t.quantity, 0)).toBe(30);
    // Oldest 25-lot trimmed to 20; newer 10-lot kept
    expect(opens).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: 20, entryPrice: 634 }),
      expect.objectContaining({ quantity: 10, entryPrice: 640 })
    ]));
  });

  test('partial exits split the entry commission pro rata without double counting', () => {
    // Regression: the entry commission was prorated against the lot's
    // REMAINING quantity without being consumed, so a 50/50 split of a
    // 100-share lot ($1.00 entry commission) attributed $0.50 + $1.00 = $1.50.
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 1006300000001,
        time: '2026-03-09T14:30:00Z',
        symbol: 'AAPL',
        price: 100,
        amount: 100,
        positionEffect: 'OPENING',
        netAmount: -10001,
        commissionCost: 1.0
      }),
      schwabEquityTx({
        orderId: 1006300000002,
        time: '2026-03-10T15:00:00Z',
        symbol: 'AAPL',
        price: 101,
        amount: -50,
        positionEffect: 'CLOSING',
        netAmount: 5050
      }),
      schwabEquityTx({
        orderId: 1006300000003,
        time: '2026-03-11T15:00:00Z',
        symbol: 'AAPL',
        price: 102,
        amount: -50,
        positionEffect: 'CLOSING',
        netAmount: 5100
      })
    ]);

    const closedTrades = trades.filter(t => t.exitPrice != null);
    expect(closedTrades).toHaveLength(2);
    expect(closedTrades[0].commission).toBeCloseTo(0.5, 10);
    expect(closedTrades[1].commission).toBeCloseTo(0.5, 10);
    const totalEntryCommission = closedTrades.reduce((sum, t) => sum + t.commission, 0);
    expect(totalEntryCommission).toBeCloseTo(1.0, 10);
  });

  test('short round trip: sell-to-open then buy-to-cover produces one short trade with inverted P&L', () => {
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 'short-open-1',
        time: '2026-03-09T14:00:00Z',
        symbol: 'TSLA',
        price: 200,
        amount: -50,
        positionEffect: 'OPENING',
        netAmount: 10000
      }),
      schwabEquityTx({
        orderId: 'short-close-1',
        time: '2026-03-09T18:30:00Z',
        symbol: 'TSLA',
        price: 195.5,
        amount: 50,
        positionEffect: 'CLOSING',
        netAmount: -9775
      })
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: 'TSLA',
      side: 'short',
      quantity: 50,
      entryPrice: 200,
      exitPrice: 195.5,
      entryTime: '2026-03-09T14:00:00Z',
      exitTime: '2026-03-09T18:30:00Z',
      tradeDate: '2026-03-09',
      pnl: 225 // short: -(195.50 - 200) * 50
    });
  });

  test('option round trip: 100x contract multiplier and option metadata carried onto the trade', () => {
    const trades = schwabService.parseTransactions([
      schwabOptionTx({
        orderId: 'opt-open-1',
        time: '2026-06-01T14:35:00Z',
        symbol: 'SPY   260618C00500000',
        putCall: 'CALL',
        strikePrice: 500,
        expirationDate: '2026-06-18',
        underlyingSymbol: 'SPY',
        price: 3.5,
        amount: 2,
        positionEffect: 'OPENING',
        netAmount: -701.3,
        commissionCost: 1.3
      }),
      schwabOptionTx({
        orderId: 'opt-close-1',
        time: '2026-06-01T19:10:00Z',
        symbol: 'SPY   260618C00500000',
        putCall: 'CALL',
        strikePrice: 500,
        expirationDate: '2026-06-18',
        underlyingSymbol: 'SPY',
        price: 4.25,
        amount: -2,
        positionEffect: 'CLOSING',
        netAmount: 848.7,
        commissionCost: 1.3
      })
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: 'SPY', // trade symbol is the underlying ticker
      side: 'long',
      quantity: 2,
      entryPrice: 3.5,
      exitPrice: 4.25,
      entryTime: '2026-06-01T14:35:00Z',
      exitTime: '2026-06-01T19:10:00Z',
      tradeDate: '2026-06-01',
      commission: 2.6,
      pnl: 150, // (4.25 - 3.50) * 2 contracts * 100
      instrumentType: 'option',
      optionType: 'call',
      strikePrice: 500,
      expirationDate: '2026-06-18',
      underlyingSymbol: 'SPY',
      accountIdentifier: '****1234'
    });
  });

  test('tradeDate is the exit timestamp date string verbatim, even just after midnight UTC', () => {
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 'late-open',
        time: '2026-07-03T20:00:00Z',
        symbol: 'AMD',
        price: 150,
        amount: 10,
        positionEffect: 'OPENING'
      }),
      schwabEquityTx({
        orderId: 'late-close',
        time: '2026-07-04T01:30:00Z',
        symbol: 'AMD',
        price: 151,
        amount: -10,
        positionEffect: 'CLOSING'
      })
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0].tradeDate).toBe('2026-07-04');
    expect(trades[0].entryTime).toBe('2026-07-03T20:00:00Z');
    expect(trades[0].exitTime).toBe('2026-07-04T01:30:00Z');
  });

  test('closing transaction with no open position becomes a trade with null entry and netAmount P&L', () => {
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 'orphan-close',
        time: '2026-03-10T15:00:00Z',
        symbol: 'NVDA',
        price: 900,
        amount: -5,
        positionEffect: 'CLOSING',
        netAmount: 4500
      })
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: 'NVDA',
      quantity: 5,
      entryPrice: null,
      exitPrice: 900,
      entryTime: null,
      exitTime: '2026-03-10T15:00:00Z',
      tradeDate: '2026-03-10',
      pnl: 4500
    });
  });

  test('unclosed opening transaction maps to an open trade with null exit fields', () => {
    const trades = schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 'still-open',
        time: '2026-03-11T14:31:00Z',
        symbol: 'MSFT',
        price: 410,
        amount: 25,
        positionEffect: 'OPENING',
        commissionCost: 1
      })
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: 'MSFT',
      side: 'long',
      quantity: 25,
      entryPrice: 410,
      exitPrice: null,
      entryTime: '2026-03-11T14:31:00Z',
      exitTime: null,
      tradeDate: '2026-03-11',
      commission: 1,
      // groupTrades coerces the open trade's null P&L to 0 (totalPnL starts at 0
      // and 0 !== null); pinning current behavior.
      pnl: 0
    });
  });
});

describe('Schwab option symbol parsing', () => {
  test('_parseSchwabOptionSymbol decodes underlying, expiration, type, and strike exactly', () => {
    expect(schwabService._parseSchwabOptionSymbol('SPY   260618C00500000')).toEqual({
      underlyingSymbol: 'SPY',
      expirationDate: '2026-06-18',
      optionType: 'call',
      strikePrice: 500,
      contractSize: 100
    });

    expect(schwabService._parseSchwabOptionSymbol('TSLA  260116P00200500')).toEqual({
      underlyingSymbol: 'TSLA',
      expirationDate: '2026-01-16',
      optionType: 'put',
      strikePrice: 200.5,
      contractSize: 100
    });

    expect(schwabService._parseSchwabOptionSymbol('AAPL')).toBeNull();
    expect(schwabService._parseSchwabOptionSymbol('SPY 261332C00500000')).toBeNull(); // month 13 invalid
  });
});

describe('Schwab dedupe key construction (exit orderId|datetime)', () => {
  function buildRoundTripTrade() {
    return schwabService.parseTransactions([
      schwabEquityTx({
        orderId: 1006200000001,
        time: '2026-03-06T14:30:05Z',
        symbol: 'AAPL',
        price: 100.25,
        amount: 10,
        positionEffect: 'OPENING'
      }),
      schwabEquityTx({
        orderId: 1006200000002,
        time: '2026-03-06T19:45:30Z',
        symbol: 'AAPL',
        price: 103.75,
        amount: -10,
        positionEffect: 'CLOSING'
      })
    ])[0];
  }

  function asExistingRow(trade) {
    return {
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      entry_time: trade.entryTime,
      exit_time: trade.exitTime,
      trade_date: trade.tradeDate,
      pnl: trade.pnl,
      instrument_type: trade.instrumentType,
      account_identifier: trade.accountIdentifier,
      executions: trade.executionData
    };
  }

  test('same input produces a stable dedupe decision (re-sync of identical payload is a duplicate)', () => {
    const trade = buildRoundTripTrade();
    const existing = [asExistingRow(buildRoundTripTrade())];

    expect(schwabService.isDuplicateTrade(trade, existing)).toBe(true);
    // Stability: same input evaluated again yields the same result
    expect(schwabService.isDuplicateTrade(trade, existing)).toBe(true);
  });

  test('a different fill (new exit orderId/datetime, different qty and price) is NOT a duplicate', () => {
    // Partial-exit scenario: buy 15, sell 5 (already imported), then sell 10 later.
    // The second exit shares the entry order but has a distinct exit order ID.
    const existing = [{
      symbol: 'AAPL',
      side: 'long',
      quantity: 5,
      entry_price: 100,
      exit_price: 105,
      entry_time: '2026-03-06T14:30:00Z',
      exit_time: '2026-03-06T15:00:00Z',
      trade_date: '2026-03-06',
      pnl: 25,
      instrument_type: 'stock',
      account_identifier: '****1234',
      executions: [
        { datetime: '2026-03-06T14:30:00Z', price: 100, quantity: 5, side: 'long', type: 'entry', orderId: 'entry-1' },
        { datetime: '2026-03-06T15:00:00Z', price: 105, quantity: 5, side: 'short', type: 'exit', orderId: 'exit-1' }
      ]
    }];

    const laterPartialExit = {
      symbol: 'AAPL',
      side: 'long',
      quantity: 10,
      entryPrice: 100,
      exitPrice: 106,
      entryTime: '2026-03-06T14:30:00Z',
      exitTime: '2026-03-06T16:30:00Z',
      tradeDate: '2026-03-06',
      pnl: 60,
      instrumentType: 'stock',
      accountIdentifier: '****1234',
      executionData: [
        { datetime: '2026-03-06T14:30:00Z', price: 100, quantity: 10, side: 'long', type: 'entry', orderId: 'entry-1' },
        { datetime: '2026-03-06T16:30:00Z', price: 106, quantity: 10, side: 'short', type: 'exit', orderId: 'exit-2' }
      ]
    };

    expect(schwabService.isDuplicateTrade(laterPartialExit, existing)).toBe(false);
  });

  test('same exit orderId at a different datetime is NOT matched (key includes both parts)', () => {
    const trade = buildRoundTripTrade();
    const shiftedExisting = asExistingRow(buildRoundTripTrade());
    // Same order ID, but different exit timestamp, quantity, prices, and P&L
    shiftedExisting.executions[1].datetime = '2026-03-06T19:59:59Z';
    shiftedExisting.exit_time = '2026-03-06T19:59:59Z';
    shiftedExisting.quantity = 7;
    shiftedExisting.entry_price = 95;
    shiftedExisting.exit_price = 99;
    shiftedExisting.pnl = 28;

    expect(schwabService.isDuplicateTrade(trade, shiftedExisting ? [shiftedExisting] : [])).toBe(false);
  });

  test('trades in different accounts are not considered duplicates of each other', () => {
    const trade = buildRoundTripTrade();
    const otherAccount = asExistingRow(buildRoundTripTrade());
    otherAccount.account_identifier = '****9999';

    expect(schwabService.isDuplicateTrade(trade, [otherAccount])).toBe(false);
  });

  test('a closed trade is NOT a duplicate of a same-entry open lot (stale open must be upgradeable)', () => {
    const closed = buildRoundTripTrade();
    const openExisting = asExistingRow(closed);
    openExisting.id = 'open-trade-id';
    openExisting.exit_price = null;
    openExisting.exit_time = null;
    openExisting.pnl = null;
    openExisting.executions = closed.executionData.filter(e => e.type === 'entry');

    expect(schwabService.isDuplicateTrade(closed, [openExisting])).toBe(false);
    expect(schwabService.findUpgradeableOpenTrade(closed, [openExisting])).toEqual(
      expect.objectContaining({ id: 'open-trade-id' })
    );
  });

  test('a full close is NOT a duplicate of an earlier partial-close import that shares some exit fills', () => {
    const partial = {
      symbol: 'MRK',
      side: 'long',
      quantity: 300,
      entry_price: 126.73,
      exit_price: 126.49,
      trade_date: '2026-07-20',
      instrument_type: 'stock',
      account_identifier: '****5119',
      executions: [
        { type: 'entry', orderId: 'entry-1', datetime: '2026-07-20T14:50:06Z', price: 126.73, quantity: 300 },
        { type: 'exit', orderId: 'exit-1', datetime: '2026-07-20T14:59:54Z', price: 126.59, quantity: 150 },
        { type: 'exit', orderId: 'exit-2', datetime: '2026-07-20T15:00:13Z', price: 126.39, quantity: 150 }
      ]
    };
    const fullClose = {
      symbol: 'MRK',
      side: 'long',
      quantity: 500,
      entryPrice: 126.73,
      exitPrice: 126.2862,
      tradeDate: '2026-07-20',
      instrumentType: 'stock',
      accountIdentifier: '****5119',
      executionData: [
        { type: 'entry', orderId: 'entry-1', datetime: '2026-07-20T14:50:06Z', price: 126.73, quantity: 500 },
        { type: 'exit', orderId: 'exit-1', datetime: '2026-07-20T14:59:54Z', price: 126.59, quantity: 150 },
        { type: 'exit', orderId: 'exit-2', datetime: '2026-07-20T15:00:13Z', price: 126.39, quantity: 150 },
        { type: 'exit', orderId: 'exit-3', datetime: '2026-07-20T15:03:17Z', price: 125.98, quantity: 200 }
      ]
    };

    expect(schwabService.isDuplicateTrade(fullClose, [partial])).toBe(false);
  });
});

describe('Schwab broker-position trust assessment', () => {
  const db = require('../../src/config/database');
  const Trade = require('../../src/models/Trade');

  beforeEach(() => {
    db.query.mockReset();
    Trade.delete = jest.fn();
  });

  const account = (last4, extra) => ({
    securitiesAccount: Object.assign({ accountNumber: `1234${last4}` }, extra)
  });

  // Schwab omits `positions` for an account holding nothing. That is a real
  // empty book, so reconciling must be allowed or phantoms never get cleared.
  it('treats omitted positions + zero market value as flat and usable', () => {
    const payload = [
      account('5119', { currentBalances: { longMarketValue: 0, shortMarketValue: 0, equity: 1028759.92 } })
    ];
    const result = schwabService.assessBrokerPositions(payload, []);
    expect(result.usable).toBe(true);
    expect(result.flat).toBe(true);
  });

  // But omitting positions while still holding value means data was withheld;
  // acting on that empty map would delete every real open position.
  it('refuses a payload that omits positions while holding market value', () => {
    const payload = [
      account('5119', { currentBalances: { longMarketValue: 38385, shortMarketValue: 0 } })
    ];
    const result = schwabService.assessBrokerPositions(payload, []);
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/non-zero market value/);
  });

  it('is usable when positions are present', () => {
    const payload = [
      account('5119', { positions: [{ instrument: { symbol: 'COPX', assetType: 'COLLECTIVE_INVESTMENT' }, longQuantity: 500 }] })
    ];
    const result = schwabService.assessBrokerPositions(payload, []);
    expect(result.usable).toBe(true);
    expect(result.flat).toBe(false);
  });

  // An excluded account's payload shape must not veto reconciling synced ones.
  it('ignores excluded accounts when assessing trust', () => {
    const payload = [
      account('7790', { currentBalances: { longMarketValue: 99999, shortMarketValue: 0 } }),
      account('5119', { positions: [] })
    ];
    expect(schwabService.assessBrokerPositions(payload, ['7790']).usable).toBe(true);
    expect(schwabService.assessBrokerPositions(payload, []).usable).toBe(false);
  });

  it('refuses to delete persisted opens on an empty map unless flatness is confirmed', async () => {
    const summary = await schwabService.reconcilePersistedOpenEquity(
      'user-1', 'conn-1', new Map(), ['****5119']
    );
    expect(summary.deleted).toHaveLength(0);
    expect(db.query).not.toHaveBeenCalled();
    expect(Trade.delete).not.toHaveBeenCalled();
  });

  it('does clear persisted opens on an empty map when flatness is confirmed', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 't1', symbol: 'COPX', side: 'long', quantity: '500', entry_time: '2026-07-21T13:30:00Z', account_identifier: '****5119' }
    ] });
    const summary = await schwabService.reconcilePersistedOpenEquity(
      'user-1', 'conn-1', new Map(), ['****5119'], { allowEmpty: true }
    );
    expect(summary.deleted).toHaveLength(1);
    expect(Trade.delete).toHaveBeenCalledWith('t1', 'user-1');
  });
});

describe('Schwab corporate-action / transfer handling', () => {
  const rnd = (symbol, amount, assetType = 'EQUITY', account = '****5119') => ({
    type: 'RECEIVE_AND_DELIVER',
    _accountIdentifier: account,
    tradeDate: '2026-04-30T14:00:00+0000',
    transferItems: [{ instrument: { symbol, assetType }, amount, price: 0 }]
  });

  // Schwab books a share-class/registration move as an offsetting pair on the
  // same symbol. Booking each leg would invent a close and a re-open.
  it('nets offsetting same-symbol legs to nothing', () => {
    const adj = schwabService.buildTransferAdjustments([
      rnd('ARMG', -1337), rnd('ARMG', 1337)
    ]);
    expect(adj.size).toBe(0);
  });

  it('keeps the residual of an unpaired removal', () => {
    const adj = schwabService.buildTransferAdjustments([rnd('OPENW', -172)]);
    expect(adj.get('****5119|OPENW')).toBe(-172);
  });

  it('nets a reverse split down to its true delta', () => {
    // DUST 10:1 reverse split: 6142 old shares out, 614 new shares in.
    const adj = schwabService.buildTransferAdjustments([
      rnd('DUST', -6142, 'COLLECTIVE_INVESTMENT'), rnd('DUST', 614, 'COLLECTIVE_INVESTMENT')
    ]);
    expect(adj.get('****5119|DUST')).toBe(-5528);
  });

  it('ignores CURRENCY legs (cash, not shares)', () => {
    const adj = schwabService.buildTransferAdjustments([
      rnd('CURRENCY_USD', -13171.2, 'CURRENCY')
    ]);
    expect(adj.size).toBe(0);
  });

  it('keys residuals per account so accounts cannot bleed into each other', () => {
    const adj = schwabService.buildTransferAdjustments([
      rnd('OPENW', -172, 'EQUITY', '****5119'),
      rnd('OPENW', 172, 'EQUITY', '****7790')
    ]);
    expect(adj.get('****5119|OPENW')).toBe(-172);
    expect(adj.get('****7790|OPENW')).toBe(172);
  });

  const openTrade = (symbol, quantity, entryTime, account = '****5119') => ({
    symbol, quantity, side: 'long', instrumentType: 'stock',
    entryPrice: 10, exitPrice: null, entryTime, exitTime: null,
    accountIdentifier: account, executionData: [{ type: 'entry', quantity }]
  });

  it('drops open lots that a corporate action removed, oldest first', () => {
    const trades = [
      openTrade('OPENW', 100, '2026-01-01T14:30:00Z'),
      openTrade('OPENW', 72, '2026-02-01T14:30:00Z')
    ];
    const adj = new Map([['****5119|OPENW', -172]]);
    const result = schwabService.applyTransferAdjustmentsToOpens(trades, adj);
    expect(result).toHaveLength(0);
  });

  it('trims the boundary lot on a partial removal', () => {
    const trades = [openTrade('OPENW', 100, '2026-01-01T14:30:00Z')];
    const adj = new Map([['****5119|OPENW', -40]]);
    const result = schwabService.applyTransferAdjustmentsToOpens(trades, adj);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(60);
  });

  // Shares arriving have price 0 in the payload; inventing a basis would corrupt P&L.
  it('never fabricates opens from positive residuals', () => {
    const trades = [openTrade('DUST', 614, '2026-03-05T14:30:00Z')];
    const adj = new Map([['****5119|DUST', 614]]);
    const result = schwabService.applyTransferAdjustmentsToOpens(trades, adj);
    expect(result).toHaveLength(1);
    expect(result[0].quantity).toBe(614);
  });

  it('leaves closed trades and non-equity instruments alone', () => {
    const closed = { ...openTrade('OPENW', 100, '2026-01-01T14:30:00Z'), exitPrice: 12, exitTime: '2026-01-05T14:30:00Z' };
    const future = { ...openTrade('/MESZ5', 2, '2026-01-01T14:30:00Z'), instrumentType: 'future' };
    const adj = new Map([['****5119|OPENW', -100], ['****5119|/MESZ5', -2]]);
    const result = schwabService.applyTransferAdjustmentsToOpens([closed, future], adj);
    expect(result).toHaveLength(2);
  });
});
