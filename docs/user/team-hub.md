# Team hub

A team hub shares short coordination updates between teammates while each person's agents and code stay on their own machine. The hub shows who's online, recent checkpoint activity, interface changes, and suggested tasks. A suggested task needs your acceptance in **Settings → Integrations → Team hub**; it does not start an agent turn automatically.

To join, paste the invite link from your team admin into **Settings → Integrations → Team hub**, choose a display name, and select **Join team**. The linked Git repository determines which project checkpoints are shared. Your local server reconnects to the hub automatically when available. You can leave from the same panel. If the hub is on Tailscale and your computer can't reach it, the panel says why, for example that Tailscale is turned off. **Check connection** runs the same check later.

Team admins can create 24-hour, single-use invites and remove members in that panel. Agents can read the team inbox, post notes or suggested tasks, claim files, and list interface changes with the team MCP tools.

To create a self-hosted team, [run a hub server](../operations/team-hub.md), then open **Set up a hub** in the Team hub panel and choose how teammates will reach it. Paste the hub's one-time setup link, then enter the team's name, Git remote URL, and your display name.

If you choose Tailscale, T3 Code checks Tailscale on your computer, tells you what to fix if something is missing, and shares the hub for you. Invites then use the Tailscale address instead of the one printed in the setup link. Funnel makes the hub reachable from the internet so teammates install nothing; joining still needs an invite. The private option keeps it on your tailnet, so teammates need Tailscale and access to it. Sharing works when the hub runs on the same computer as your T3 Code server. The **Hub address** row shows how the hub is shared and stops sharing.
