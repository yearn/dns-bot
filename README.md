# DNS Monitor Bot

A simple to configure, pre-built Cloudflare Worker that monitors DNS records for any list of user-specified domains and sends notifications via Telegram when changes are detected.

The project is designed to stay comfortably within Cloudflare's free tier for it's Worker and KV storage services.

<p align="center">
  <img src="images/example_alert.png" alt="Example alert" />
  <br/>
  <i>Example alert</i>
</p>

## Prerequisites

- [Bun](https://bun.sh/) (this repository uses bun; the deploy workflow pins `1.3.14`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4 or later) — installed as a dev dependency

## Configuration

Non-secret configuration lives in `wrangler.toml` under `[vars]`:

- `MONITOR_DOMAINS` — comma-separated domains to watch
- `ALLOWED_IP_RANGES` — e.g. `flexmeow.com=216.150.0.0/16;other.com=76.76.21.0/24`.
  IP changes that stay inside a domain's expected CIDR ranges update state
  silently instead of alerting, which is useful for hosts like Vercel that
  rotate IPs within known pools.

Worker secrets live in Doppler project `dns-bot`, config `prd`, each set to
**Masked**:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_THREAD_ID` (optional) — posts alerts to a specific topic thread
- `HEARTBEAT_URL` (optional) — Uptime Kuma push URL. This embeds a push token,
  which is why it is a secret and not a `[vars]` entry in this public repo.

## Deploying (yearn)

A push to `master` deploys through the shared `yearn/yearn-gha` Cloudflare
workflow, which authenticates to Doppler with OIDC. It is the only deploy path
— there is no manual trigger and no Cloudflare token in GitHub. The shared
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` come from Doppler
`webops-shared-prod` / `cloudflare-deploy-configs`.

Each deploy pushes every value in `dns-bot` / `prd` to the worker with
`wrangler secret bulk` before `wrangler deploy`, so Doppler is the single source
of truth. Two caveats: the sync is additive (a key removed from Doppler stays on
the worker until `wrangler secret delete`), and a manual `wrangler secret put` is
reverted on the next deploy.

Repository variable `DOPPLER_PRODUCTION_IDENTITY_ID` holds the production Doppler
identity; identity IDs are not secrets. See
`yearn-gha/specs/doppler-cloudflare.md` for the identity's required claims.

## Running your own copy

The Doppler path above is yearn-specific. To run this bot in your own Cloudflare
account, deploy from your machine instead:

```bash
bun install
bun run wrangler secret put TELEGRAM_BOT_TOKEN
bun run wrangler secret put TELEGRAM_CHAT_ID
# optional: TELEGRAM_THREAD_ID, HEARTBEAT_URL
CLOUDFLARE_API_TOKEN=... bun run deploy
```

Edit `[vars]` in `wrangler.toml` for your own domains, and create your own KV
namespace (`bun run wrangler kv namespace create DNS_KV`), updating the `id` in
`wrangler.toml`. You will need a Cloudflare API token[^2].

## Viewing Logs

To view the logs for your deployed worker:

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Workers & Pages**.
3. Select your worker (`dns-bot`).
4. Click on **Logs** to view the worker's logs.

## Troubleshooting

- **Wrangler not found:** Run `bun install`, then use `bun run wrangler`.
- **Deployment fails:** Check the API token and that `dns-bot` / `prd` in Doppler is populated — the deploy fails loudly if it resolves empty.
- **No logs:** Ensure logging is enabled in your `wrangler.toml` file.
- **GitHub Actions fails:** Verify the repository variable `DOPPLER_PRODUCTION_IDENTITY_ID` is set and that the Doppler identity's claims match the pinned workflow SHA.

## Footnotes

[^2]: To get your Cloudflare API token:

    1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/)
    2. Navigate to **My Profile** > **API Tokens**
    3. Click **Create Token**
    4. Choose **Create Custom Token**
    5. Set the following permissions:
       - **Account** > **Workers** > **Edit**
       - **Zone** > **DNS** > **Read**
    6. Set the **Account Resources** to **All accounts**
    7. Set the **Zone Resources** to **All zones**
    8. Click **Continue to summary** and then **Create Token**
