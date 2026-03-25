"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/utils";
import { useToast } from "@/components/common/Toaster";
import type {
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeGraphEdge,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const NODE_TYPE_COLORS: Record<string, string> = {
  person: "#3b82f6",       // blue
  vehicle: "#a855f7",      // purple
  camera: "#06b6d4",       // cyan
  zone: "#22c55e",         // green
  alert: "#ef4444",        // red
  event: "#f97316",        // orange
  object: "#eab308",       // yellow
  location: "#14b8a6",     // teal
  default: "#6b7280",      // gray
};

// Community palette — 10 distinct hues
const COMMUNITY_COLORS = [
  "#3b82f6", // blue
  "#a855f7", // purple
  "#22c55e", // green
  "#f97316", // orange
  "#ef4444", // red
  "#eab308", // yellow
  "#14b8a6", // teal
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#06b6d4", // cyan
];

const SVG_WIDTH = 900;
const SVG_HEIGHT = 500;
const ITERATIONS = 100;
const REPULSION = 3000;
const ATTRACTION = 0.005;
const DAMPING = 0.9;
const MIN_RADIUS = 6;
const MAX_RADIUS = 24;

// Min/max stroke width for edge weight rendering
const MIN_STROKE = 1;
const MAX_STROKE = 6;

/* ------------------------------------------------------------------ */
/*  Force simulation (no D3)                                           */
/* ------------------------------------------------------------------ */

interface SimNode {
  id: string;
  label: string;
  type: string;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

function runForceSimulation(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[]
): SimNode[] {
  // Initialize positions randomly within padded bounds
  const pad = 60;
  const simNodes: SimNode[] = nodes.map((n) => {
    const maxWeight = Math.max(...nodes.map((nn) => nn.weight), 1);
    const normalizedWeight = n.weight / maxWeight;
    const radius = MIN_RADIUS + normalizedWeight * (MAX_RADIUS - MIN_RADIUS);
    return {
      id: n.id,
      label: n.label,
      type: n.type,
      weight: n.weight,
      x: pad + Math.random() * (SVG_WIDTH - 2 * pad),
      y: pad + Math.random() * (SVG_HEIGHT - 2 * pad),
      vx: 0,
      vy: 0,
      radius,
    };
  });

  const nodeMap = new Map<string, SimNode>();
  simNodes.forEach((n) => nodeMap.set(n.id, n));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion: every pair of nodes
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i];
        const b = simNodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distSq = dx * dx + dy * dy || 1;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Attraction: along edges
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * ATTRACTION * (edge.weight || 1);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    // Center gravity
    for (const node of simNodes) {
      const cx = SVG_WIDTH / 2;
      const cy = SVG_HEIGHT / 2;
      node.vx += (cx - node.x) * 0.001;
      node.vy += (cy - node.y) * 0.001;
    }

    // Apply velocities with damping
    for (const node of simNodes) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      // Clamp to bounds
      node.x = Math.max(pad, Math.min(SVG_WIDTH - pad, node.x));
      node.y = Math.max(pad, Math.min(SVG_HEIGHT - pad, node.y));
    }
  }

  return simNodes;
}

/* ------------------------------------------------------------------ */
/*  BFS shortest-path                                                  */
/* ------------------------------------------------------------------ */

function bfsPath(
  startId: string,
  endId: string,
  edges: KnowledgeGraphEdge[]
): Set<string> {
  // Build adjacency list (undirected)
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  // BFS
  const prev = new Map<string, string>();
  const visited = new Set<string>([startId]);
  const queue: string[] = [startId];
  let found = false;

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === endId) { found = true; break; }
    for (const nb of adj.get(cur) || []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        prev.set(nb, cur);
        queue.push(nb);
      }
    }
  }

  if (!found) return new Set();

  // Reconstruct path nodes
  const pathNodes = new Set<string>();
  let cur: string | undefined = endId;
  while (cur !== undefined) {
    pathNodes.add(cur);
    cur = prev.get(cur);
  }
  return pathNodes;
}

