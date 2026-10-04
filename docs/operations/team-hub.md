# Self-host a team hub

Run the hub on a machine that teammates can reach, with a persistent volume:

```bash
docker build -f apps/hub/Dockerfile -t t3-team-hub .
docker run -d -p 8080:8080 -v hub-data:/data -e HUB_PUBLIC_URL=https://hub.example.com t3-team-hub
```

Put HTTPS in front of a public deployment, or use an address reachable on your private network. Set `HUB_PUBLIC_URL` to the address teammates will use. The container log prints a one-time setup link. Open T3 Code's **Settings → Integrations → Team hub → Set up a hub** and paste the link to create the first team. The hub stores state in `/data/hub.sqlite`; back up the persistent volume or use SQLite's backup API while the hub is running. Invites expire after 24 hours and admins can revoke them from the Team hub panel.

The hub requires protocol version 1 for WebSocket connections and responds with HTTP 426 when the client uses a different version. If the hub is offline, local agent work continues and team updates resume when it reconnects.
