import { isProviderDriverKind, ProviderDriverKind } from "@t3tools/contracts";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { providerTextColorClassName } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";

type Pixel = readonly [x: number, y: number, width: number, height: number];

/** One pixel-art buddy on a 16x12 grid. Eyes sit on the body; the laptop covers its lower half. */
interface Sprite {
  readonly body: ReadonlyArray<Pixel>;
  readonly openEyes: ReadonlyArray<Pixel>;
  readonly closedEyes: ReadonlyArray<Pixel>;
  readonly laptop: Pixel;
}

const BLOB: Sprite = {
  body: [
    [5, 2, 6, 1],
    [4, 3, 8, 6],
    [5, 9, 6, 1],
    [5, 10, 2, 1],
    [9, 10, 2, 1],
  ],
  openEyes: [
    [6, 4, 1, 2],
    [9, 4, 1, 2],
  ],
  closedEyes: [
    [5, 5, 2, 1],
    [9, 5, 2, 1],
  ],
  laptop: [5, 7, 6, 2],
};

const SPRITES: Partial<Record<ProviderDriverKind, Sprite>> = {
  // Claude Code's crab: wide body, side arms, four legs.
  [ProviderDriverKind.make("claudeAgent")]: {
    body: [
      [3, 2, 10, 7],
      [1, 4, 2, 2],
      [13, 4, 2, 2],
      [4, 9, 1, 2],
      [6, 9, 1, 2],
      [9, 9, 1, 2],
      [11, 9, 1, 2],
    ],
    openEyes: [
      [5, 3, 1, 2],
      [10, 3, 1, 2],
    ],
    closedEyes: [
      [4, 4, 2, 1],
      [10, 4, 2, 1],
    ],
    laptop: [5, 6, 6, 3],
  },
  // Codex gets an antenna on the round body.
  [ProviderDriverKind.make("codex")]: {
    ...BLOB,
    body: [[7, 0, 2, 2], ...BLOB.body],
  },
  // Cursor's cube.
  [ProviderDriverKind.make("cursor")]: {
    ...BLOB,
    body: [
      [4, 2, 8, 8],
      [5, 10, 2, 1],
      [9, 10, 2, 1],
    ],
  },
};

// Rises above the 12-row grid; the svg lets it overflow into the row's padding.
const SLEEP_GLYPH: ReadonlyArray<Pixel> = [
  [13, -2, 3, 1],
  [15, -1, 1, 1],
  [14, 0, 1, 1],
  [13, 1, 1, 1],
  [13, 2, 3, 1],
];
const ALERT_GLYPH: ReadonlyArray<Pixel> = [
  [14, 0, 1, 2],
  [14, 3, 1, 1],
];

const WAKE_MS = 600;

export function teamBuddyProviderLabel(provider: string | null): string | null {
  if (provider === null) return null;
  return (
    (isProviderDriverKind(provider) ? getDriverOption(provider)?.label : undefined) ?? provider
  );
}

/** True for one wake-up beat after `working` turns on. Never on first render. */
function useWaking(working: boolean) {
  const [waking, setWaking] = useState(false);
  const previous = useRef(working);
  useEffect(() => {
    const wasWorking = previous.current;
    previous.current = working;
    if (!working || wasWorking) return;
    setWaking(true);
    const timer = setTimeout(() => setWaking(false), WAKE_MS);
    return () => clearTimeout(timer);
  }, [working]);
  return waking && working;
}

function Pixels(props: { pixels: ReadonlyArray<Pixel>; className?: string | undefined }) {
  return props.pixels.map(([x, y, width, height]) => (
    <rect key={`${x}:${y}`} x={x} y={y} width={width} height={height} className={props.className} />
  ));
}

/**
 * A member's last-used agent as a small pixel buddy. Asleep while idle, typing at a laptop while
 * an agent runs, with a one-time hop when work starts. Decorative: callers state the same thing
 * in text.
 */
export const TeamBuddy = memo(function TeamBuddy(props: {
  provider: string | null;
  working: boolean;
  online: boolean;
  className?: string;
}) {
  const waking = useWaking(props.working);
  const driver =
    props.provider !== null && isProviderDriverKind(props.provider) ? props.provider : null;
  const sprite = (driver ? SPRITES[driver] : undefined) ?? BLOB;
  const pose = waking ? "waking" : props.working ? "working" : "asleep";
  const [lx, ly, lw, lh] = sprite.laptop;

  return (
    <svg
      viewBox="0 0 16 12"
      shapeRendering="crispEdges"
      aria-hidden
      data-pose={pose}
      className={cn(
        "h-3.75 w-5 shrink-0 overflow-visible",
        (driver && providerTextColorClassName(driver)) ?? "text-sidebar-muted-foreground",
        !props.online && "opacity-45",
        pose === "waking" && "motion-safe:animate-buddy-wake",
        props.className,
      )}
    >
      <g fill="currentColor">
        <Pixels pixels={sprite.body} />
      </g>
      <g className="fill-sidebar">
        <Pixels pixels={pose === "asleep" ? sprite.closedEyes : sprite.openEyes} />
      </g>
      {pose === "working" ? (
        <>
          <rect x={lx} y={ly} width={lw} height={lh} className="fill-sidebar-muted-foreground" />
          <rect
            x={lx - 1}
            y={ly + lh}
            width={lw + 2}
            height={1}
            className="fill-sidebar-muted-foreground"
          />
          {/* Hands tap in turn: two stepped frames, so it repaints a few times a second, not per vsync. */}
          <rect
            x={lx}
            y={ly + lh - 1}
            width={1}
            height={1}
            fill="currentColor"
            className="motion-safe:animate-buddy-type"
          />
          <rect
            x={lx + lw - 1}
            y={ly + lh - 1}
            width={1}
            height={1}
            fill="currentColor"
            className="motion-safe:animate-buddy-type-offbeat"
          />
        </>
      ) : null}
      <g className="fill-sidebar-muted-foreground">
        {pose === "asleep" ? <Pixels pixels={SLEEP_GLYPH} /> : null}
        {pose === "waking" ? <Pixels pixels={ALERT_GLYPH} /> : null}
      </g>
    </svg>
  );
});
