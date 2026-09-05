import { useEffect, useState } from 'react';
import type { JsonValue, WireEndpoint } from '@breadboard-studio/schema';
import { accessibleHolesForPin, attachBoardPosition, conductiveSet, groupHoles, netOfAddress, umToMm, type Op } from '@breadboard-studio/core';
import { WIRE_COLORS } from '@breadboard-studio/render';
import { analysisOf, useStore } from '../store';

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

function JsonField({ label, value, onCommit, hint }: { label: string; value: JsonValue | undefined; onCommit: (v: JsonValue) => void; hint?: string }) {
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
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} className={err ? 'invalid' : ''} data-testid={`prop-${label}`} />
      {err && <em className="error">{err}</em>}
      {hint && !err && <em className="hint-text">{hint}</em>}
    </label>
  );
}

function schemaProps(schema: Record<string, JsonValue> | undefined): [string, Record<string, JsonValue>][] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, Record<string, JsonValue>>);
}

export function Properties() {
  const design = useStore((s) => s.design);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedHole = useStore((s) => s.selectedHole);
  const st = useStore.getState();
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
        {design.boards.length > 1 && (
          <div className="row">
            <span className="muted">拼接到另一块板：</span>
            {design.boards.filter((b) => b.id !== board.id).map((other) => (
              <span key={other.id}>
                {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
                  <button key={side} onClick={() => {
                    const target = model.boards.get(other.id)!;
                    const pos = attachBoardPosition(target, pb!.def, board.rotation_deg, side, 0, true);
                    apply([{ op: 'move_board', id: board.id, position_um: pos }], '拼接');
                  }}>{other.id} {side === 'left' ? '左' : side === 'right' ? '右' : side === 'top' ? '上' : '下'}</button>
                ))}
              </span>
            ))}
          </div>
        )}
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
        {def && (def.geometry_status !== 'verified' || def.electrical_status !== 'verified') && (
          <p className="badge-line">⚠ 几何 {def.geometry_status}，电气 {def.electrical_status}。{def.status_notes}</p>
        )}
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
        {def && schemaProps(def.params_schema).length > 0 && (
          <details open>
            <summary>参数（外形/针序）</summary>
            {schemaProps(def.params_schema).map(([k, sch]) => (
              <JsonField key={k} label={k} value={params[k]} hint={typeof sch.description === 'string' ? sch.description : undefined} onCommit={(v) => setProp(comp.id, `params.${k}`, v)} />
            ))}
          </details>
        )}
        {def && schemaProps(def.config_schema).length > 0 && (
          <details open>
            <summary>电气配置</summary>
            {schemaProps(def.config_schema).map(([k, sch]) => (
              <JsonField key={k} label={k} value={config[k]} hint={typeof sch.description === 'string' ? sch.description : undefined} onCommit={(v) => setProp(comp.id, `config.${k}`, v)} />
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
              <option value="flat">贴板硬跳线</option>
              <option value="elevated">抬高软线</option>
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
