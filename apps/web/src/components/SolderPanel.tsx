import { useMemo } from 'react';
import type { SolderBridgeInstance } from '@breadboard-studio/schema';
import { isSolderableBoard, parseAddress, type Op } from '@breadboard-studio/core';
import { analysisOf, useStore } from '../store';

/**
 * R1.2：右栏「焊接」面板。焊接工作流的后台视图——不需要切换工具也能看：
 * 选中焊盘的详情（含占用者说明 R1.5）、焊接进度、待焊清单、已有焊锡桥。
 * 只在设计里有洞洞板时挂载（App 控制），所以这里不处理空目录的情况。
 */
export function SolderPanel() {
  const design = useStore((s) => s.design);
  const selectedHole = useStore((s) => s.selectedHole);
  const { select, selectHole, setTool, setWireDraft, apply } = useStore.getState();

  const model = analysisOf(design).model;

  /** 洞洞板上的所有引脚（元件.引脚 → 焊盘地址），按元件排序保证清单稳定。 */
  const pads = useMemo(() => {
    const list: { comp: string; compName: string; pin: string; hole: string }[] = [];
    for (const pc of [...model.components.values()].sort((a, b) => a.instance.id.localeCompare(b.instance.id, undefined, { numeric: true }))) {
      for (const p of pc.pins) {
        if (!p.hole) continue;
        if (!isSolderableBoard(model, p.hole.board_id)) continue;
        list.push({ comp: pc.instance.id, compName: pc.instance.name || pc.instance.id, pin: p.name, hole: `${p.hole.board_id}.${p.hole.hole}` });
      }
    }
    return list;
  }, [model]);

  /** 已焊 = 焊盘上有导线或焊锡桥碰到（插进去只是"放好"，接上才算焊完）。 */
  const solderedCount = pads.filter((x) => {
    const hs = model.holes.get(x.hole);
    return !!hs && (hs.wires.length > 0 || hs.bridges.length > 0);
  }).length;
  const pending = pads.filter((x) => {
    const hs = model.holes.get(x.hole);
    return !!hs && hs.wires.length === 0 && hs.bridges.length === 0;
  });

  const bridges: SolderBridgeInstance[] = design.solder_bridges ?? [];

  /** 选中焊盘是否在洞洞板上（在才显示详情；板外端子走属性面板）。 */
  const holeOwner = selectedHole ? parseAddress(selectedHole)?.owner : undefined;
  const holeOnPerfboard = !!(holeOwner && model.boards.get(holeOwner) && isSolderableBoard(model, holeOwner));
  const hs = selectedHole && holeOnPerfboard ? model.holes.get(selectedHole) : undefined;

  const statusText = (() => {
    if (!hs) return null;
    if (hs.bridges.length) return `已桥接（${hs.bridges.join('、')}）`;
    if (hs.status === 'occupied') return hs.component_id && hs.pin ? `已焊（${hs.component_id}.${hs.pin}）` : '已焊';
    if (hs.wires.length) return `已接线（${hs.wires.join('、')}）`;
    if (hs.status === 'blocked') return '被板体遮挡';
    return '空闲';
  })();

  return (
    <div className="panel-body" data-testid="solder-panel">
      {selectedHole && holeOnPerfboard && (
        <section className="panel-section" data-testid="solder-selected">
          <h3>选中焊盘</h3>
          <div className="solder-hole-head">
            <strong>{selectedHole}</strong>
            <span className={`solder-status solder-status-${hs?.status ?? 'free'}`}>{statusText}</span>
          </div>
          {/* R1.5：点到已占用焊盘时说明占用者——不是报错，是"这里插着谁"。 */}
          {hs?.component_id && (
            <button
              className="solder-link"
              onClick={() => select([hs.component_id!])}
              data-testid="solder-occupier"
            >
              占用者：{hs.component_id}.{hs.pin ?? '?'}（点击选中元件）
            </button>
          )}
          <div className="solder-actions">
            <button onClick={() => { setTool('wire'); setWireDraft({ from: { hole: selectedHole } }); }}>从此孔开始接线</button>
            <button onClick={() => { select([]); selectHole(null); }}>清除选中</button>
          </div>
        </section>
      )}

      <section className="panel-section" data-testid="solder-progress">
        <h3>焊接进度</h3>
        {pads.length === 0 ? (
          <p className="solder-empty">没有元件插在洞洞板上。</p>
        ) : (
          <>
            <div className="solder-progress-row">
              <span>{solderedCount}/{pads.length} 引脚已连接</span>
              <span>{Math.round((solderedCount / pads.length) * 100)}%</span>
            </div>
            <div className="solder-progress-bar" role="progressbar" aria-valuenow={solderedCount} aria-valuemin={0} aria-valuemax={pads.length}>
              <div className="solder-progress-fill" style={{ width: `${(solderedCount / pads.length) * 100}%` }} />
            </div>
          </>
        )}
      </section>

      <section className="panel-section" data-testid="solder-pending">
        <h3>待焊清单{solderedCount < pads.length ? `（${pads.length - solderedCount}）` : ''}</h3>
        {pending.length === 0 ? (
          <p className="solder-empty">{pads.length ? '全部引脚都已连接。' : '把元件插到洞洞板上，清单会出现在这里。'}</p>
        ) : (
          <ul className="solder-list">
            {pending.map((x) => (
              <li key={`${x.comp}.${x.pin}`}>
                <button
                  className="solder-link"
                  onClick={() => { select([x.comp]); selectHole(x.hole); }}
                  title="定位并高亮该焊盘与该元件"
                  data-testid={`solder-pending-${x.comp}-${x.pin}`}
                >
                  {x.compName}.{x.pin} → {x.hole}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section" data-testid="solder-bridges">
        <h3>焊锡桥{bridges.length ? `（${bridges.length}）` : ''}</h3>
        {bridges.length === 0 ? (
          <p className="solder-empty">还没有焊锡桥。切到「焊接」工具，拖动两个相邻焊盘建立桥接。</p>
        ) : (
          <ul className="solder-list">
            {bridges.map((b) => {
              const rb = model.bridges.get(b.id);
              return (
                <li key={b.id}>
                  <button className="solder-link" onClick={() => { select([]); selectHole(b.a); }} title="定位并高亮桥接的一端">
                    {b.a} ↔ {b.b}
                    {rb && !rb.adjacent ? '（跨接）' : ''}
                  </button>
                  <button
                    className="solder-remove"
                    onClick={() => apply([{ op: 'remove_solder_bridge', id: b.id }] as Op[], '拆除焊锡桥')}
                    title="拆除这根焊锡桥"
                    aria-label={`拆除焊锡桥 ${b.a} ↔ ${b.b}`}
                    data-testid={`solder-remove-${b.id}`}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
