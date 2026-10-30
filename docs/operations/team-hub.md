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

If the hub runs on the same computer as your T3 Code server, **Team hub → Set up a hub** (sidebar, **Set up a team**) can share it over Tailscale for you, publicly with Funnel or privately on your tailnet. Run the hub, then choose Tailscale there. The steps below are for a hub on another machine, or to do the same by hand.

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

The container log prints a one-time setup link, using `HUB_PUBLIC_URL` as its address. In T3 Code, select **Set up a team** in the sidebar and paste the link to create the first team. Completing setup removes the link's token from the database, so the hub prints no setup link on later starts.

Invites expire after 24 hours and admins can revoke them from the Team hub panel.

## Protocol

The hub requires protocol version 6 for WebSocket connections and responds with HTTP 426 when the client uses a different version. Version 5 added per-member automatic-start allowances and durable task reservations. Version 6 adds member activity (whether an agent is running, and which kind), which the hub keeps in memory and forgets on restart. Update all connected environments before enabling automatic tasks. Update the hub and every teammate's T3 Code together. An existing hub database gains the new columns on its first start. Previously accepted tasks have no thread link; post and accept a new task to use completion reporting for that work.

## Local development with Alice and Bob

Run these commands from the T3 Code checkout after [installing its dependencies](./development.md#first-checkout). Node 24 and Git must be available. The selected project must have a Git `origin` remote, which identifies the team's repository. Docker is not needed for this local launcher.

Start a local hub and two web/server sessions using this checkout as the project:

```sh
vp run dev:team
```

Alice is the team admin and Bob is a member; both join automatically and get a project and initial thread. Open each session's labeled pairing URL printed in the terminal. The launcher does not open browsers. Authenticate any provider you want to test before starting agent work.

### Test another repository without building the app

Pass the directory where Alice and Bob should work. The app code still runs from the T3 Code checkout, so you can test local app changes against a different project without compiling or installing T3 Code.

```sh
vp run dev:team --project-dir ../notes-api
```

Absolute paths work too. Quote paths containing spaces. For example, in PowerShell:

```powershell
vp run dev:team --project-dir "C:\Users\Your Name\notes-api"
```

Relative paths resolve from the shell's current directory. Both sessions share the selected project files, so agent edits affect the same files.

### Preview, ports, and stopping

Preview the selected project, Git origin, hub address, and state directory without starting processes or creating demo state:

```sh
vp run dev:team --project-dir ../notes-api --dry-run
```

If port 8080 is occupied, choose another hub port:

```sh
vp run dev:team --project-dir ../notes-api --hub-port 18080
```

Alice and Bob's server and web ports move automatically when occupied. Read their actual addresses from the startup output. Press Ctrl+C in the launcher terminal to stop the hub and both sessions. Run `vp run dev:team --help` for the available options.

### Saved sessions and restart errors

State persists under `.t3/team-demo`, with separate Alice and Bob settings, credentials, and databases. Explicit `--project-dir` targets use separate state under `.t3/team-demo/projects`, keyed by directory and Git origin; returning to the same target resumes its sessions. Omitting the option keeps using the original demo state. Moving the target directory or changing its Git origin selects fresh state.

If startup reports `Saved Alice membership belongs to a different team/repository.`, the saved team's repository differs from the selected project's Git origin. Restart with an explicit `--project-dir` for the intended repository to use its separate state. This also works with `--project-dir .` when testing the T3 Code checkout itself. Existing demo state is preserved.

The launcher binds locally and does not change Tailscale configuration. If it was forcibly killed, confirm its processes have stopped and remove only `launcher.lock` from the state directory printed in the error before restarting.

### Check launcher changes

Run the focused tests, lint, and hub typecheck from the T3 Code checkout:

```sh
vp test run apps/hub/src/dev-team.test.ts
vp lint apps/hub/src/dev-team.ts apps/hub/src/dev-team.test.ts
vp run --filter @t3tools/hub typecheck
```

The tests cover repository isolation, saved membership reuse, and dry-run selection. Use a dry run against your target repository to check its actual path and origin before starting the sessions.
