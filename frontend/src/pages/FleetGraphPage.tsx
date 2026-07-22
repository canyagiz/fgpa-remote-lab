import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import * as api from "../api/client";
import { Board, Deployment, Device, GapReport, Shuttle } from "../api/types";
import { useToast } from "../context/ToastContext";

/* ------------------------------------------------------------------ *
 *  A node-edge graph of the fleet, drawn by hand in SVG.
 *
 *  No graph library on purpose - the same reason the backend takes one
 *  REST call over a whole SDK. A force layout would also fight the
 *  point of this screen, which is that the operator arranges it: nodes
 *  are draggable and stay where they are put, like a blueprint canvas.
 *
 *  Two levels, entered by clicking a shuttle:
 *    fleet    - the portal (master) and every shuttle reporting to it
 *    shuttle  - one shuttle, its boards, and each board's devices
 * ------------------------------------------------------------------ */

const FAMILY_LABELS: Record<string, string> = {
  cyclone_iv: "Cyclone IV",
  cyclone_v: "Cyclone V",
  cyclone_10: "Cyclone 10",
  zynq_7020: "Zynq-7020",
};

function describeDevice(manufacturer: string | null, product: string | null): string {
  const maker = manufacturer?.trim() ?? "";
  const name = product?.trim() ?? "";
  if (!maker) return name || "Unknown device";
  if (!name) return maker;
  return name.toLowerCase().startsWith(maker.toLowerCase()) ? name : `${maker} ${name}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type NodeState = "ok" | "warn" | "bad" | "neutral";
type NodeKind = "portal" | "shuttle" | "board" | "programmer" | "capture" | "gpio" | "loose";

interface InfoRow {
  k: string;
  v: string;
}
interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub?: string;
  state: NodeState;
  x: number;
  y: number;
  drillShuttleId?: number;
  info: { title: string; rows: InfoRow[] };
}
interface GEdge {
  id: string;
  from: string;
  to: string;
  role: string;
  dashed?: boolean;
  state: NodeState;
  info: { title: string; rows: InfoRow[] };
}

/** Colour for a node/edge's state. Semantic, not the accent - a board
 *  being ready is a different axis from the page's own primary colour. */
function stateColor(state: NodeState): string {
  switch (state) {
    case "ok":
      return "var(--success)";
    case "warn":
      return "var(--warning)";
    case "bad":
      return "var(--destructive)";
    default:
      return "var(--border)";
  }
}

/** Evenly space `count` points on a circle - the default layout before
 *  anyone drags anything. */
function ring(cx: number, cy: number, count: number, radius: number, start = -Math.PI / 2) {
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const a = start + (i * 2 * Math.PI) / count;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  });
}

type View = { mode: "fleet" } | { mode: "shuttle"; shuttleId: number };

interface Built {
  nodes: GNode[];
  edges: GEdge[];
}

function buildFleet(
  shuttles: Shuttle[],
  boards: Board[],
  devices: Device[],
): Built {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];

  nodes.push({
    id: "portal",
    kind: "portal",
    label: "Portal",
    sub: "master",
    state: "neutral",
    x: 0,
    y: 0,
    info: {
      title: "Portal (master)",
      rows: [
        { k: "role", v: "control plane - CT210" },
        { k: "shuttles", v: String(shuttles.length) },
      ],
    },
  });

  const positions = ring(0, 0, shuttles.length, Math.max(240, shuttles.length * 70));
  shuttles.forEach((s, i) => {
    const boardCount = boards.filter((b) => b.shuttle_id === s.id).length;
    const deviceCount = devices.filter((d) => d.shuttle_id === s.id).length;
    const state: NodeState =
      s.status === "online" ? "ok" : s.status === "offline" ? "bad" : "neutral";
    nodes.push({
      id: `shuttle-${s.id}`,
      kind: "shuttle",
      label: s.name,
      sub: s.address ?? "no address",
      state,
      x: positions[i].x,
      y: positions[i].y,
      drillShuttleId: s.id,
      info: {
        title: s.name,
        rows: [
          { k: "status", v: s.status },
          { k: "address", v: s.address ?? "not set" },
          { k: "agent", v: s.agent_version ?? "—" },
          { k: "last report", v: formatWhen(s.last_report_at) },
          { k: "boards", v: String(boardCount) },
          { k: "devices", v: String(deviceCount) },
        ],
      },
    });
    edges.push({
      id: `report-${s.id}`,
      from: "portal",
      to: `shuttle-${s.id}`,
      role: "reports",
      dashed: s.status !== "online",
      state,
      info: {
        title: `${s.name} → Portal`,
        rows: [
          { k: "link", v: "inventory reporting, every 30s" },
          { k: "status", v: s.status },
          { k: "last report", v: formatWhen(s.last_report_at) },
          { k: "agent", v: s.agent_version ?? "—" },
        ],
      },
    });
  });

  return { nodes, edges };
}

function buildShuttle(
  shuttleId: number,
  shuttles: Shuttle[],
  boards: Board[],
  devices: Device[],
  deployments: Deployment[],
  gaps: GapReport[],
): Built {
  const shuttle = shuttles.find((s) => s.id === shuttleId);
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  if (!shuttle) return { nodes, edges };

  const myDevices = devices.filter((d) => d.shuttle_id === shuttleId);
  const myBoards = boards.filter((b) => b.shuttle_id === shuttleId);
  const bySerial = (serial: string | null) =>
    serial ? myDevices.find((d) => d.usb_serial === serial) : undefined;

  nodes.push({
    id: `shuttle-${shuttleId}`,
    kind: "shuttle",
    label: shuttle.name,
    sub: shuttle.address ?? "no address",
    state: shuttle.status === "online" ? "ok" : shuttle.status === "offline" ? "bad" : "neutral",
    x: 0,
    y: 0,
    info: {
      title: shuttle.name,
      rows: [
        { k: "status", v: shuttle.status },
        { k: "address", v: shuttle.address ?? "not set" },
        { k: "boards", v: String(myBoards.length) },
      ],
    },
  });

  const boardPos = ring(0, 0, myBoards.length, 260);
  myBoards.forEach((board, bi) => {
    const gap = gaps.find(
      (g) =>
        g.shuttle_id === shuttleId &&
        g.results.some((r) => r.type === "fpga" && r.message.includes(board.label)),
    );
    const deployment = deployments.find((d) => d.board_id === board.id);
    const state: NodeState = gap ? (gap.deployable ? "ok" : "warn") : "neutral";
    const bid = `board-${board.id}`;
    nodes.push({
      id: bid,
      kind: "board",
      label: board.label,
      sub: FAMILY_LABELS[board.family] ?? board.family,
      state,
      x: boardPos[bi].x,
      y: boardPos[bi].y,
      info: {
        title: board.label,
        rows: [
          { k: "family", v: FAMILY_LABELS[board.family] ?? board.family },
          { k: "readiness", v: gap ? (gap.deployable ? "ready" : `${gap.missing_count} unmet`) : "no template" },
          { k: "lab", v: deployment ? deployment.lab_name : "not bound" },
          { k: "serving", v: deployment ? (deployment.available ? "yes" : "withdrawn") : "—" },
        ],
      },
    });
    edges.push({
      id: `holds-${board.id}`,
      from: `shuttle-${shuttleId}`,
      to: bid,
      role: "holds",
      state,
      info: {
        title: `${shuttle.name} holds ${board.label}`,
        rows: [
          { k: "family", v: FAMILY_LABELS[board.family] ?? board.family },
          { k: "readiness", v: gap ? (gap.deployable ? "ready" : `${gap.missing_count} unmet`) : "no template" },
        ],
      },
    });

    // The board's own hardware, placed on a small arc facing outward so
    // it does not collide with the neighbouring boards' devices.
    const outward = Math.atan2(boardPos[bi].y, boardPos[bi].x);
    const children: { id: string; node: GNode; edge: GEdge }[] = [];

    const prog = bySerial(board.programmer_serial);
    children.push({
      id: `prog-${board.id}`,
      node: {
        id: `prog-${board.id}`,
        kind: "programmer",
        label: prog ? describeDevice(prog.manufacturer, prog.product) : board.programmer_serial,
        sub: board.programmer_serial,
        state: prog ? "ok" : "bad",
        x: 0,
        y: 0,
        info: {
          title: prog ? describeDevice(prog.manufacturer, prog.product) : "Programmer (not reported)",
          rows: prog
            ? [
                { k: "role", v: "programmer" },
                { k: "serial", v: prog.usb_serial ?? "—" },
                { k: "port", v: prog.sysfs_path },
                {
                  k: "jtag",
                  v: prog.jtag_chain?.length
                    ? prog.jtag_chain.map((c) => c.idcode).join(" · ")
                    : "not probed",
                },
              ]
            : [{ k: "serial", v: board.programmer_serial }, { k: "state", v: "not attached" }],
        },
      },
      edge: {
        id: `e-prog-${board.id}`,
        from: bid,
        to: `prog-${board.id}`,
        role: "programmer",
        dashed: !prog,
        state: prog ? "neutral" : "bad",
        info: {
          title: "Programmer link",
          rows: [
            { k: "serial", v: board.programmer_serial },
            { k: "port", v: prog?.sysfs_path ?? "—" },
          ],
        },
      },
    });

    if (board.video_capture_serial) {
      const cap = bySerial(board.video_capture_serial);
      const sig = cap?.has_video_signal;
      children.push({
        id: `cap-${board.id}`,
        node: {
          id: `cap-${board.id}`,
          kind: "capture",
          label: cap ? describeDevice(cap.manufacturer, cap.product) : board.video_capture_serial,
          sub: sig === true ? "signal" : sig === false ? "no signal" : cap ? "signal unknown" : "not attached",
          state: !cap ? "bad" : sig === false ? "bad" : sig === true ? "ok" : "warn",
          x: 0,
          y: 0,
          info: {
            title: cap ? describeDevice(cap.manufacturer, cap.product) : "Capture card (not attached)",
            rows: [
              { k: "role", v: "HDMI capture" },
              { k: "serial", v: board.video_capture_serial },
              {
                k: "signal",
                v: sig === true ? "present" : sig === false ? "none" : "unknown",
              },
            ],
          },
        },
        edge: {
          id: `e-cap-${board.id}`,
          from: bid,
          to: `cap-${board.id}`,
          role: "captures",
          dashed: !cap,
          state: sig === false ? "bad" : "neutral",
          info: {
            title: "Capture link",
            rows: [
              { k: "watches", v: board.label },
              { k: "signal", v: sig === true ? "present" : sig === false ? "none" : "unknown" },
            ],
          },
        },
      });
    }

    if (board.gpio_endpoint) {
      children.push({
        id: `gpio-${board.id}`,
        node: {
          id: `gpio-${board.id}`,
          kind: "gpio",
          label: "GPIO controller",
          sub: board.gpio_endpoint,
          state: "neutral",
          x: 0,
          y: 0,
          info: {
            title: "GPIO controller",
            rows: [
              { k: "endpoint", v: board.gpio_endpoint },
              { k: "reached", v: "over the network, not USB" },
              { k: "verified", v: "no - assignment only, not probed" },
            ],
          },
        },
        edge: {
          id: `e-gpio-${board.id}`,
          from: bid,
          to: `gpio-${board.id}`,
          role: "drives",
          dashed: true,
          state: "neutral",
          info: {
            title: "GPIO link (network)",
            rows: [
              { k: "endpoint", v: board.gpio_endpoint },
              { k: "note", v: "recorded by a person, not discovered" },
            ],
          },
        },
      });
    }

    const childPos = ring(
      boardPos[bi].x,
      boardPos[bi].y,
      children.length,
      130,
      outward - (Math.PI / 4) * (children.length - 1) * 0.5,
    );
    children.forEach((c, ci) => {
      c.node.x = childPos[ci].x;
      c.node.y = childPos[ci].y;
      nodes.push(c.node);
      edges.push(c.edge);
    });
  });

  // Attached but claimed by no board.
  const claimed = new Set<string>();
  myBoards.forEach((b) => {
    claimed.add(b.programmer_serial);
    if (b.video_capture_serial) claimed.add(b.video_capture_serial);
  });
  const loose = myDevices.filter((d) => !d.usb_serial || !claimed.has(d.usb_serial));
  const loosePos = ring(0, 0, loose.length, 150, Math.PI / 2);
  loose.forEach((d, i) => {
    const id = `loose-${d.id}`;
    nodes.push({
      id,
      kind: "loose",
      label: describeDevice(d.manufacturer, d.product),
      sub: d.usb_serial ?? d.sysfs_path,
      state: "warn",
      x: loosePos[i].x,
      y: loosePos[i].y,
      info: {
        title: describeDevice(d.manufacturer, d.product),
        rows: [
          { k: "role", v: d.kind.replace("_", " ") },
          { k: "serial", v: d.usb_serial ?? "none" },
          { k: "claimed", v: "no board claims this yet" },
        ],
      },
    });
    edges.push({
      id: `e-loose-${d.id}`,
      from: `shuttle-${shuttleId}`,
      to: id,
      role: "unclaimed",
      dashed: true,
      state: "warn",
      info: {
        title: "Unclaimed device",
        rows: [{ k: "serial", v: d.usb_serial ?? "none" }],
      },
    });
  });

  return { nodes, edges };
}

const NODE_W = 168;
const NODE_H = 46;
const SHUTTLE_R = 42;
const PORTAL_R = 34;

/** Where an edge should meet a node - the border, not the centre, so
 *  the line stops cleanly at the shape. */
function anchor(node: GNode, towardX: number, towardY: number) {
  const dx = towardX - node.x;
  const dy = towardY - node.y;
  const len = Math.hypot(dx, dy) || 1;
  if (node.kind === "shuttle" || node.kind === "portal") {
    const r = node.kind === "shuttle" ? SHUTTLE_R : PORTAL_R;
    return { x: node.x + (dx / len) * r, y: node.y + (dy / len) * r };
  }
  // Rectangle: clip the ray to the box.
  const hw = NODE_W / 2;
  const hh = NODE_H / 2;
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

export default function FleetGraphPage() {
  const { showError } = useToast();
  const [shuttles, setShuttles] = useState<Shuttle[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [gaps, setGaps] = useState<GapReport[]>([]);

  const [view, setView] = useState<View>({ mode: "fleet" });
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null);

  // User-dragged positions override the default layout and survive both
  // the 30s refresh and switching views - the point of a hand-arranged
  // canvas is that it stays arranged.
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [pan, setPan] = useState({ x: 400, y: 280 });
  const [zoom, setZoom] = useState(1);

  async function refresh() {
    try {
      const [s, d, b, dep, g] = await Promise.all([
        api.getShuttles(),
        api.getFleetDevices(),
        api.getBoards(),
        api.getDeployments(),
        api.getGaps(),
      ]);
      setShuttles(s);
      setDevices(d);
      setBoards(b);
      setDeployments(dep);
      setGaps(g);
    } catch (err) {
      showError(err instanceof api.ApiError ? err.message : "Failed to load topology");
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const built = useMemo<Built>(() => {
    if (view.mode === "fleet") return buildFleet(shuttles, boards, devices);
    return buildShuttle(view.shuttleId, shuttles, boards, devices, deployments, gaps);
  }, [view, shuttles, boards, devices, deployments, gaps]);

  // Re-frame when the view changes: centre origin, reset zoom, drop the
  // selection so a stale panel from the other level does not linger.
  const viewKey = view.mode === "fleet" ? "fleet" : `shuttle-${view.shuttleId}`;
  useEffect(() => {
    setPan({ x: size.w / 2, y: size.h / 2 });
    setZoom(1);
    setSelected(null);
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (n: GNode) => overrides[n.id] ?? { x: n.x, y: n.y };
  const nodeById = useMemo(() => {
    const m: Record<string, GNode> = {};
    built.nodes.forEach((n) => (m[n.id] = { ...n, ...(overrides[n.id] ?? {}) }));
    return m;
  }, [built, overrides]);

  // --- pointer interaction: node drag, canvas pan, click-to-select ---
  // Pointer capture on the svg means pointerup is redirected here rather
  // than to the node the drag began on, so click-vs-drag is decided in
  // the svg's own onPointerUp using what onPointerDown recorded.
  const drag = useRef<
    | { kind: "node"; id: string; offX: number; offY: number; moved: boolean }
    | { kind: "pan"; startX: number; startY: number; panX: number; panY: number; moved: boolean }
    | null
  >(null);

  function toWorld(clientX: number, clientY: number) {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - pan.x) / zoom, y: (clientY - r.top - pan.y) / zoom };
  }

  function onNodePointerDown(e: React.PointerEvent, n: GNode) {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const p = pos(n);
    drag.current = { kind: "node", id: n.id, offX: w.x - p.x, offY: w.y - p.y, moved: false };
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "node") {
      const w = toWorld(e.clientX, e.clientY);
      d.moved = true;
      setOverrides((o) => ({ ...o, [d.id]: { x: w.x - d.offX, y: w.y - d.offY } }));
    } else {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setPan({ x: d.panX + dx, y: d.panY + dy });
    }
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "pan") {
      if (!d.moved) setSelected(null); // a click on empty canvas clears
      return;
    }
    if (d.moved) return; // a real drag, not a click
    const n = built.nodes.find((node) => node.id === d.id);
    if (!n) return;
    if (view.mode === "fleet" && n.drillShuttleId != null) {
      setView({ mode: "shuttle", shuttleId: n.drillShuttleId });
    } else {
      setSelected({ kind: "node", id: n.id });
    }
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const r = svgRef.current!.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const worldX = (cx - pan.x) / zoom;
    const worldY = (cy - pan.y) / zoom;
    const next = Math.min(2.2, Math.max(0.4, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setPan({ x: cx - worldX * next, y: cy - worldY * next });
    setZoom(next);
  }

  const selectedShuttle =
    view.mode === "shuttle" ? shuttles.find((s) => s.id === view.shuttleId) : undefined;
  const panel = selected
    ? selected.kind === "node"
      ? built.nodes.find((n) => n.id === selected.id)?.info
      : built.edges.find((e) => e.id === selected.id)?.info
    : undefined;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button
              className={view.mode === "fleet" ? "font-medium text-foreground" : "hover:text-foreground"}
              onClick={() => setView({ mode: "fleet" })}
            >
              Fleet
            </button>
            {view.mode === "shuttle" && (
              <>
                <span>/</span>
                <span className="font-medium text-foreground">{selectedShuttle?.name}</span>
              </>
            )}
          </div>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight">Fleet topology</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view.mode === "fleet"
              ? "Click a shuttle to open it. Drag nodes to arrange, drag the canvas to pan, scroll to zoom."
              : "Boards and the hardware wired to each. Click an edge for its details."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view.mode === "shuttle" && (
            <Button size="sm" variant="secondary" onClick={() => setView({ mode: "fleet" })}>
              ← Fleet
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOverrides({});
              setPan({ x: size.w / 2, y: size.h / 2 });
              setZoom(1);
            }}
          >
            Reset layout
          </Button>
          <Link
            to="/admin/fleet"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Table view →
          </Link>
        </div>
      </div>

      <div className="relative mt-5 overflow-hidden rounded-xl border bg-card">
        <svg
          ref={svgRef}
          className="block h-[62vh] w-full touch-none select-none"
          style={{ cursor: drag.current?.kind === "pan" ? "grabbing" : "grab" }}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        >
          <defs>
            {/* Blueprint grid - a faint dotted field so the canvas reads
                as a workspace, and so panning is legible. */}
            <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="var(--border)" opacity="0.6" />
            </pattern>
          </defs>
          <rect
            x={-pan.x / zoom}
            y={-pan.y / zoom}
            width={size.w / zoom}
            height={size.h / zoom}
            transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
            fill="url(#grid)"
          />

          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {/* Edges first, so nodes sit on top of them. */}
            {built.edges.map((e) => {
              const a = nodeById[e.from];
              const b = nodeById[e.to];
              if (!a || !b) return null;
              const pa = anchor(a, b.x, b.y);
              const pb = anchor(b, a.x, a.y);
              const mx = (pa.x + pb.x) / 2;
              const my = (pa.y + pb.y) / 2;
              const isSel = selected?.kind === "edge" && selected.id === e.id;
              const color = isSel ? "var(--primary)" : stateColor(e.state);
              return (
                <g key={e.id}>
                  {/* Wide invisible hit target so a thin line is still
                      easy to click. */}
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ cursor: "pointer" }}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      setSelected({ kind: "edge", id: e.id });
                    }}
                  />
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke={color}
                    strokeWidth={isSel ? 3 : 1.75}
                    strokeDasharray={e.dashed ? "5 5" : undefined}
                    strokeLinecap="round"
                  />
                  {(isSel || zoom > 0.85) && (
                    <text
                      x={mx}
                      y={my - 5}
                      textAnchor="middle"
                      fontSize={10}
                      fill="var(--muted-foreground)"
                      style={{ pointerEvents: "none" }}
                    >
                      {e.role}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {built.nodes.map((n) => {
              const p = nodeById[n.id];
              const isSel = selected?.kind === "node" && selected.id === n.id;
              const color = stateColor(n.state);
              const common = {
                onPointerDown: (ev: React.PointerEvent) => onNodePointerDown(ev, n),
                style: { cursor: "pointer" as const },
              };
              const drillable = view.mode === "fleet" && n.drillShuttleId != null;

              if (n.kind === "portal" || n.kind === "shuttle") {
                const r = n.kind === "portal" ? PORTAL_R : SHUTTLE_R;
                return (
                  <g key={n.id} transform={`translate(${p.x} ${p.y})`} {...common}>
                    {isSel && <circle r={r + 6} fill="none" stroke="var(--primary)" strokeWidth={2} />}
                    <circle
                      r={r}
                      fill="var(--card)"
                      stroke={n.kind === "portal" ? "var(--primary)" : color}
                      strokeWidth={n.kind === "portal" ? 2 : 3}
                    />
                    <text textAnchor="middle" y={-2} fontSize={12} fontWeight={700} fill="var(--foreground)">
                      {n.label.length > 12 ? n.label.slice(0, 11) + "…" : n.label}
                    </text>
                    <text textAnchor="middle" y={13} fontSize={9} fill="var(--muted-foreground)">
                      {drillable ? "click to open" : n.sub}
                    </text>
                  </g>
                );
              }

              // Rectangle nodes (board / device / gpio / loose).
              const dashed = n.kind === "gpio" || n.kind === "loose";
              return (
                <g key={n.id} transform={`translate(${p.x} ${p.y})`} {...common}>
                  {isSel && (
                    <rect
                      x={-NODE_W / 2 - 4}
                      y={-NODE_H / 2 - 4}
                      width={NODE_W + 8}
                      height={NODE_H + 8}
                      rx={12}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth={2}
                    />
                  )}
                  <rect
                    x={-NODE_W / 2}
                    y={-NODE_H / 2}
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill="var(--card)"
                    stroke={color}
                    strokeWidth={n.kind === "board" ? 2.5 : 1.5}
                    strokeDasharray={dashed ? "5 4" : undefined}
                  />
                  {/* A colour tab on the left edge, so state reads at a
                      glance without relying on the outline alone. */}
                  <rect x={-NODE_W / 2} y={-NODE_H / 2} width={5} height={NODE_H} rx={2} fill={color} />
                  <text x={-NODE_W / 2 + 14} y={-3} fontSize={11} fontWeight={600} fill="var(--foreground)">
                    {n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label}
                  </text>
                  <text
                    x={-NODE_W / 2 + 14}
                    y={12}
                    fontSize={9}
                    fill="var(--muted-foreground)"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {(n.sub ?? "").length > 24 ? (n.sub ?? "").slice(0, 23) + "…" : n.sub}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Selection panel - floats over the canvas rather than pushing
            it, so the graph never reflows when you click around. */}
        {panel && (
          <div className="absolute right-3 top-3 w-64 rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{panel.title}</p>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <dl className="mt-2 space-y-1">
              {panel.rows.map((row, i) => (
                <div key={i} className="flex justify-between gap-3 text-xs">
                  <dt className="text-muted-foreground">{row.k}</dt>
                  <dd className="text-right font-medium">{row.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {built.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {shuttles.length === 0 ? "No shuttles enrolled yet." : "Nothing to show here."}
            </p>
          </div>
        )}
      </div>

      {/* Legend - the solid/dashed distinction is load-bearing: dashed
          things are recorded by a person or reached over the network, so
          the graph cannot detect their absence. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--success)" }} /> ok
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--warning)" }} /> needs
          attention
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--destructive)" }} /> fault
        </span>
        <span>— solid: seen over USB · - - dashed: recorded / over the network</span>
      </div>
    </div>
  );
}
