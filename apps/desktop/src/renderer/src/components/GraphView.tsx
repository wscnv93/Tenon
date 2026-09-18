import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { api } from "../lib/api";
import type { FileGraph, FileGraphEdge, FileGraphNode } from "@protocol/ipc";
import { activeProjectAtom, reviewFocusAtom, rightTabAtom } from "../state";

const LANG_COLOR: Record<string, string> = {
  typescript: "#4db695",
  tsx: "#6ac2d8",
  javascript: "#e8b84b",
  python: "#8fa4ff",
  go: "#7ad3d3",
  rust: "#e28f5c",
};
const langColor = (language: string): string => LANG_COLOR[language] ?? "#99a1ac";
const MAX_NODES = 150;

interface LaidNode extends FileGraphNode {
  id: number;
  x: number;
  y: number;
  degree: number;
}

/**
 * Dependency-free force layout (repulsion + springs + centering), computed
 * once per graph. Supports zoom (wheel) and pan (drag).
 */
function layout(nodes: FileGraphNode[], edges: FileGraphEdge[]): { laid: LaidNode[]; edges: Array<{ src: LaidNode; dst: LaidNode; weight: number }>; width: number; height: number } {
  const width = 900;
  const height = 640;
  const sorted = [...nodes]
    .map((node) => ({ ...node, degree: 0 }))
    .sort((a, b) => b.nodeCount - a.nodeCount)
    .slice(0, MAX_NODES);
  const keep = new Set(sorted.map((node) => node.path));

  const laid: LaidNode[] = sorted.map((node, i) => {
    const angle = (i / sorted.length) * Math.PI * 2;
    return {
      ...node,
      id: i,
      x: width / 2 + Math.cos(angle) * (width / 3),
      y: height / 2 + Math.sin(angle) * (height / 3),
      degree: 0,
    };
  });
  const byPath = new Map(laid.map((node) => [node.path, node]));

  const springs = edges
    .map((edge) => ({ src: byPath.get(edge.src), dst: byPath.get(edge.dst), weight: edge.weight }))
    .filter((spring): spring is { src: LaidNode; dst: LaidNode; weight: number } => Boolean(spring.src && spring.dst));
  for (const spring of springs) {
    spring.src.degree += spring.weight;
    spring.dst.degree += spring.weight;
  }

  const REPULSION = 2400;
  const SPRING_K = 0.012;
  const CENTER = 0.015;
  for (let iter = 0; iter < 260; iter++) {
    const cooling = 1 - iter / 300;
    for (let i = 0; i < laid.length; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        const a = laid[i]!;
        const b = laid[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          distSq = 1;
        }
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.x += fx * cooling * 0.02;
        a.y += fy * cooling * 0.02;
        b.x -= fx * cooling * 0.02;
        b.y -= fy * cooling * 0.02;
      }
    }
    for (const spring of springs) {
      const dx = spring.dst.x - spring.src.x;
      const dy = spring.dst.y - spring.src.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const rest = 90 + 30 * Math.log2(1 + spring.weight);
      const force = (dist - rest) * SPRING_K;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      spring.src.x += fx * cooling;
      spring.src.y += fy * cooling;
      spring.dst.x -= fx * cooling;
      spring.dst.y -= fy * cooling;
    }
    for (const node of laid) {
      node.x += (width / 2 - node.x) * CENTER * cooling;
      node.y += (height / 2 - node.y) * CENTER * cooling;
    }
  }
  // Normalize into the canvas with padding.
  const xs = laid.map((node) => node.x);
  const ys = laid.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min((width - 80) / Math.max(1, maxX - minX), (height - 80) / Math.max(1, maxY - minY));
  for (const node of laid) {
    node.x = 40 + (node.x - minX) * scale;
    node.y = 40 + (node.y - minY) * scale;
  }
  return { laid, edges: springs, width, height };
}

