import { useEffect, useState } from 'react';
import type { JsonValue, WireEndpoint, WireRoute } from '@breadboard-studio/schema';
import { accessibleHolesForPin, attachBoardPosition, conductiveSet, groupHoles, netOfAddress, umToMm, type Op } from '@breadboard-studio/core';
import { WIRE_COLORS } from '@breadboard-studio/render';
import { analysisOf, useStore } from '../store';
import { ArtworkEditor } from './ArtworkEditor';

function TextField({ label, value, onCommit, placeholder, multiline, testId }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; testId?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={placeholder} rows={2} data-testid={testId} />
      ) : (
        <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder={placeholder} data-testid={testId} />
      )}
    </label>
  );
}

function optionLabel(value: JsonValue): string {
  if (value === 'white') return '白色 (White)';
  if (value === 'blue') return '蓝色 (Blue)';
  if (value === 'upright') return '立式 (upright)';
  if (value === 'flat') return '平放 (flat)';
  if (value === 'off') return '关闭 (Off)';
  if (value === 'red') return '红色 (Red)';
  if (value === 'green') return '绿色 (Green)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function JsonField({ label, value, onCommit, hint, options }: { label: string; value: JsonValue | undefined; onCommit: (v: JsonValue) => void; hint?: string; options?: JsonValue[] }) {
  const text = value === undefined ? '' : JSON.stringify(value);
  const [v, setV] = useState(text);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setV(text);
    setErr(null);
  }, [text]);
  const commit = () => {
    if (v === text) return;
    if (v.trim() === '') {
      onCommit(null);
      return;
    }
    try {
      onCommit(JSON.parse(v) as JsonValue);
      setErr(null);
    } catch {
      setErr('不是有效 JSON（字符串请加引号，如 "GND"）');
    }
  };
  return (
    <label className="field">
      <span title={hint}>{label}</span>
      {options ? (
        <select value={text} onChange={(e) => onCommit(JSON.parse(e.target.value) as JsonValue)} data-testid={`prop-${label}`}>
          {options.map((option) => {
            const encoded = JSON.stringify(option);
            return <option key={encoded} value={encoded}>{optionLabel(option)}</option>;
          })}
        </select>
      ) : (
        <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} className={err ? 'invalid' : ''} data-testid={`prop-${label}`} />
      )}
      {err && <em className="error">{err}</em>}
      {hint && !err && <em className="hint-text">{hint}</em>}
    </label>
  );
}

const legacyRgb: Record<string, [number, number, number]> = {
  off: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255]
};

function rgbChannels(value: JsonValue | undefined): [number, number, number] {
  if (Array.isArray(value) && value.length === 3 && value.every((channel) => typeof channel === 'number')) {
    return value.map((channel) => Math.max(0, Math.min(255, Math.round(channel as number)))) as [number, number, number];
  }
  return typeof value === 'string' && legacyRgb[value] ? legacyRgb[value] : [0, 0, 0];
}

function rgbHex(channels: [number, number, number]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function RgbField({ label, value, onCommit, hint }: { label: string; value: JsonValue | undefined; onCommit: (v: JsonValue) => void; hint?: string }) {
  const channels = rgbChannels(value);
  const [draft, setDraft] = useState(channels.map(String));
  const valueKey = JSON.stringify(value);
  useEffect(() => setDraft(rgbChannels(value).map(String)), [valueKey]);
  const commit = () => {
    const next = draft.map((channel) => Math.max(0, Math.min(255, Math.round(Number(channel) || 0)))) as [number, number, number];
    setDraft(next.map(String));
    if (JSON.stringify(next) !== JSON.stringify(value)) onCommit(next);
  };
  const setHex = (hex: string) => {
    const next: [number, number, number] = [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16)
    ];
    setDraft(next.map(String));
    onCommit(next);
  };
  return (
    <div className="field">
      <span title={hint}>{label}</span>
      <div className="rgb-field">
        {(['R', 'G', 'B'] as const).map((channel, index) => (
          <label key={channel}>
            <span>{channel}</span>
            <input
              type="number"
              min={0}
              max={255}
              step={1}
              value={draft[index]}
              aria-label={`${label} ${channel}`}
              onChange={(e) => setDraft((current) => current.map((item, i) => i === index ? e.target.value : item))}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
            />
          </label>
        ))}
        <input type="color" value={rgbHex(channels)} aria-label={`${label} 颜色选择器`} onChange={(e) => setHex(e.target.value)} />
      </div>
      {hint && <em className="hint-text">{hint}</em>}
    </div>
  );
}

