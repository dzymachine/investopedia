// Fake data in Plaid response shape, so `npm run demo` works without Plaid keys.
const ago = (asOf, days) => new Date(Date.parse(asOf) - days * 86_400_000).toISOString().slice(0, 10);

const sec = (id, ticker, name, type, price) =>
  ({ security_id: id, ticker_symbol: ticker, name, type, close_price: price, is_cash_equivalent: type === 'cash' });
const hold = (acct, id, quantity, price, cost_basis) =>
  ({ account_id: acct, security_id: id, quantity, institution_price: price, institution_value: quantity * price, cost_basis });
const buy = (acct, id, date, quantity, price) =>
  ({ account_id: acct, security_id: id, date, type: 'buy', quantity, price, amount: quantity * price, fees: 0 });
const sell = (acct, id, date, quantity, price) =>
  ({ account_id: acct, security_id: id, date, type: 'sell', quantity: -quantity, price, amount: -quantity * price, fees: 0 });

export function demoItems(asOf) {
  const start = ago(asOf, 730);
  return [
    {
      itemId: 'demo-schwab', institution: 'Charles Schwab', historyStart: start,
      holdings: {
        accounts: [
          { account_id: 'sch1', name: 'Individual Brokerage', mask: '4821' },
          { account_id: 'sch_roth', name: 'Roth IRA', mask: '7742', subtype: 'roth' },
        ],
        securities: [
          sec('vti', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 318.4),
          sec('aapl', 'AAPL', 'Apple Inc.', 'equity', 241.1),
          sec('msft', 'MSFT', 'Microsoft Corp.', 'equity', 446.3),
          sec('qqq', 'QQQ', 'Invesco QQQ Trust', 'etf', 512.8),
          sec('usd', 'CUR:USD', 'Cash', 'cash', 1),
        ],
        holdings: [
          hold('sch1', 'vti', 60, 318.4, 13200),
          hold('sch1', 'aapl', 40, 241.1, 7400),
          hold('sch1', 'msft', 12, 446.3, 5520),
          hold('sch1', 'usd', 3500, 1, 3500),
          hold('sch_roth', 'qqq', 18, 512.8, 7200),
          hold('sch_roth', 'usd', 350.55, 1, 350.55),
        ],
      },
      transactions: [
        buy('sch1', 'aapl', ago(asOf, 500), 25, 170),
        buy('sch1', 'aapl', ago(asOf, 300), 15, 210),
        buy('sch1', 'msft', ago(asOf, 340), 12, 460),
        buy('sch1', 'vti', ago(asOf, 600), 20, 215),
        sell('sch1', 'vti', ago(asOf, 40), 10, 305),
        buy('sch_roth', 'qqq', ago(asOf, 450), 18, 400),
      ],
    },
    {
      itemId: 'demo-robinhood', institution: 'Robinhood', historyStart: start,
      holdings: {
        accounts: [{ account_id: 'rh1', name: 'Robinhood Individual', mask: '0917' }],
        securities: [
          sec('nvda', 'NVDA', 'NVIDIA Corp.', 'equity', 178.9),
          sec('tsla', 'TSLA', 'Tesla, Inc.', 'equity', 262.5),
          sec('aapl', 'AAPL', 'Apple Inc.', 'equity', 241.1),
          sec('usd', 'CUR:USD', 'Cash', 'cash', 1),
        ],
        holdings: [
          hold('rh1', 'nvda', 50, 178.9, 5980),
          hold('rh1', 'tsla', 15, 262.5, 5100),
          hold('rh1', 'aapl', 5, 241.1, 1150),
          hold('rh1', 'usd', 360, 1, 360),
        ],
      },
      transactions: [
        buy('rh1', 'nvda', ago(asOf, 420), 30, 95),
        buy('rh1', 'nvda', ago(asOf, 290), 20, 120),
        buy('rh1', 'tsla', ago(asOf, 120), 15, 340),
        buy('rh1', 'aapl', ago(asOf, 200), 5, 230),
        sell('rh1', 'nvda', ago(asOf, 90), 10, 170),
        buy('rh1', 'nvda', ago(asOf, 89), 10, 168),
      ],
    },
    {
      itemId: 'demo-kraken', institution: 'Kraken', historyStart: start,
      holdings: {
        accounts: [{ account_id: 'kr1', name: 'Kraken Spot', mask: null }],
        securities: [
          sec('btc', 'BTC', 'Bitcoin', 'cryptocurrency', 96350),
          sec('eth', 'ETH', 'Ethereum', 'cryptocurrency', 3410),
          sec('sol', 'SOL', 'Solana', 'cryptocurrency', 182),
        ],
        holdings: [
          hold('kr1', 'btc', 0.185, 96350, 9900),
          hold('kr1', 'eth', 2.4, 3410, 8600),
          hold('kr1', 'sol', 30, 182, 4300),
        ],
      },
      transactions: [
        buy('kr1', 'btc', ago(asOf, 380), 0.1, 58000),
        buy('kr1', 'btc', ago(asOf, 330), 0.085, 48235),
        buy('kr1', 'eth', ago(asOf, 250), 2.9, 3583),
        buy('kr1', 'sol', ago(asOf, 30), 30, 143.3),
        sell('kr1', 'eth', ago(asOf, 150), 0.5, 3900),
      ],
    },
    {
      itemId: 'demo-guideline', institution: 'Guideline', historyStart: start,
      holdings: {
        accounts: [{ account_id: 'gl1', name: '401(k)', mask: '2210', subtype: '401k' }],
        securities: [
          sec('tdf', null, 'Vanguard Target Retirement 2060 Fund', 'mutual fund', 52.4),
          sec('sp', null, 'S&P 500 Index Fund', 'mutual fund', 118.2),
        ],
        holdings: [
          hold('gl1', 'tdf', 210, 52.4, 9450),
          hold('gl1', 'sp', 60, 118.2, 5880),
        ],
      },
      transactions: [
        buy('gl1', 'tdf', ago(asOf, 400), 210, 45),
        buy('gl1', 'sp', ago(asOf, 380), 75, 98),
        sell('gl1', 'sp', ago(asOf, 60), 15, 115),
      ],
    },
  ];
}
