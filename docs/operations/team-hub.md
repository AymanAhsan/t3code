# Self-host a team hub

The hub is a small server with a SQLite database. Run it on any machine your teammates can reach, such as the PC you already use. It must stay on, with Docker running, for teammates to see each other. If it is offline, local agent work continues and team updates resume when it reconnects.

```bash
docker build -f apps/hub/Dockerfile -t t3-team-hub .
docker run -d -p 8080:8080 -v hub-data:/data -e HUB_PUBLIC_URL=<address teammates will use> t3-team-hub
```

State lives in `/data/hub.sqlite`. Keep `/data` on a persistent volume: recreating the container without it creates an empty hub, and every member's credential stops working. Back the volume up, or use SQLite's backup API while the hub is running.

## The hub address must be reachable by teammates

Each teammate's local T3 Code server connects to the hub, so the address has to work from their machine. `localhost` only works on the machine running the container.

Invite links are built from the address the admin's app saved when the hub was set up, which is the address in the setup link, not `HUB_PUBLIC_URL`. Set up through `http://localhost:8080/setup#token=…` and every invite will point at `localhost`. The Team hub panel warns when this happens. To fix it, open a setup link that uses the reachable address, or replace the host in an invite link by hand. The token after `#token=` does not depend on the host.

## Choosing an address

| Situation                                                | Use                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teammates on the same network                            | The host's LAN IP, e.g. `http://192.168.1.20:8080`. No extra software.                                                                                   |
| Teammates anywhere, no cost, nothing for them to install | [Tailscale Funnel](#tailscale-funnel)                                                                                                                    |
| Teammates anywhere, hub kept off the public internet     | A Tailscale tailnet (or ZeroTier, WireGuard). Every teammate installs the client and joins the same network, then you use the host's private name or IP. |
| A short demo                                             | `cloudflared tunnel --url http://localhost:8080`. The URL changes on every restart, which breaks saved addresses and invites.                            |

### Tailscale Funnel

Funnel gives the host a stable public HTTPS address, so teammates install nothing.

1. Install Tailscale on the host and sign in. Enable HTTPS and Funnel for your tailnet in the Tailscale admin console.
2. Find the host's address, which looks like `https://my-pc.<tailnet>.ts.net`.
3. Start the hub with that address, then expose it:

   ```bash
   docker run -d -p 8080:8080 -v hub-data:/data -e HUB_PUBLIC_URL=https://my-pc.<tailnet>.ts.net t3-team-hub
   tailscale funnel 8080
   ```

Funnel makes the hub reachable from the public internet. Access is controlled by single-use invites and per-member credentials, not by the network. Tailscale's client is open source but its coordination service is not; [Headscale](https://github.com/juanfont/headscale) is an open-source replacement if you need one.

## First team

The container log prints a one-time setup link, using `HUB_PUBLIC_URL` as its address. Open T3 Code's **Settings → Integrations → Team hub → Set up a hub** and paste the link to create the first team. Completing setup removes the link's token from the database, so the hub prints no setup link on later starts.

Invites expire after 24 hours and admins can revoke them from the Team hub panel.

## Protocol

The hub requires protocol version 1 for WebSocket connections and responds with HTTP 426 when the client uses a different version.