function schemaProps(schema: Record<string, JsonValue> | undefined): [string, Record<string, JsonValue>][] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, Record<string, JsonValue>>);
}

const JOIN_SIDE_LABELS = {
  top: '↑ 拼到上方',
  left: '← 拼到左侧',
  right: '拼到右侧 →',
  bottom: '↓ 拼到下方'
} as const;

function BoardJoinControls({ boardId }: { boardId: string }) {
  const design = useStore((s) => s.design);
  const model = analysisOf(design).model;
  const board = model.boards.get(boardId);
  const others = design.boards.filter((candidate) => candidate.id !== boardId);
  const otherIds = others.map((candidate) => candidate.id).join('\0');
  const currentJoin = (() => {
    if (!board) return null;
    for (const other of model.boards.values()) {
      if (other.instance.id === boardId) continue;
      for (const side of ['top', 'left', 'right', 'bottom'] as const) {
        const expected = attachBoardPosition(other, board.def, board.transform.rotation, side, 0, true);
        if (Math.hypot(expected[0] - board.transform.position[0], expected[1] - board.transform.position[1]) <= 2) {
          return { target: other.instance.id, side };
        }
      }
    }
    return null;
  })();
  const [targetId, setTargetId] = useState(currentJoin?.target ?? others[0]?.id ?? '');
  const [gapMm, setGapMm] = useState(0);
  const [gridAlign, setGridAlign] = useState(true);
  useEffect(() => {
    setTargetId(currentJoin?.target ?? others[0]?.id ?? '');
  }, [boardId, otherIds]);

  const join = (side: keyof typeof JOIN_SIDE_LABELS) => {
    const selected = model.boards.get(boardId);
    const target = model.boards.get(targetId);
    if (!selected || !target) return;
    const position = attachBoardPosition(target, selected.def, selected.transform.rotation, side, Math.round(gapMm * 1000), gridAlign);
    const result = useStore.getState().apply([{ op: 'move_board', id: boardId, position_um: position }], '拼接面包板');
    if (result.ok) useStore.getState().toast('success', `${boardId} 已${JOIN_SIDE_LABELS[side].replace(/[↑←→↓]/g, '').trim()} ${targetId}`);
  };

  return (
    <section className="board-join-card" data-testid="board-join-panel">
      <div className="board-join-title">面包板拼接</div>
      {currentJoin && <p className="join-status">已拼接：{boardId} 位于 {currentJoin.target} 的{JOIN_SIDE_LABELS[currentJoin.side].replace(/.*拼到/, '').replace(/[↑←→↓]/g, '')}</p>}
      {others.length ? (
        <>
          <label className="field">
            <span>基准面包板</span>
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="board-join-target">
              {others.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id} · {model.boards.get(candidate.id)?.def.name ?? candidate.model}</option>)}
            </select>
          </label>
          <div className="row board-join-options">
            <label className="field"><span>机械间距 (mm)</span><input type="number" min={0} step={0.1} value={gapMm} onChange={(e) => setGapMm(Math.max(0, Number(e.target.value) || 0))} data-testid="board-join-gap" /></label>
            <label className="toggle"><input type="checkbox" checked={gridAlign} onChange={(e) => setGridAlign(e.target.checked)} data-testid="board-join-grid" />孔阵对齐</label>
          </div>
          <div className="board-join-actions">
            {(Object.keys(JOIN_SIDE_LABELS) as (keyof typeof JOIN_SIDE_LABELS)[]).map((side) => (
              <button key={side} onClick={() => join(side)} data-testid={`board-join-${side}`}>{JOIN_SIDE_LABELS[side]}</button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">请先从左侧元件库再添加一块面包板。</p>
      )}
      <p className="muted">也可以直接拖动到另一块板边缘自动吸附。机械拼接不会自动导通两块板的电源轨，需要跳线连接。</p>
    </section>
  );
}

function AutoWireSelection({ ids }: { ids: string[] }) {
  const design = useStore((s) => s.design);
  const [route, setRoute] = useState<'auto' | WireRoute>('auto');
  const [globalOpt, setGlobalOpt] = useState(true);
  const st = useStore.getState();
  const selectedComponents = ids.filter((id) => design.components.some((c) => c.id === id));
  const ignored = ids.filter((id) => !selectedComponents.includes(id));
  const model = analysisOf(design).model;
  const rankedHosts = [...selectedComponents].sort((a, b) => {
    const score = (id: string) => {
      const pins = model.components.get(id)?.pins ?? [];
      const hasSignals = pins.some((p) => ['gpio', 'analog', 'i2c_sda', 'i2c_scl', 'signal_in', 'signal_out'].includes(p.meta.role));
      const hasSupply = pins.some((p) => p.meta.role === 'power_out');
      return (hasSignals ? 2 : 0) + (hasSupply ? 1 : 0);
    };
    return score(b) - score(a);
  });
  const signature = rankedHosts.join('\0');
  const [host, setHost] = useState(rankedHosts[0] ?? '');
  useEffect(() => {
    if (!rankedHosts.includes(host)) setHost(rankedHosts[0] ?? '');
  }, [signature, host, rankedHosts]);
  const peripherals = selectedComponents.filter((id) => id !== host);

  const run = () => {
    if (!host || !peripherals.length) return;
    const result = st.apply([{ op: 'auto_wire', host, components: peripherals, options: { route, optimize: globalOpt ? 'global' : 'greedy' } }], '自动排线');
    if (!result.ok) return;
    const plan = result.reports.find((r) => r.op === 'auto_wire')?.plan;
    if (!plan) return;
    const all = [...plan.connections, ...plan.bridges];
    const flat = all.filter((w) => w.route === 'flat').length;
    const dupont = all.length - flat;
    const errors = result.results.filter((r) => r.severity === 'error').length;
    const details = [
      ...plan.config_changes.map((c) => `已改配置 ${c.id}：${c.reason}（待审核）`),
      ...plan.unresolved.map((u) => `未连接 ${u.component}.${u.pin}：${u.reason}`),
      ...plan.skipped.filter((k) => k.code !== 'already_connected' && k.code !== 'pin_nc' && k.code !== 'board_ignored').map((k) => `跳过 ${k.component}${k.pin ? `.${k.pin}` : ''}：${k.reason}`),
      ...(errors ? [`校验发现 ${errors} 个错误（如 I²C 地址冲突），请查看底部校验面板`] : [])
    ].slice(0, 8);
    const kinds = [flat ? `${flat} 根硬质跳线` : '', dupont ? `${dupont} 根杜邦线` : ''].filter(Boolean).join('、');
    const o = plan.optimization;
    const mm = (um: number) => `${(um / 1000).toFixed(0)} mm`;
    const gain = o.global_objective_um === null ? 0 : o.greedy_objective_um - o.global_objective_um;
    const optText = o.global_objective_um === null ? `贪心规划，目标值 ${mm(o.objective_um)}` : `全局优化 ${o.elapsed_ms} ms：目标值 ${mm(o.objective_um)}${gain > 0 ? `（比贪心少 ${((gain / Math.max(o.greedy_objective_um, 1)) * 100).toFixed(1)}%）` : '（与贪心相同）'}${o.exhaustive ? '，已穷举' : ''}`;
    const busText = plan.i2c_buses.length > 1 ? `，I²C 用了 ${plan.i2c_buses.length} 条总线` : '';
    st.toast(plan.unresolved.length || errors ? 'info' : 'success', `自动排线完成：新增 ${kinds || '0 根导线'}${plan.bridges.length ? `（含 ${plan.bridges.length} 根电源轨馈线/桥线）` : ''}${busText}${plan.unresolved.length ? `，${plan.unresolved.length} 个引脚未连接` : ''}。${optText}`, details);
  };

  return (
    <section className="autowire-card" data-testid="autowire-panel">
      <div className="autowire-title">自动排线</div>
      <p className="muted">选择主控/电源主板后，按引脚角色连接其余已选元件；电源、GND、I²C 与 GPIO 会自动分配。</p>
      <label className="field">
        <span>主板（连接中心）</span>
        <select value={host} onChange={(e) => setHost(e.target.value)} data-testid="autowire-host">
          {rankedHosts.map((id) => <option key={id} value={id}>{id} · {model.components.get(id)?.def.name ?? id}</option>)}
        </select>
      </label>
      <label className="field">
        <span>线材与路径</span>
        <select value={route} onChange={(e) => setRoute(e.target.value as 'auto' | WireRoute)} data-testid="autowire-route">
          <option value="auto">自动（短线用硬质跳线，跨板/线缆/长线用杜邦线）</option>
          <option value="flat">全部硬质跳线（贴板走线，不共用路径）</option>
          <option value="elevated">全部杜邦线（直线跨越，允许交叉）</option>
        </select>
      </label>
      <label className="toggle"><input type="checkbox" checked={globalOpt} onChange={(e) => setGlobalOpt(e.target.checked)} data-testid="autowire-global" />全局优化（穷举网络拓扑与电源轨组合，结果不劣于逐引脚贪心）</label>
      <p className="muted">I²C 地址相同的器件不会被接到同一条总线：主板有空闲控制器时启用第二条总线，否则改用模块的另一个地址选项；这类改动都会列为待审核，因为固件和跳线要跟着改。</p>
      <p className="muted">电源和 GND 优先走电源轨（先馈线到最近的轨，再按需跨段/跨板桥接）；I²C 沿元件依次串接；信号线分配空闲 GPIO。结果按引脚角色生成，不是电气仿真。</p>
      <p className="muted">待连接：{peripherals.length ? peripherals.join('、') : '请再选择至少一个元件'}</p>
      {ignored.length > 0 && <p className="muted">面包板或导线不会参与：{ignored.join('、')}</p>}
      <button className="primary" disabled={!host || !peripherals.length} onClick={run} data-testid="autowire-run">自动排线</button>
    </section>
  );
}

export function Properties() {
  const design = useStore((s) => s.design);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedHole = useStore((s) => s.selectedHole);
  const st = useStore.getState();
  const [artworkFor, setArtworkFor] = useState<string | null>(null);
  const a = analysisOf(design);
  const model = a.model;
  const apply = (ops: Op[], label: string) => st.apply(ops, label);
  const setProp = (id: string, path: string, value: JsonValue) => apply([{ op: 'update_property', id, path, value }], '修改属性');

  if (selectedHole) {
    const group = groupHoles(model, selectedHole);
    const set = conductiveSet(model, a.connectivity, selectedHole);
    const net = netOfAddress(model, a.connectivity, selectedHole);
    const state = model.holes.get(selectedHole);
    return (
      <div className="props" data-testid="props-hole">
        <div className="panel-title">孔 {selectedHole}</div>
        <p>状态：{state?.status === 'free' ? '空闲' : state?.status === 'occupied' ? `被 ${state.component_id}.${state.pin} 占用` : `被 ${state?.component_id} 板体遮挡`}{state?.wires.length ? `；导线 ${state.wires.join(', ')}` : ''}</p>
        <p>板内导通组（{group.length} 孔）：{group.map((h) => h.split('.')[1]).join(' ')}</p>
        <p>
          实际网络：{net ? <b>{net.name}</b> : '（未接线）'}，共 {set.holes.length} 孔、{set.pins.length} 引脚
          {set.pins.length > 0 && <span className="muted">：{set.pins.join('、')}</span>}
        </p>
        <button onClick={() => { st.setTool('wire'); st.setWireDraft({ from: { hole: selectedHole } }); }} disabled={state?.status !== 'free' || !!state?.wires.length}>
          从此孔开始接线
        </button>
      </div>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <div className="props">
        <div className="panel-title">已选 {selectedIds.length} 个对象</div>
        <p className="muted">{selectedIds.join('、')}</p>
        <AutoWireSelection ids={selectedIds} />
        <div className="row">
          <button onClick={st.rotateSelection}>旋转 90°</button>
          <button onClick={st.duplicateSelection}>复制</button>
          <button onClick={st.toggleLockSelection}>锁定/解锁</button>
          <button className="danger" onClick={st.deleteSelection}>删除</button>
        </div>
      </div>
    );
  }

  const id = selectedIds[0];
  const board = id ? design.boards.find((b) => b.id === id) : undefined;
  const comp = id ? design.components.find((c) => c.id === id) : undefined;
  const wire = id ? design.wires.find((w) => w.id === id) : undefined;

  if (board) {
    const pb = model.boards.get(board.id);
    return (
      <div className="props" data-testid="props-board">
        <div className="panel-title">面包板 {board.id}</div>
        <p className="muted">{pb?.def.name} · {board.model}</p>
        <TextField label="名称" value={board.name ?? ''} onCommit={(v) => setProp(board.id, 'name', v)} testId="prop-name" />
        <div className="row">
          <label className="field"><span>X (mm)</span><input type="number" step={0.01} value={umToMm(board.position_um[0])} onChange={(e) => apply([{ op: 'move_board', id: board.id, position_um: [Math.round(Number(e.target.value) * 1000), board.position_um[1]] }], '移动')} /></label>
          <label className="field"><span>Y (mm)</span><input type="number" step={0.01} value={umToMm(board.position_um[1])} onChange={(e) => apply([{ op: 'move_board', id: board.id, position_um: [board.position_um[0], Math.round(Number(e.target.value) * 1000)] }], '移动')} /></label>
          <label className="field"><span>旋转</span>
            <select value={board.rotation_deg} onChange={(e) => apply([{ op: 'rotate_board', id: board.id, rotation_deg: Number(e.target.value) as 0 }], '旋转')}>
              {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r}°</option>)}
            </select>
          </label>
        </div>
        <label className="toggle"><input type="checkbox" checked={!!board.locked} onChange={(e) => setProp(board.id, 'locked', e.target.checked)} />锁定</label>
        <TextField label="备注" value={board.notes ?? ''} onCommit={(v) => setProp(board.id, 'notes', v)} multiline />
        {pb && <p className="muted">{pb.def.status_notes}</p>}
        <BoardJoinControls boardId={board.id} />
        <div className="row">
          <button onClick={st.duplicateSelection}>复制</button>
          <button className="danger" onClick={st.deleteSelection}>删除（含其上元件与导线）</button>
        </div>
      </div>
    );
  }

  if (comp) {
    const pc = model.components.get(comp.id);
    const def = pc?.def;
    const params = pc?.resolved.params ?? {};
    const config = pc?.resolved.config ?? {};
    return (
      <div className="props" data-testid="props-component">
        <div className="panel-title">元件 {comp.id}</div>
        <p className="muted">{def?.name} · {comp.model}</p>
        <TextField label="名称" value={comp.name ?? ''} onCommit={(v) => setProp(comp.id, 'name', v)} testId="prop-name" />
        <div className="row">
          <label className="field"><span>放置</span>
            <span className="static">{comp.placement.kind === 'board' ? `${comp.placement.board_id}.${comp.placement.anchor_hole}（锚点 ${comp.placement.anchor_pin}）` : `板外 (${umToMm(comp.placement.position_um[0])}, ${umToMm(comp.placement.position_um[1])}) mm`}</span>
          </label>
          <label className="field"><span>旋转</span>
            <select value={comp.placement.rotation_deg} onChange={(e) => apply([{ op: 'rotate_component', id: comp.id, rotation_deg: Number(e.target.value) as 0 }], '旋转')} data-testid="prop-rotation">
              {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r}°</option>)}
            </select>
          </label>
        </div>
        {comp.placement.kind === 'board' && (
          <div className="row">
            <label className="field"><span>锚点孔</span>
              <input defaultValue={comp.placement.anchor_hole} key={comp.placement.anchor_hole} onBlur={(e) => e.target.value !== (comp.placement as { anchor_hole: string }).anchor_hole && apply([{ op: 'move_component', id: comp.id, placement: { ...comp.placement, anchor_hole: e.target.value } as never }], '移动')} data-testid="prop-anchor-hole" />
            </label>
            <label className="field"><span>锚点引脚</span>
              <select value={comp.placement.anchor_pin} onChange={(e) => apply([{ op: 'move_component', id: comp.id, placement: { ...comp.placement, anchor_pin: e.target.value } as never }], '移动')}>
                {pc?.pins.filter((p) => p.kind === 'header').map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </label>
          </div>
        )}
        <label className="toggle"><input type="checkbox" checked={!!comp.locked} onChange={(e) => setProp(comp.id, 'locked', e.target.checked)} data-testid="prop-locked" />锁定</label>
        <div className="row">
          <button onClick={() => setArtworkFor(comp.model)} data-testid="prop-edit-artwork">编辑外观绘图…</button>
          {design.embedded_catalog?.components?.some((d) => `${d.id}@${d.version}` === comp.model) && <span className="muted">本项目使用自定义绘图</span>}
        </div>
        {artworkFor && <ArtworkEditor modelRef={artworkFor} onClose={() => setArtworkFor(null)} />}
        {def && schemaProps(def.params_schema).length > 0 && (
          <details open>
            <summary>参数（外形/针序）</summary>
            {schemaProps(def.params_schema).map(([k, sch]) => (
              <JsonField key={k} label={typeof sch.title === 'string' ? sch.title : k} value={params[k]} options={Array.isArray(sch.enum) ? sch.enum : undefined} hint={typeof sch.description === 'string' ? sch.description : undefined} onCommit={(v) => setProp(comp.id, `params.${k}`, v)} />
            ))}
          </details>
        )}
        {def && schemaProps(def.config_schema).length > 0 && (
          <details open>
            <summary>配置（电气/显示）</summary>
            {schemaProps(def.config_schema).map(([k, sch]) => (
              sch['x-ui'] === 'rgb' ? (
                <RgbField key={k} label={typeof sch.title === 'string' ? sch.title : k} value={config[k]} hint={typeof sch.description === 'string' ? sch.description : undefined} onCommit={(v) => setProp(comp.id, `config.${k}`, v)} />
              ) : (
                <JsonField key={k} label={typeof sch.title === 'string' ? sch.title : k} value={config[k]} options={Array.isArray(sch.enum) ? sch.enum : undefined} hint={typeof sch.description === 'string' ? sch.description : undefined} onCommit={(v) => setProp(comp.id, `config.${k}`, v)} />
              )
            ))}
          </details>
        )}
        {pc && (
          <details open>
            <summary>引脚 → 孔位（{pc.pins.length}）</summary>
            <table className="pins">
              <tbody>
                {pc.pins.map((p) => {
                  const holeAddr = p.hole ? `${p.hole.board_id}.${p.hole.hole}` : null;
                  const acc = holeAddr ? accessibleHolesForPin(model, comp.id, p.name) : [];
                  const net = netOfAddress(model, a.connectivity, `${comp.id}.${p.name}`);
                  return (
                    <tr key={p.name}>
                      <td><code>{p.name}</code></td>
                      <td className="muted">{p.meta.role}</td>
                      <td>{holeAddr ? holeAddr.split('.')[1] : pc.onBoard ? <span className="error">脱格</span> : '端子'}</td>
                      <td className="muted">{holeAddr ? (acc.length ? `可引出 ${acc.map((h) => h.split('.')[1]).join(' ')}` : '无外露孔') : ''}</td>
                      <td>{net ? <span className="net">{net.name}</span> : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pc.blockedHoles.length > 0 && <p className="muted">板体遮挡 {pc.blockedHoles.length} 孔。</p>}
          </details>
        )}
        <TextField label="备注" value={comp.notes ?? ''} onCommit={(v) => setProp(comp.id, 'notes', v)} multiline />
        {def?.sources.length ? (
          <p className="muted">
            资料：{def.sources.map((s, i) => (s.url ? <a key={i} href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : <span key={i}>{s.title}</span>))}
          </p>
        ) : null}
        <div className="row">
          <button onClick={st.rotateSelection}>旋转 90° (R)</button>
          <button onClick={st.duplicateSelection}>复制</button>
          <button className="danger" onClick={st.deleteSelection}>删除</button>
        </div>
      </div>
    );
  }

  if (wire) {
    const rw = model.wires.get(wire.id);
    const epText = (e?: WireEndpoint) => (e ? (e.hole ?? e.terminal ?? '') : '');
    const setEndpoint = (which: 'from' | 'to', text: string) => {
      const t = text.trim();
      if (!t) {
        if (which === 'to') apply([{ op: 'update_wire', id: wire.id, patch: { to: null } }], '修改端点');
        return;
      }
      const parsed = t.split('.');
      const owner = parsed[0] ?? '';
      const ep: WireEndpoint = design.boards.some((b) => b.id === owner) ? { hole: t } : { terminal: t };
      apply([{ op: 'update_wire', id: wire.id, patch: { [which]: ep } }], '修改端点');
    };
    return (
      <div className="props" data-testid="props-wire">
        <div className="panel-title">导线 {wire.id}</div>
        <TextField label="名称" value={wire.name ?? ''} onCommit={(v) => setProp(wire.id, 'name', v)} testId="prop-name" />
        <div className="row">
          <label className="field"><span>颜色</span>
            <select value={wire.color} onChange={(e) => setProp(wire.id, 'color', e.target.value)} data-testid="prop-color">
              {Object.keys(WIRE_COLORS).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field"><span>走线</span>
            <select value={wire.route} onChange={(e) => setProp(wire.id, 'route', e.target.value)}>
              <option value="flat">硬质跳线（路径不重叠）</option>
              <option value="elevated">杜邦线（允许重叠/跨越）</option>
            </select>
          </label>
        </div>
        <TextField label="起点（board.hole 或 comp.pin）" value={epText(wire.from)} onCommit={(v) => setEndpoint('from', v)} testId="prop-from" />
        <TextField label="终点" value={epText(wire.to)} onCommit={(v) => setEndpoint('to', v)} placeholder="留空 = 悬空草稿" testId="prop-to" />
        <p className="muted">
          估算长度 {rw ? (rw.length_um / 1000).toFixed(1) : '?'} mm（折线长度，不含插入深度、弯折与连接器余量）· 路径 {wire.path_mode === 'auto' ? '自动' : `手动（${wire.waypoints_um.length} 个拐点）`}
          {wire.path_mode === 'manual' && <button onClick={() => apply([{ op: 'update_wire', id: wire.id, patch: { path_mode: 'auto', waypoints_um: [] } }], '重置路径')}>重置为自动</button>}
        </p>
        <p className="muted">双击线段添加拐点，拖动拐点调整，双击拐点删除。</p>
        <label className="toggle"><input type="checkbox" checked={!!wire.locked} onChange={(e) => setProp(wire.id, 'locked', e.target.checked)} />锁定</label>
        <TextField label="备注" value={wire.notes ?? ''} onCommit={(v) => setProp(wire.id, 'notes', v)} multiline />
        <div className="row">
          <button className="danger" onClick={st.deleteSelection}>删除</button>
        </div>
      </div>
    );
  }

  // Nothing selected: project + net intents + constraints
  return (
    <div className="props" data-testid="props-project">
      <div className="panel-title">项目</div>
      <TextField label="名称" value={design.metadata.name} onCommit={(v) => apply([{ op: 'set_metadata', patch: { name: v } }], '重命名')} testId="prop-project-name" />
      <TextField label="说明" value={design.metadata.description ?? ''} onCommit={(v) => apply([{ op: 'set_metadata', patch: { description: v } }], '修改说明')} multiline />
      <p className="muted">revision {design.metadata.revision} · schema {design.schema_version} · 目录 {Object.entries(design.catalog_versions).map(([k, v]) => `${k}@${v}`).join(', ')}</p>
      <details open>
        <summary>网络意图（{design.net_intents.length}）</summary>
        <p className="muted">声明希望相连的端点；引擎只检查，不会自动生成导线。</p>
        {design.net_intents.map((n) => (
          <div key={n.id} className="intent">
            <TextField label={`${n.id} 名称`} value={n.name} onCommit={(v) => apply([{ op: 'update_net_intent', id: n.id, patch: { name: v } }], '修改网络')} />
            <TextField label="端点（逗号分隔）" value={n.endpoints.join(', ')} onCommit={(v) => apply([{ op: 'update_net_intent', id: n.id, patch: { endpoints: v.split(/[,\s]+/).filter(Boolean) } }], '修改网络')} />
            <button className="danger small" onClick={() => apply([{ op: 'remove_net_intent', id: n.id }], '删除网络')}>删除</button>
          </div>
        ))}
        <button onClick={() => {
          let n = 1;
          while (design.net_intents.some((x) => x.id === `net_${n}`)) n++;
          apply([{ op: 'add_net_intent', net_intent: { id: `net_${n}`, name: `NET${n}`, endpoints: [] } }], '添加网络');
        }} data-testid="add-intent">＋ 网络意图</button>
      </details>
      <details>
        <summary>约束（{design.constraints.length}）</summary>
        {design.constraints.map((c) => (
          <div key={c.id} className="intent">
            <code>{c.id}</code> {c.type} {'a' in c ? `${c.a} ⟂ ${c.b}` : 'text' in c ? c.text : `max ${c.max_um} µm`}
            <button className="danger small" onClick={() => apply([{ op: 'remove_constraint', id: c.id }], '删除约束')}>删除</button>
          </div>
        ))}
      </details>
      <p className="muted">点击画布对象查看属性；点击孔查看导通组。</p>
    </div>
  );
}
