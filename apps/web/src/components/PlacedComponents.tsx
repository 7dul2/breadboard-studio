import { useMemo } from 'react';
import { groupHoles } from '@breadboard-studio/core';
import { wireColor } from '@breadboard-studio/render';
import { analysisOf, useStore } from '../store';

/**
 * 「已选元件」：把图里已经放好的每块板/每个元件列成可点的清单。
 *
 * 存在的理由是命中率：小如 6×6 轻触开关、或者被导线压住的引脚，在画布上
 * 很难戳中。清单里点名字就能选中并把视图移过去，不需要跟图形较劲。
 * 展开后还能逐引脚、逐导线点选 —— 这也是「这根黑线到底接到哪」的正向查法。
 *
 * 归属判断用的是**板内导通组**（同一列 a–e / f–j 上的孔电气上是一根线），
 * 不是"端点地址 == 引脚孔地址"：导线插的通常是同一列里旁边的空孔，
 * 靠地址相等会一根都匹配不上。
 */
export function PlacedComponents() {
  const design = useStore((s) => s.design);
  const selectedIds = useStore((s) => s.selectedIds);
  const analysis = useMemo(() => analysisOf(design), [design]);
  const model = analysis.model;

  const orders = useMemo(() => {
    const sorted = [...model.wires.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }));
    return new Map(sorted.map((w, i) => [w.instance.id, i + 1]));
  }, [model]);

  /** 地址（孔或端子）→ 插在这里的导线。 */
  const wiresAt = useMemo(() => {
    const m = new Map<string, { id: string; no: number; color: string }[]>();
    for (const w of model.wires.values()) {
      for (const ep of [w.from, w.to]) {
        if (!ep) continue;
        m.set(ep.address, [...(m.get(ep.address) ?? []), { id: w.instance.id, no: orders.get(w.instance.id) ?? 0, color: w.instance.color }]);
      }
    }
    return m;
  }, [model, orders]);

  const selected = new Set(selectedIds);
  const focus = (bounds: { x: number; y: number; w: number; h: number }) => {
    (window as unknown as { __bbsCanvas?: { centerOn?: (b: { x: number; y: number; w: number; h: number }) => void } }).__bbsCanvas?.centerOn?.(bounds);
  };
  const st = useStore.getState();

  /** 一个引脚在电气上可用的全部孔（含同列导通组）。 */
  const holesOf = (address: string): string[] => (model.boards.has(address.split('.')[0] ?? '') ? groupHoles(model, address) : [address]);

  const boards = [...model.boards.values()];
  const comps = [...model.components.values()];

  if (!boards.length && !comps.length) {
    return (
      <div className="placed">
        <div className="panel-title">已选元件</div>
        <p className="muted placed-empty">画布上还没有东西。先到「元件库」放一块面包板或一个元件。</p>
      </div>
    );
  }

  const boardItem = (pb: (typeof boards)[number]) => {
    const on = selected.has(pb.instance.id);
    const holes = pb.def.terminal_blocks.reduce((n, b) => n + b.columns * b.rows.length, 0) + pb.def.rails.reduce((n, r) => n + r.holes, 0);
    return (
      <button
        key={pb.instance.id}
        className={`placed-item ${on ? 'active' : ''}`}
        data-testid={`placed-${pb.instance.id}`}
        title="点一下：选中并移到视图中央"
        onClick={() => {
          st.select([pb.instance.id]);
          focus(pb.bounds);
        }}
      >
        <span className="placed-name">{pb.instance.name ?? pb.instance.id}</span>
        <span className="placed-meta">
          {pb.instance.id} · {pb.def.name} · {holes} 孔
        </span>
      </button>
    );
  };

  return (
    <div className="placed">
      <div className="panel-title">已选元件</div>
      <div className="placed-list">
        {boards.length > 0 && (
          <>
            <div className="lib-cat">面包板</div>
            {boards.map(boardItem)}
          </>
        )}
        {comps.length > 0 && <div className="lib-cat">元件</div>}
        {comps.map((pc) => {
          const on = selected.has(pc.instance.id);
          const anchor = pc.instance.placement.kind === 'board' ? `${pc.instance.placement.board_id}.${pc.instance.placement.anchor_hole}` : '板外';
          /** 这个元件所有引脚电气上覆盖到的孔。 */
          const ownHoles = new Set<string>();
          for (const pin of pc.pins) {
            if (!pin.hole) continue;
            for (const h of holesOf(`${pin.hole.board_id}.${pin.hole.hole}`)) ownHoles.add(h);
          }
          const mine = [...model.wires.values()].filter((w) => [w.from, w.to].some((ep) => ep && ownHoles.has(ep.address)));
          return (
            <div key={pc.instance.id} className={`placed-block ${on ? 'active' : ''}`}>
              <button
                className={`placed-item ${on ? 'active' : ''}`}
                data-testid={`placed-${pc.instance.id}`}
                title="点一下：选中并移到视图中央"
                onClick={() => {
                  st.select([pc.instance.id]);
                  focus(pc.bounds);
                }}
              >
                <span className="placed-name">
                  {pc.instance.name ?? pc.instance.id}
                  {pc.instance.locked && ' 🔒'}
                </span>
                <span className="placed-meta">
                  {pc.instance.id} · {pc.pins.length} 脚 · {anchor} · 线 {mine.length}
                </span>
              </button>
              {on && (
                <div className="placed-detail">
                  <div className="placed-sub">引脚（点一下高亮，画布会移过去）</div>
                  <div className="placed-pins">
                    {pc.pins.map((pin) => {
                      const hole = pin.hole ? `${pin.hole.board_id}.${pin.hole.hole}` : null;
                      const wires = hole ? holesOf(hole).flatMap((h) => wiresAt.get(h) ?? []) : [];
                      return (
                        <button
                          key={pin.name}
                          className={`pin-chip ${wires.length ? 'wired' : ''}`}
                          data-testid={`pin-${pc.instance.id}-${pin.name}`}
                          title={wires.length ? `${hole} · 接 ${wires.map((w) => `#${w.no} ${w.color}`).join('、')}` : `${hole ?? '未落孔（板外端子）'} · 没接线`}
                          onClick={() => {
                            // setHighlight 会拿 objects 反推 selectedIds，所以元件要放进第二个参数；
                            // 先 select 再 setHighlight 只会被后者清掉。
                            st.setHighlight([`${pc.instance.id}.${pin.name}`], [pc.instance.id]);
                            focus({ x: pin.global_um[0] - 6000, y: pin.global_um[1] - 6000, w: 12000, h: 12000 });
                          }}
                        >
                          <span className="pin-chip-name">{pin.name}</span>
                          <span className="pin-chip-hole">{hole ?? '—'}</span>
                        </button>
                      );
                    })}
                  </div>
                  {mine.length > 0 && (
                    <>
                      <div className="placed-sub">接在它身上的导线</div>
                      <div className="placed-wires">
                        {mine.map((w) => (
                          <button
                            key={w.instance.id}
                            className="wire-chip"
                            data-testid={`wire-chip-${w.instance.id}`}
                            title={`${w.instance.id}：${w.from?.address ?? '?'} → ${w.to?.address ?? '?'}（点一下选中，两端会对上）`}
                            onClick={() => {
                              st.select([w.instance.id]);
                              const xs = w.points.map((q) => q[0]);
                              const ys = w.points.map((q) => q[1]);
                              focus({
                                x: Math.min(...xs) - 6000,
                                y: Math.min(...ys) - 6000,
                                w: Math.max(...xs) - Math.min(...xs) + 12000,
                                h: Math.max(...ys) - Math.min(...ys) + 12000
                              });
                            }}
                          >
                            <span className="wire-no small" style={{ borderColor: wireColor(w.instance.color) }}>{orders.get(w.instance.id) ?? '?'}</span>
                            <span className="wire-chip-text">
                              {w.from?.address ?? '?'} → {w.to?.address ?? '?'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="panel-footer muted">
        已选：{selectedIds.length ? selectedIds.join('、') : '无'} · 点条目即可选中并居中
      </div>
    </div>
  );
}
