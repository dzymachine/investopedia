# Deploy to Fly.io

The app runs on Fly.io at `https://<your-app>.fly.dev`. It sleeps when nobody is using it and wakes up when you open it, which takes a few seconds. Only devices with your passkey can get in.

Cost: a 1 GB volume is about $0.15 a month, and the server is billed only while it's awake. At a few visits a week, expect well under $1 a month.

## 1. Install the Fly CLI and sign in

```sh
brew install flyctl
fly auth signup        # or: fly auth login
```

## 2. Create the app

Pick a name that nobody could guess, like `my-ledger`. It becomes part of your web address.

```sh
fly apps create my-ledger
```

In `fly.toml`, replace both `APP_NAME` entries with your name and set `TZ` to your timezone.

## 3. Create the volume that holds your data

```sh
fly volumes create ledger_data --size 1 --region iad --app my-ledger
```

## 4. Set the secrets

Generate three random values and save the **setup code** in your password manager. `SESSION_SECRET` and `TOKEN_KEY` must be at least 32 characters, and the commands below make them long enough. You'll need it once, to create your first passkey.

```sh
SETUP_CODE=$(openssl rand -base64 18)
echo "Setup code: $SETUP_CODE"     # save this

fly secrets set --app my-ledger \
  SESSION_SECRET="$(openssl rand -base64 32)" \
  TOKEN_KEY="$(openssl rand -base64 32)" \
  SETUP_CODE="$SETUP_CODE" \
  PLAID_CLIENT_ID="your-client-id" \
  PLAID_SECRET="your-secret" \
  SHORT_TERM_TAX_RATE=0.32 \
  LONG_TERM_TAX_RATE=0.15
```

Keep `TOKEN_KEY` stable. If you change it, the saved account connections can't be read anymore and you'll have to link your accounts again.

## 5. Deploy

```sh
fly deploy
```

## 6. Create your passkey

1. Open `https://my-ledger.fly.dev`.
2. Enter the setup code and choose **Create passkey**.
3. Approve it with Face ID or Touch ID.

Once you have a passkey, the setup code no longer works. Remove it anyway, so nobody can lock you out of setup by guessing wrong codes:

```sh
fly secrets unset SETUP_CODE --app my-ledger
```

**Sign out** signs out every device at once. Use it if you think someone got into one of your sessions.

On your other devices:

- **Same Apple or Google account:** the passkey syncs through iCloud Keychain or Google Password Manager, so you just sign in.
- **Other devices:** on the sign-in page, choose to use a phone and scan the QR code with the phone that has the passkey. Or sign in on a device that has it and choose **Add passkey**.

## 7. Link your accounts

1. Choose **Add account** and connect Schwab, Robinhood and Kraken.
2. Do this from a desktop browser. Some brokerages send you to their own login page, and that handoff is most reliable on desktop.
3. To move from sandbox to real data, change `PLAID_ENV` in `fly.toml` to `production`, set your production `PLAID_SECRET`, and run `fly deploy`.

Accounts you linked on your own computer don't carry over, so link them again on the deployed app.

## Connect Kraken directly (optional)

This works without Plaid, using a read-only Kraken API key.

1. In Kraken, go to **Settings → Security → API**, or **Connections & API** in Kraken Pro, and create a new key just for this app.
2. Turn on only **Query Funds** and **Query Closed Orders & Trades**. Leave every trade, deposit and withdraw permission off.
3. Set the key on the server:

   ```sh
   fly secrets set --app my-ledger KRAKEN_API_KEY="..." KRAKEN_API_SECRET="..."
   ```

Kraken then shows up as an account. To remove it, run `fly secrets unset KRAKEN_API_KEY KRAKEN_API_SECRET`. Don't also link Kraken through Plaid, or it will be counted twice.

## If you lose every passkey

```sh
fly secrets set SETUP_CODE="$(openssl rand -base64 18)" --app my-ledger   # new code, save it
fly ssh console --app my-ledger -C "rm /data/passkeys.json"
```

Then open the site and set up a passkey again. Your linked accounts stay.

## Useful commands

```sh
fly logs --app my-ledger             # see what the server is doing
fly status --app my-ledger           # is it awake?
fly volumes list --app my-ledger     # Fly snapshots the volume daily; see `fly volumes snapshots list <volume-id>`
```