/* Edge key helper — canonical undirected */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/* ------------------------------------------------------------------ */
/*  Connected-components community detection                           */
/* ------------------------------------------------------------------ */

function detectCommunities(
  nodeIds: string[],
  edges: KnowledgeGraphEdge[]
): Map<string, number> {
  const parent = new Map<string, string>(nodeIds.map((id) => [id, id]));

  function find(x: string): string {
    while (parent.get(x) !== x) {
      const p = parent.get(x)!;
      parent.set(x, parent.get(p) ?? p); // path compression
      x = p;
    }
    return x;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of edges) {
    if (parent.has(e.source) && parent.has(e.target)) {
      union(e.source, e.target);
    }
  }

  // Assign sequential community IDs
  const rootToId = new Map<string, number>();
  let nextId = 0;
  const result = new Map<string, number>();
  for (const id of nodeIds) {
    const root = find(id);
    if (!rootToId.has(root)) {
      rootToId.set(root, nextId++);
    }
    result.set(id, rootToId.get(root)!);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Edge weight normalizer                                             */
/* ------------------------------------------------------------------ */

function normalizeEdgeWeight(
  weight: number,
  minW: number,
  maxW: number
): number {
  if (maxW === minW) return (MIN_STROKE + MAX_STROKE) / 2;
  return MIN_STROKE + ((weight - minW) / (maxW - minW)) * (MAX_STROKE - MIN_STROKE);
}

/* ------------------------------------------------------------------ */
/*  LinkAnalysisPage                                                   */
/* ------------------------------------------------------------------ */

export default function LinkAnalysisPage() {
  const { addToast } = useToast();

  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<SimNode | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set());
  const [threatIntel, setThreatIntel] = useState<any>(null);

  /* ---- Pathfinding state ---- */
  const [pathfindMode, setPathfindMode] = useState(false);
  const [pathStart, setPathStart] = useState<SimNode | null>(null);
  const [pathEnd, setPathEnd] = useState<SimNode | null>(null);
  const [pathNodeSet, setPathNodeSet] = useState<Set<string>>(new Set());
  const [pathEdgeSet, setPathEdgeSet] = useState<Set<string>>(new Set());

  /* ---- Community detection state ---- */
  const [communityMap, setCommunityMap] = useState<Map<string, number> | null>(null);
  const [showCommunities, setShowCommunities] = useState(false);

  /* ---- Edge hover tooltip ---- */
  const [hoveredEdge, setHoveredEdge] = useState<{
    edge: KnowledgeGraphEdge;
    x: number;
    y: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  /* ---- Fetch graph data ---- */
  useEffect(() => {
    async function fetchGraph() {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<KnowledgeGraph>(
          "/api/link-analysis/graph"
        );
        setGraph(data);

        // Extract all node types for filter
        const types = new Set(data.nodes.map((n) => n.type));
        setVisibleTypes(types);

        // Run simulation
        const result = runForceSimulation(data.nodes, data.edges);
        setSimNodes(result);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch knowledge graph"
        );
      } finally {
        setLoading(false);
      }
    }
    fetchGraph();
  }, []);

  /* ---- Fetch threat graph intelligence ---- */
  useEffect(() => {
    apiFetch("/api/intelligence/threat-graph")
      .then((data: any) => setThreatIntel(data))
      .catch((err) => { console.warn("[link-analysis] API call failed:", err); });
  }, []);

  /* ---- Derived data ---- */
  const allTypes = useMemo(
    () =>
      graph
        ? Array.from(new Set(graph.nodes.map((n) => n.type))).sort()
        : [],
    [graph]
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, SimNode>();
    simNodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [simNodes]);

  const filteredNodes = useMemo(
    () => simNodes.filter((n) => visibleTypes.has(n.type)),
    [simNodes, visibleTypes]
  );

  const filteredNodeIds = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const filteredEdges = useMemo(
    () =>
      (graph?.edges || []).filter(
        (e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)
      ),
    [graph?.edges, filteredNodeIds]
  );

  const connectedEdges = useMemo(
    () =>
      selectedNode
        ? (graph?.edges || []).filter(
            (e) => e.source === selectedNode.id || e.target === selectedNode.id
          )
        : [],
    [graph?.edges, selectedNode]
  );

  /* ---- Edge weight range for stroke normalization ---- */
  const { minEdgeWeight, maxEdgeWeight } = useMemo(() => {
    const weights = filteredEdges.map((e) => e.weight ?? 1);
    return {
      minEdgeWeight: Math.min(...weights, 1),
      maxEdgeWeight: Math.max(...weights, 1),
    };
  }, [filteredEdges]);

  /* ---- Path edge set (keyed by canonical edge key) ---- */
  const pathEdgeKeySet = useMemo(() => {
    if (pathNodeSet.size === 0) return new Set<string>();
    const keys = new Set<string>();
    for (const e of filteredEdges) {
      if (pathNodeSet.has(e.source) && pathNodeSet.has(e.target)) {
        keys.add(edgeKey(e.source, e.target));
      }
    }
    return keys;
  }, [pathNodeSet, filteredEdges]);

  /* ---- Toggle type filter ---- */
  const toggleType = useCallback((type: string) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  /* ---- Node selection / pathfinding handler ---- */
  const handleNodeClick = useCallback(
    (node: SimNode) => {
      if (pathfindMode) {
        if (!pathStart) {
          setPathStart(node);
          setPathEnd(null);
          setPathNodeSet(new Set());
          setPathEdgeSet(new Set());
        } else if (pathStart.id === node.id) {
          // deselect
          setPathStart(null);
          setPathEnd(null);
          setPathNodeSet(new Set());
        } else {
          setPathEnd(node);
          // Run BFS
          const edges = graph?.edges || [];
          const pathNodes = bfsPath(pathStart.id, node.id, edges);
          if (pathNodes.size === 0) {
            addToast("info", `No path found between "${pathStart.label}" and "${node.label}".`);
          } else {
            setPathNodeSet(pathNodes);
          }
        }
        return;
      }
      setSelectedNode((prev) => (prev?.id === node.id ? null : node));
    },
    [pathfindMode, pathStart, graph?.edges, addToast]
  );

  /* ---- Get node color (community or type) ---- */
  const getNodeColor = useCallback(
    (node: SimNode) => {
      if (showCommunities && communityMap) {
        const communityId = communityMap.get(node.id) ?? 0;
        return COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length];
      }
      return NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.default;
    },
    [showCommunities, communityMap]
  );

  /* Original color by type (for legend) */
  const getColor = useCallback((type: string) => {
    return NODE_TYPE_COLORS[type] || NODE_TYPE_COLORS.default;
  }, []);

  /* ---- Detect communities ---- */
  const handleDetectCommunities = useCallback(() => {
    if (!graph) return;
    const nodeIds = filteredNodes.map((n) => n.id);
    const map = detectCommunities(nodeIds, filteredEdges);
    setCommunityMap(map);
    setShowCommunities(true);

    const communityCount = new Set(map.values()).size;
    addToast("success", `Detected ${communityCount} communities across ${nodeIds.length} nodes.`);
  }, [graph, filteredNodes, filteredEdges, addToast]);

  const handleClearCommunities = useCallback(() => {
    setShowCommunities(false);
    setCommunityMap(null);
  }, []);

  /* ---- Toggle pathfind mode ---- */
  const togglePathfindMode = useCallback(() => {
    setPathfindMode((v) => {
      if (v) {
        // Clearing
        setPathStart(null);
        setPathEnd(null);
        setPathNodeSet(new Set());
      }
      return !v;
    });
  }, []);

  /* ---- Edge mouse handlers for tooltip ---- */
  const handleEdgeMouseEnter = useCallback(
    (e: React.MouseEvent<SVGLineElement>, edge: KnowledgeGraphEdge) => {
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      setHoveredEdge({
        edge,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    []
  );

  const handleEdgeMouseLeave = useCallback(() => {
    setHoveredEdge(null);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-900/30 border border-purple-800/50">
            <svg
              className="h-5 w-5 text-purple-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              Link Analysis{" "}
              <span className="text-cyan-400">&mdash; Knowledge Graph</span>
            </h1>
            <p className="text-xs text-gray-500">
              Entity relationships and connection mapping
            </p>
          </div>
        </div>

        {/* ---- Toolbar buttons ---- */}
        {!loading && !error && graph && (
          <div className="flex items-center gap-2">
            {/* Pathfind toggle */}
            <button
              onClick={togglePathfindMode}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                pathfindMode
                  ? "border-cyan-700 bg-cyan-900/30 text-cyan-400"
                  : "border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
              </svg>
              {pathfindMode ? "Exit Find Path" : "Find Path"}
            </button>

            {/* Community detect */}
            {showCommunities ? (
              <button
                onClick={handleClearCommunities}
                className="flex items-center gap-1.5 rounded-lg border border-purple-700 bg-purple-900/30 px-3 py-1.5 text-xs font-medium text-purple-400 hover:bg-purple-900/50 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Clear Communities
              </button>
            ) : (
              <button
                onClick={handleDetectCommunities}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="3" /><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" />
                </svg>
                Detect Communities
              </button>
            )}
          </div>
        )}
      </div>

      {/* ---- Pathfind hint bar ---- */}
      {pathfindMode && (
        <div className="flex items-center gap-3 border-b border-cyan-900/40 bg-cyan-950/20 px-6 py-2 text-xs text-cyan-400">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01" />
          </svg>
          <span>
            <strong>Path Find Mode:</strong>{" "}
            {!pathStart
              ? "Click a start node"
              : !pathEnd
              ? `Start: "${pathStart.label}" — Click an end node`
              : pathNodeSet.size > 0
              ? `Path found (${pathNodeSet.size} nodes). Click any node to restart.`
              : `No path found. Click any node to try again.`}
          </span>
          {pathStart && (
            <button
              onClick={() => { setPathStart(null); setPathEnd(null); setPathNodeSet(new Set()); }}
              className="ml-auto text-cyan-600 hover:text-cyan-400 underline"
            >
              Reset
            </button>
          )}
        </div>
      )}

      {/* ---- Filter bar ---- */}
      {!loading && !error && allTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-6 py-3">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 mr-1">
            Node Types:
          </span>
          {allTypes.map((type) => (
            <label
              key={type}
              className="flex items-center gap-1.5 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={visibleTypes.has(type)}
                onChange={() => toggleType(type)}
                className="h-3 w-3 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-700 focus:ring-offset-0"
              />
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: getColor(type) }}
              />
              <span className="text-xs text-gray-400 capitalize">{type}</span>
            </label>
          ))}

          {/* Community legend */}
          {showCommunities && communityMap && (
            <span className="ml-4 flex items-center gap-1.5 text-[10px] text-purple-400">
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" />
              </svg>
              Colored by community ({new Set(communityMap.values()).size} detected)
            </span>
          )}
        </div>
      )}

      {/* ---- Main content ---- */}
      <div className="flex flex-1 overflow-hidden">
        {/* Loading */}
        {loading && (
          <div className="flex flex-1 flex-col items-center justify-center">
            <svg
              className="h-8 w-8 animate-spin text-cyan-400"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <p className="mt-3 text-sm text-gray-500">
              Loading knowledge graph...
            </p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex flex-1 flex-col items-center justify-center">
            <svg
              className="mb-2 h-8 w-8 text-red-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 rounded-lg border border-gray-700 px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Graph visualization */}
        {!loading && !error && graph && (
          <>
            {/* SVG area */}
            <div className="relative flex-1 overflow-auto p-4">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                className="w-full h-full min-h-[500px] rounded-lg border border-gray-800 bg-gray-900/40"
                style={{ maxHeight: "calc(100vh - 200px)" }}
              >
                {/* Edges */}
                {filteredEdges.map((edge, i) => {
                  const source = nodeMap.get(edge.source);
                  const target = nodeMap.get(edge.target);
                  if (!source || !target) return null;

                  const edgeW = edge.weight ?? 1;
                  const strokeWidth = normalizeEdgeWeight(edgeW, minEdgeWeight, maxEdgeWeight);
                  const eKey = edgeKey(edge.source, edge.target);

                  // Pathfind mode coloring
                  const isOnPath = pathfindMode && pathNodeSet.size > 0 && pathEdgeKeySet.has(eKey);
                  const isDimmed = pathfindMode && pathNodeSet.size > 0 && !isOnPath;

                  // Normal selection highlight
                  const isHighlighted =
                    !pathfindMode &&
                    selectedNode &&
                    (edge.source === selectedNode.id || edge.target === selectedNode.id);

                  let stroke = "#374151";
                  let strokeOpacity = 0.4;
                  let sw = strokeWidth;

                  if (isOnPath) {
                    stroke = "#06b6d4"; // cyan for path
                    strokeOpacity = 1;
                    sw = Math.max(sw, 2.5);
                  } else if (isDimmed) {
                    stroke = "#374151";
                    strokeOpacity = 0.1;
                  } else if (isHighlighted) {
                    stroke = "#06b6d4";
                    strokeOpacity = 0.9;
                    sw = Math.max(sw, 2);
                  } else {
                    strokeOpacity = 0.4;
                  }

                  // Midpoint for label
                  const mx = (source.x + target.x) / 2;
                  const my = (source.y + target.y) / 2;

                  return (
                    <g key={`edge-${i}`}>
                      {/* Wider invisible hit area for hover */}
                      <line
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke="transparent"
                        strokeWidth={Math.max(sw + 8, 12)}
                        onMouseEnter={(e) => handleEdgeMouseEnter(e, edge)}
                        onMouseLeave={handleEdgeMouseLeave}
                        style={{ cursor: "pointer" }}
                      />
                      <line
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        stroke={stroke}
                        strokeWidth={sw}
                        strokeOpacity={strokeOpacity}
                        strokeLinecap="round"
                        onMouseEnter={(e) => handleEdgeMouseEnter(e, edge)}
                        onMouseLeave={handleEdgeMouseLeave}
                        style={{ cursor: "pointer" }}
                      />
                      {/* Weight label on path edges */}
                      {isOnPath && edgeW !== 1 && (
                        <text
                          x={mx}
                          y={my - 4}
                          textAnchor="middle"
                          fill="#06b6d4"
                          fontSize={9}
                          fontFamily="monospace"
                          opacity={0.8}
                        >
                          {edgeW.toFixed(1)}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Nodes */}
                {filteredNodes.map((node) => {
                  const isSelected = !pathfindMode && selectedNode?.id === node.id;
                  const isPathStart = pathfindMode && pathStart?.id === node.id;
                  const isPathEnd = pathfindMode && pathEnd?.id === node.id;
                  const isOnPath = pathfindMode && pathNodeSet.has(node.id);
                  const isDimmedNode = pathfindMode && pathNodeSet.size > 0 && !isOnPath;

                  const color = getNodeColor(node);

                  return (
                    <g
                      key={node.id}
                      className="cursor-pointer"
                      onClick={() => handleNodeClick(node)}
                    >
                      {/* Glow for selected / path endpoints */}
                      {(isSelected || isPathStart || isPathEnd) && (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={node.radius + 6}
                          fill="none"
                          stroke={isPathStart || isPathEnd ? "#06b6d4" : color}
                          strokeWidth={2}
                          strokeOpacity={0.5}
                        />
                      )}
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.radius}
                        fill={color}
                        fillOpacity={isDimmedNode ? 0.2 : isSelected || isOnPath ? 1 : 0.7}
                        stroke={
                          isPathStart
                            ? "#22d3ee"
                            : isPathEnd
                            ? "#22d3ee"
                            : isSelected
                            ? "#fff"
                            : color
                        }
                        strokeWidth={isSelected || isPathStart || isPathEnd ? 2 : 1}
                      />
                      {/* Label (only show for larger nodes or selected/path) */}
                      {(node.radius > 10 || isSelected || isOnPath) && (
                        <text
                          x={node.x}
                          y={node.y + node.radius + 12}
                          textAnchor="middle"
                          fill={isDimmedNode ? "#374151" : "#d1d5db"}
                          fontSize={10}
                          fontFamily="monospace"
                        >
                          {node.label.length > 16
                            ? node.label.slice(0, 14) + "..."
                            : node.label}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Empty state overlay */}
                {filteredNodes.length === 0 && (
                  <text
                    x={SVG_WIDTH / 2}
                    y={SVG_HEIGHT / 2}
                    textAnchor="middle"
                    fill="#6b7280"
                    fontSize={14}
                  >
                    No nodes visible. Adjust type filters above.
                  </text>
                )}
              </svg>

              {/* Edge hover tooltip */}
              {hoveredEdge && (
                <div
                  className="pointer-events-none absolute z-10 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 shadow-xl"
                  style={{
                    left: hoveredEdge.x + 12,
                    top: hoveredEdge.y - 10,
                  }}
                >
                  <p className="text-[11px] font-medium text-gray-200">
                    {hoveredEdge.edge.relationship}
                  </p>
                  <p className="text-[10px] text-gray-500">
                    Weight:{" "}
                    <span className="font-mono text-cyan-400">
                      {(hoveredEdge.edge.weight ?? 1).toFixed(2)}
                    </span>
                  </p>
                </div>
              )}
            </div>

            {/* Sidebar: Node detail + Threat Intelligence */}
            <div className="w-72 shrink-0 border-l border-gray-800 overflow-y-auto">
              {/* Threat Graph Intelligence Panel */}
              {threatIntel && (threatIntel.node_count > 0 || threatIntel.nodes?.length > 0) && (
                <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 m-3">
                  <h3 className="text-xs font-bold text-white mb-2 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    Threat Entity Intelligence
                  </h3>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="rounded-md border border-gray-800/50 bg-gray-900/60 px-2 py-1.5 text-center">
                      <p className="text-lg font-bold text-white tabular-nums">{threatIntel.node_count ?? threatIntel.nodes?.length ?? 0}</p>
                      <p className="text-[8px] text-gray-500 uppercase">Entities</p>
                    </div>
                    <div className="rounded-md border border-gray-800/50 bg-gray-900/60 px-2 py-1.5 text-center">
                      <p className="text-lg font-bold text-white tabular-nums">{threatIntel.edge_count ?? threatIntel.edges?.length ?? 0}</p>
                      <p className="text-[8px] text-gray-500 uppercase">Relationships</p>
                    </div>
                    <div className="rounded-md border border-red-800/30 bg-red-900/10 px-2 py-1.5 text-center">
                      <p className="text-lg font-bold text-red-400 tabular-nums">
                        {(threatIntel.nodes || []).filter((n: any) => n.risk_level === "high" || n.risk_level === "critical").length}
                      </p>
                      <p className="text-[8px] text-red-500/70 uppercase">High Risk</p>
                    </div>
                  </div>

                  {/* High-risk entities list */}
                  {(() => {
                    const highRisk = (threatIntel.nodes || []).filter((n: any) => n.risk_level === "high" || n.risk_level === "critical");
                    if (highRisk.length === 0) return null;
                    return (
                      <div className="space-y-1 mb-2">
                        <p className="text-[8px] font-bold uppercase tracking-wider text-red-500">High Risk Entities</p>
                        {highRisk.slice(0, 5).map((entity: any) => (
                          <div key={entity.entity_id} className="flex items-center gap-2 rounded-md border border-red-800/20 bg-red-900/5 px-2 py-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                            <span className="text-[10px] text-gray-300 flex-1 truncate">{entity.entity_id}</span>
                            <span className="text-[8px] text-gray-500">{entity.entity_type}</span>
                            <span className="text-[8px] font-bold text-red-400">{Math.round(entity.risk_score * 100)}%</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Entity labels/tags */}
                  {(() => {
                    const allLabels: string[] = (threatIntel.nodes || []).flatMap((n: any) => n.labels || []);
                    const uniqueLabels: string[] = [...new Set(allLabels)];
                    if (uniqueLabels.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-1 pt-2 border-t border-gray-800/30">
                        {uniqueLabels.slice(0, 8).map((label: string) => (
                          <span key={label} className="rounded-full border border-gray-700/50 bg-gray-800/40 px-2 py-0.5 text-[8px] text-gray-400">
                            {label}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Pathfind result summary */}
              {pathfindMode && pathNodeSet.size > 0 && pathStart && pathEnd && (
                <div className="m-3 rounded-lg border border-cyan-800/50 bg-cyan-950/20 p-3">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 mb-2">
                    Shortest Path
                  </h4>
                  <div className="flex items-center gap-1.5 text-xs text-gray-300 mb-1">
                    <span className="font-medium text-cyan-300">{pathStart.label}</span>
                    <span className="text-gray-600">→</span>
                    <span className="font-medium text-cyan-300">{pathEnd.label}</span>
                  </div>
                  <p className="text-[10px] text-gray-500">
                    {pathNodeSet.size} nodes, {pathEdgeKeySet.size} edges
                  </p>
                </div>
              )}

              {selectedNode && !pathfindMode ? (
                <div className="p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-gray-100 mb-1">
                      {selectedNode.label}
                    </h3>
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{
                          backgroundColor: getNodeColor(selectedNode),
                        }}
                      />
                      <span className="text-xs text-gray-400 capitalize">
                        {selectedNode.type}
                      </span>
                      {showCommunities && communityMap && (
                        <span className="text-[10px] text-purple-400">
                          Community {(communityMap.get(selectedNode.id) ?? 0) + 1}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 space-y-1">
                      <div>
                        <span className="text-gray-600">ID:</span>{" "}
                        <span className="font-mono text-gray-400">
                          {selectedNode.id.slice(0, 12)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-600">Weight:</span>{" "}
                        <span className="font-mono text-cyan-400">
                          {selectedNode.weight.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Connected edges */}
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                      Connections ({connectedEdges.length})
                    </h4>
                    {connectedEdges.length === 0 ? (
                      <p className="text-xs text-gray-600">
                        No connections found
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {connectedEdges.map((edge, i) => {
                          const otherId =
                            edge.source === selectedNode.id
                              ? edge.target
                              : edge.source;
                          const otherNode = nodeMap.get(otherId);
                          const edgeW = edge.weight ?? 1;
                          const strokeWidth = normalizeEdgeWeight(
                            edgeW,
                            minEdgeWeight,
                            maxEdgeWeight
                          );
                          return (
                            <div
                              key={i}
                              className="rounded border border-gray-800 bg-gray-900/60 p-2 cursor-pointer hover:bg-gray-800/60 transition-colors"
                              onClick={() => {
                                if (otherNode) setSelectedNode(otherNode);
                              }}
                            >
                              <div className="flex items-center gap-1.5 mb-0.5">
                                {otherNode && (
                                  <span
                                    className="inline-block h-2 w-2 rounded-full"
                                    style={{
                                      backgroundColor: getNodeColor(otherNode),
                                    }}
                                  />
                                )}
                                <span className="text-xs text-gray-300 truncate">
                                  {otherNode?.label || otherId.slice(0, 8)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-gray-500 capitalize">
                                  {edge.relationship}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  {/* Visual stroke preview */}
                                  <div
                                    className="rounded bg-gray-400 opacity-50"
                                    style={{
                                      width: 20,
                                      height: Math.max(1, Math.round(strokeWidth / 2)),
                                    }}
                                  />
                                  <span className="text-[10px] font-mono text-gray-600">
                                    w:{edgeW.toFixed(1)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                !pathfindMode && (
                  <div className="flex flex-col items-center justify-center h-full text-center px-4">
                    <svg
                      className="h-8 w-8 text-gray-700 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5"
                      />
                    </svg>
                    <p className="text-xs text-gray-600">
                      Click a node to view details
                    </p>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