export function GraphView({ onClose }: { onClose: () => void }) {
  const project = useAtomValue(activeProjectAtom);
  const [graph, setGraph] = useState<FileGraph | null>(null);
  const [filter, setFilter] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const setRightTab = useSetAtom(rightTabAtom);
  const setReviewFocus = useSetAtom(reviewFocusAtom);

  useEffect(() => {
    if (!project) return;
    void api.fileGraph(project.path).then((result) => setGraph(result as FileGraph));
  }, [project?.path]);

  const filtered = useMemo(() => {
    if (!graph) return graph;
    if (!filter.trim()) return graph;
    const q = filter.toLowerCase();
    const nodes = graph.nodes.filter((node) => node.path.toLowerCase().includes(q));
    const keep = new Set(nodes.map((node) => node.path));
    const edges = graph.edges.filter((edge) => keep.has(edge.src) && keep.has(edge.dst));
    return { nodes, edges, indexed: graph.indexed };
  }, [graph, filter]);

  const { laid, edges, width, height } = useMemo(
    () => (filtered && filtered.nodes.length > 0 ? layout(filtered.nodes, filtered.edges) : { laid: [], edges: [], width: 900, height: 640 }),
    [filtered],
  );

  const neighbors = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const edge of edges) {
      if (edge.src.path === hover) set.add(edge.dst.path);
      if (edge.dst.path === hover) set.add(edge.src.path);
    }
    return set;
  }, [hover, edges]);

  const jumpTo = (path: string): void => {
    setRightTab("review");
    setReviewFocus(path);
  };

  return (
    <div className="graph-view">
      <div className="review-toolbar">
        <button type="button" className="chip" onClick={onClose}>
          ← 文件列表
        </button>
        <input
          className="graph-filter"
          value={filter}
          placeholder="按路径过滤…"
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="review-totals">
          {laid.length} 文件 · {edges.length} 依赖
          {graph && graph.nodes.length > MAX_NODES && " (按符号数取前 150)"}
        </span>
      </div>
      {graph && !graph.indexed && (
        <div className="pane-empty">
          此项目还没有代码图谱
          <br />
          <span className="pane-empty-sub">与 agent 对话一轮后会自动建图(codegraph init),然后再点关系图</span>
        </div>
      )}
      {graph?.indexed && laid.length === 0 && <div className="pane-empty">没有匹配的文件</div>}
      {laid.length > 0 && (
        <div
          className="graph-canvas"
          onWheel={(event) => {
            event.preventDefault();
            setZoom((z) => Math.min(4, Math.max(0.3, z * (event.deltaY < 0 ? 1.1 : 0.9))));
          }}
          onPointerDown={(event) => {
            dragRef.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragRef.current) setPan({ x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y });
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        >
          <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} style={{ userSelect: "none" }}>
            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              {edges.map((edge, i) => {
                const dim = hover && !(neighbors?.has(edge.src.path) && neighbors.has(edge.dst.path));
                return (
                  <line
                    key={i}
                    x1={edge.src.x}
                    y1={edge.src.y}
                    x2={edge.dst.x}
                    y2={edge.dst.y}
                    className={`graph-edge ${dim ? "dim" : ""}`}
                    strokeWidth={Math.min(3, 0.4 + edge.weight * 0.3)}
                  />
                );
              })}
              {laid.map((node) => {
                const dim = hover && !neighbors?.has(node.path);
                const r = 4 + Math.min(8, Math.log2(1 + node.degree));
                return (
                  <g
                    key={node.path}
                    transform={`translate(${node.x},${node.y})`}
                    className={`graph-node ${dim ? "dim" : ""}`}
                    onMouseEnter={() => setHover(node.path)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => jumpTo(node.path)}
                  >
                    <circle r={r} fill={langColor(node.language)}>
                      <title>{`${node.path}\n${node.language} · ${node.nodeCount} 符号\n点击在检视中打开`}</title>
                    </circle>
                    {(hover === node.path || node.degree > 12) && (
                      <text x={r + 4} y={3} className="graph-label">
                        {node.path.split("/").at(-1)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          <div className="graph-legend">
            {Object.entries(LANG_COLOR).map(([lang, color]) => (
              <span key={lang}>
                <span className="graph-legend-dot" style={{ background: color }} /> {lang}
              </span>
            ))}
            <span className="graph-legend-hint">滚轮缩放 · 拖拽平移 · 点击文件跳检视</span>
          </div>
        </div>
      )}
    </div>
  );
}
