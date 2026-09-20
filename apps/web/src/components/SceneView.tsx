import React from 'react';
import type { SceneNode } from '@breadboard-studio/render';

const FONT = 'system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';

function dataProps(d?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (d) for (const [k, v] of Object.entries(d)) out[`data-${k}`] = v;
  return out;
}

export function renderNode(n: SceneNode, key: React.Key): React.ReactNode {
  const common = { className: n.cls, opacity: n.opacity, ...dataProps(n.data) };
  switch (n.t) {
    case 'rect':
      return <rect key={key} x={n.x} y={n.y} width={n.w} height={n.h} rx={n.rx} fill={n.fill ?? 'none'} stroke={n.stroke} strokeWidth={n.sw} strokeDasharray={n.dash} {...common} />;
    case 'circle':
      return <circle key={key} cx={n.cx} cy={n.cy} r={n.r} fill={n.fill ?? 'none'} stroke={n.stroke} strokeWidth={n.sw} {...common} />;
    case 'text': {
      // 焊接面（R2.3）：`unmirrorX` 让文字绕自身锚点再翻一次，抵消父级的板镜像 —— 位置
      // 仍然跟着板走，字却正着读。放在最内层（字符串最右），先作用于字形本身。
      const transforms: string[] = [];
      if (n.rotate) transforms.push(`rotate(${n.rotate} ${n.x} ${n.y})`);
      if (n.unmirrorX) transforms.push(`translate(${n.x} ${n.y}) scale(-1 1) translate(${-n.x} ${-n.y})`);
      return (
        <text key={key} x={n.x} y={n.y} fontSize={n.size} fill={n.fill ?? '#111'} textAnchor={n.anchor ?? 'start'} fontWeight={n.weight} fontFamily={n.family ?? FONT} transform={transforms.length ? transforms.join(' ') : undefined} style={{ pointerEvents: 'none', userSelect: 'none' }} {...common}>
          {n.text}
        </text>
      );
    }
    case 'path':
      return <path key={key} d={n.d} fill={n.fill ?? 'none'} stroke={n.stroke} strokeWidth={n.sw} {...common} />;
    case 'line':
      return <line key={key} x1={n.x1} y1={n.y1} x2={n.x2} y2={n.y2} stroke={n.stroke} strokeWidth={n.sw} strokeDasharray={n.dash} {...common} />;
    case 'polyline':
      return <polyline key={key} points={n.points.map((p) => `${p[0]},${p[1]}`).join(' ')} fill="none" stroke={n.stroke} strokeWidth={n.sw} strokeDasharray={n.dash} strokeLinecap={n.linecap as 'round' | undefined} strokeLinejoin="round" {...common} />;
    case 'group':
      return (
        <g key={key} id={n.id} transform={n.transform} {...common}>
          {n.children.map((c, i) => renderNode(c, i))}
        </g>
      );
  }
}

export const SceneNodes = React.memo(function SceneNodes({ nodes }: { nodes: SceneNode[] }) {
  return <>{nodes.map((n, i) => renderNode(n, n.t === 'group' && n.id ? n.id : i))}</>;
});
