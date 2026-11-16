# Investment Dashboard

A local dashboard for your Charles Schwab, Robinhood and Kraken accounts, with Plaid as the data layer. It shows:

- Total value, cash, cost basis, and unrealized gain or loss
- Allocation by account and by asset type
- Holdings combined across accounts, with return and weight
- Tax view: gains realized this year and last year, estimated tax, what you'd owe if you sold everything today, and the date each lot becomes long-term
- "Turning long-term soon": lots with a gain that hit the lower long-term rate within 120 days, and how much tax you save by waiting

## Try it with fake data

```sh
npm install
npm run demo        # http://localhost:3000
```

## Connect your real accounts

1. Create a Plaid account at https://dashboard.plaid.com and copy your `client_id` and secret.
2. `cp .env.example .env` and fill in `PLAID_CLIENT_ID`, `PLAID_SECRET`, and your tax rates.
3. Start with `PLAID_ENV=sandbox` and link a test institution (username `user_good`, password `pass_good`) to check the flow works.
4. For your real accounts, request Production access for the **Investments** product in the Plaid dashboard. Then set `PLAID_ENV=production` and use your production secret.
5. `npm start`, open http://localhost:3000, and click **Add account** for each brokerage.

Before linking, check that Plaid supports an institution for Investments:
`curl 'localhost:3000/api/institutions?q=kraken'`. An empty list means Plaid can't link it.

## How the tax numbers work

- Plaid gives current holdings with total cost basis, plus up to 24 months of buys and sells.
- Lots are rebuilt first-in, first-out from that history. Shares older than the history window are grouped into one lot marked "before <date>". That lot is treated as long-term, and its cost is the broker's cost basis minus the cost of the lots that were rebuilt.
- Long-term means held more than one year. A lot becomes long-term the day after its one-year anniversary.
- Estimated tax nets short-term and long-term gains and losses, then applies `SHORT_TERM_TAX_RATE` and `LONG_TERM_TAX_RATE` from `.env`.

What it doesn't handle: wash sales, stock splits, transfers between brokers (shares moved from another broker show up as older lots), specific-lot selling, the $3,000 loss deduction, and loss carryovers. These are estimates, not tax advice. Your 1099-B is the source of truth.

## Security

- The server only listens on `127.0.0.1` and rejects requests whose Host header isn't `localhost` or `127.0.0.1`.
- Plaid access tokens live in `data/items.json` with owner-only permissions. They never go to the browser. `data/` and `.env` are git-ignored.
- **Disconnect** (✕ on an account) revokes the Plaid item and deletes its token.

## Tests

```sh
npm test
```
