# Product

## Register

product

## Users

Small dev teams (roughly 2 to 10 people) working in one shared repository, each person driving coding agents in T3 Code. Each teammate owns parts of the repo. They spend the day inside agent threads and want follow-up work found by one agent to reach the right owner without a meeting, a ticket, or a copy-pasted message.

## Product Purpose

This fork of T3 Code adds the Team hub. Teammates join a hub and list the repo areas they own. When an agent finds follow-up work outside its owner's area, it hands it off as a contract file plus a suggested task to the teammate who owns that area, who reviews and accepts it into a local agent thread. Success means a team can see who is around, what has come in for them, and act on it in one or two clicks from anywhere in the app.

The Team hub is the fork's headline feature. It should be easy to find on first launch and always visible once a team is joined. The pitch lives in the app and README for now, not on the marketing site.

## Brand Personality

Quiet, precise, collaborative. The hub reads as a native part of T3 Code, not a bolted-on social layer. Copy is plain and specific: names, counts, repo paths. Presence and incoming work are stated, not celebrated.

## Anti-references

- Chat apps (Slack, Discord): no unread-badge noise, no activity feeds, no emoji presence.
- Ticket trackers (Jira, Linear boards): no kanban columns or status sprawl for what is a single handoff.
- SaaS dashboards: no hero metrics, gradient accents, or identical card grids.
- Anything that pulses, animates continuously, or competes with the agent thread for attention.

## Design Principles

1. **Visible, not loud.** The hub earns a permanent place in navigation through useful state (team, who is online, incoming tasks), not decoration.
2. **One obvious next step.** Not joined: set up or join. Joined with work waiting: review it. Every surface points at that step.
3. **Same data, every entry point.** Sidebar, route, palette, and settings all reflect the same hub state; none of them is the only way in.
4. **Cheap by default.** Hub surfaces reuse existing state and never add websocket traffic or repainting animation.
5. **The owner decides.** Handoffs are proposals; accepting work into a thread is always the owner's explicit action.

## Accessibility & Inclusion

WCAG 2.2 AA. Full keyboard operation for every hub action. Presence and counts are conveyed in text, not color alone. No continuous animation; all motion respects `prefers-reduced-motion`.
