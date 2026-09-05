import type { DesignModel } from '@breadboard-studio/core';
import { buildScene, wireColor, type Scene, type SceneNode, type SceneOptions } from './scene.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrs(o: Record<string, string | number | undefined>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
}

function dataAttrs(d?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (d) for (const [k, v] of Object.entries(d)) out[`data-${k}`] = v;
  return out;
}

export function nodeToSvg(n: SceneNode): string {
  const common = { class: n.cls, opacity: n.opacity, ...dataAttrs(n.data) };
  switch (n.t) {
    case 'rect':
      return `<rect${attrs({ x: n.x, y: n.y, width: n.w, height: n.h, rx: n.rx, fill: n.fill ?? 'none', stroke: n.stroke, 'stroke-width': n.sw, 'stroke-dasharray': n.dash, ...common })}/>`;
    case 'circle':
      return `<circle${attrs({ cx: n.cx, cy: n.cy, r: n.r, fill: n.fill ?? 'none', stroke: n.stroke, 'stroke-width': n.sw, ...common })}/>`;
    case 'text': {
      const transform = n.rotate ? `rotate(${n.rotate} ${n.x} ${n.y})` : undefined;
      return `<text${attrs({ x: n.x, y: n.y, 'font-size': n.size, fill: n.fill ?? '#111', 'text-anchor': n.anchor ?? 'start', 'font-weight': n.weight, 'font-family': n.family ?? 'system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif', transform, ...common })}>${esc(n.text)}</text>`;
    }
    case 'path':
      return `<path${attrs({ d: n.d, fill: n.fill ?? 'none', stroke: n.stroke, 'stroke-width': n.sw, ...common })}/>`;
    case 'line':
      return `<line${attrs({ x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2, stroke: n.stroke, 'stroke-width': n.sw, 'stroke-dasharray': n.dash, ...common })}/>`;
    case 'polyline':
      return `<polyline${attrs({ points: n.points.map((p) => `${p[0]},${p[1]}`).join(' '), fill: 'none', stroke: n.stroke, 'stroke-width': n.sw, 'stroke-dasharray': n.dash, 'stroke-linecap': n.linecap, 'stroke-linejoin': 'round', ...common })}/>`;
    case 'group':
      return `<g${attrs({ id: n.id, transform: n.transform, ...common })}>${n.children.map(nodeToSvg).join('')}</g>`;
  }
}

export interface ExportOptions extends SceneOptions {
  /** Margin around the design in mm. */
  margin?: number;
  legend?: boolean;
  title?: string;
  /** Pixel width hint (SVG keeps mm units in the viewBox; width/height are set in px). */
  pxPerMm?: number;
}

function legendNodes(model: DesignModel, x: number, y: number): { nodes: SceneNode[]; height: number } {
  const nodes: SceneNode[] = [];
  const wires = [...model.wires.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }));
  const unverified = [...model.components.values()].filter((c) => c.def.geometry_status !== 'verified' || c.def.electrical_status !== 'verified').map((c) => c.instance.name ?? c.instance.id);
  const rowH = 3.4;
  let cy = y;
  nodes.push({ t: 'text', x, y: cy, text: `图例：${wires.length} 根导线（线号 = 搭建顺序）`, size: 2.4, fill: '#111827', weight: 'bold' });
  cy += rowH + 0.5;
  wires.forEach((rw, i) => {
    const w = rw.instance;
    nodes.push({ t: 'circle', cx: x + 1.5, cy: cy - 0.8, r: 1.3, fill: '#fff', stroke: wireColor(w.color), sw: 0.3 });
    nodes.push({ t: 'text', x: x + 1.5, y: cy - 0.25, text: String(i + 1), size: 1.5, fill: '#111827', anchor: 'middle', weight: 'bold', family: 'monospace' });
    nodes.push({ t: 'line', x1: x + 4, y1: cy - 0.8, x2: x + 10, y2: cy - 0.8, stroke: wireColor(w.color), sw: 1, dash: w.route === 'elevated' ? '2 1' : undefined });
    const from = rw.from?.address ?? '?';
    const to = rw.to?.address ?? '（草稿）';
    const len = rw.to ? `${(rw.length_um / 1000).toFixed(1)} mm` : '';
    nodes.push({ t: 'text', x: x + 12, y: cy, text: `${w.name ?? w.id} · ${w.color}${w.route === 'elevated' ? '（软线）' : ''} · ${from} → ${to} · ${len}`, size: 2, fill: '#1f2937' });
    cy += rowH;
  });
  cy += 1;
  nodes.push({ t: 'text', x, y: cy, text: '走线长度为图上折线估算，不含插入深度、弯折与连接器余量。', size: 1.8, fill: '#6b7280' });
  cy += rowH;
  if (unverified.length) {
    nodes.push({ t: 'text', x, y: cy, text: `⚠ 未经实测的模型：${unverified.join('、')}（几何/电气状态见徽标）`, size: 1.8, fill: '#92400e' });
    cy += rowH;
  }
  nodes.push({ t: 'text', x, y: cy, text: '本图为规划图，不代表已验证的电气结果。', size: 1.8, fill: '#6b7280' });
  cy += rowH;
  return { nodes, height: cy - y };
}

/** Standalone SVG document of the whole design with legend. Nothing is clipped: the viewBox is computed from content. */
export function exportSvg(model: DesignModel, options: ExportOptions = {}): string {
  const margin = options.margin ?? 8;
  const scene: Scene = buildScene(model, { showUnverifiedBadges: true, showPinLabels: true, showUprightGhost: true, ...options });
  const b = scene.bounds;
  // Extra room for labels drawn outside bodies.
  const contentX = b.x - margin;
  const contentY = b.y - margin - 4;
  const contentW = b.w + margin * 2;
  let contentH = b.h + margin * 2 + 4;
  const extra: SceneNode[] = [];
  if (options.title) {
    extra.push({ t: 'text', x: contentX + 2, y: contentY + 3.5, text: options.title, size: 3.2, fill: '#111827', weight: 'bold' });
  }
  if (options.legend !== false) {
    const lg = legendNodes(model, contentX + 2, contentY + contentH + 4);
    extra.push(...lg.nodes);
    contentH += lg.height + 8;
  }
  const pxPerMm = options.pxPerMm ?? 6;
  const width = Math.ceil(contentW * pxPerMm);
  const height = Math.ceil(contentH * pxPerMm);
  const body = [...scene.nodes, ...extra].map(nodeToSvg).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${contentX} ${contentY} ${contentW} ${contentH}" width="${width}" height="${height}" font-family="system-ui, -apple-system, 'PingFang SC', 'Noto Sans CJK SC', sans-serif">
<title>${esc(options.title ?? model.design.metadata.name)}</title>
<desc>Generated by Breadboard Studio. Units: millimetres. Planning drawing, not an electrical verification.</desc>
<rect x="${contentX}" y="${contentY}" width="${contentW}" height="${contentH}" fill="#ffffff"/>
${body}
</svg>
`;
}
