import { useEffect, useMemo, useState } from 'react';
import { SIMULATION_SPEEDS, type ComponentInstance, type SimulationSpeed } from '@breadboard-studio/schema';
import { activeProgram, catalogForDesign, nextProgramId, programsForComponent, type Op } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { STATUS_LABELS, createProgramAsset, isProgramTarget, type SimDiagnostic } from '@breadboard-studio/sim';
import { useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';
import { SerialConsole } from './SerialConsole';
import { IoInspector } from './IoInspector';

const SEVERITY_LABEL: Record<SimDiagnostic['severity'], string> = { error: '错误', warning: '警告', info: '信息' };
type SimulationPatch = Extract<Op, { op: 'set_simulation_config' }>['patch'];

function formatUs(us: number): string {
  return `${(us / 1000).toFixed(1)} ms`;
}

/** Text input that commits on blur / Enter, mirroring the properties panel fields. */
function NameField({ value, onCommit, testId }: { value: string; onCommit: (v: string) => void; testId: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const next = v.trim();
    if (next && next !== value) onCommit(next);
    else setV(value);
  };
  return <input type="text" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} title="程序名称（回车或失焦保存）" data-testid={testId} />;
}

function SeedField({ value, onCommit }: { value: number | undefined; onCommit: (v: number | null) => void }) {
  const text = value === undefined ? '' : String(value);
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  const commit = () => {
    if (v === text) return;
    if (v.trim() === '') {
      onCommit(null);
      return;
    }
    const n = Number(v);
    if (Number.isFinite(n)) {
      const seed = Math.max(0, Math.round(n));
      setV(String(seed));
      onCommit(seed);
    } else setV(text);
  };
  return (
    <label className="field">
      <span>随机种子</span>
      <input type="number" min={0} step={1} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="未设置" data-testid="sim-seed" />
    </label>
  );
}

export function SimulatorPanel() {
  const design = useStore((s) => s.design);
  const st = useStore.getState();
  const status = useSimulatorStore((s) => s.status);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const nowUs = useSimulatorStore((s) => s.nowUs);
  const diagnostics = useSimulatorStore((s) => s.diagnostics);
  const sim = useSimulatorStore.getState();

  const catalog = useMemo(() => catalogForDesign(design, builtinCatalog()), [design]);
  const mcus = useMemo(() => design.components.filter((c) => isProgramTarget(catalog.getComponent(c.model))), [design, catalog]);
  /** Controllers plus any component that already hosts a program (a CLI patch can target a non-MCU). */
  const targets = useMemo(() => {
    const hosting = new Set((design.programs ?? []).map((p) => p.target_component_id));
    return design.components.filter((c) => hosting.has(c.id) || isProgramTarget(catalog.getComponent(c.model)));
  }, [design, catalog]);

  const active = activeProgram(design);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = (chosen && targets.some((m) => m.id === chosen) ? chosen : null) ?? (active && targets.some((m) => m.id === active.target_component_id) ? active.target_component_id : null) ?? targets[0]?.id ?? null;
  const programs = target ? programsForComponent(design, target) : [];
  const config = design.simulation ?? {};
  const usb = new Set(config.usb_powered_components ?? []);

  const setConfig = (patch: SimulationPatch, label: string) => st.apply([{ op: 'set_simulation_config', patch }], label);

  const newProgram = () => {
    if (!target) return;
    const id = nextProgramId(design);
    const n = (design.programs?.length ?? 0) + 1;
    const ops: Op[] = [{ op: 'add_program', program: createProgramAsset({ id, target_component_id: target, name: `程序 ${n}` }) }];
    if (!activeProgram(design)) ops.push({ op: 'set_simulation_config', patch: { active_program_id: id } });
    const r = st.apply(ops, '新建程序');
    if (r.ok) sim.openEditor(id);
  };

  const onDiagnostic = (d: SimDiagnostic) => {
    st.setHighlight([], d.componentIds ?? []);
    if (d.source && design.programs?.some((p) => p.id === d.source!.programId)) sim.openEditor(d.source.programId);
  };

  const mcuLabel = (c: ComponentInstance) => `${c.id} · ${c.name ?? c.model}`;

  return (
    <div className="sim-panel" data-testid="sim-panel">
      <div className="panel-title">仿真</div>
      <div className="sim-header">
        <span className={`sim-light sim-light-${status}`} data-testid="sim-panel-status">{STATUS_LABELS[status]}</span>
        <span>会话 {sessionId ?? '—'}</span>
        <span>虚拟时间 {formatUs(nowUs)}</span>
      </div>

      <section className="sim-section">
        <div className="sim-section-title">目标主控</div>
        {targets.length === 0 ? (
          <p className="muted small" data-testid="sim-no-mcu">先从元件库添加主控（ESP32-S3）</p>
        ) : (
          <select value={target ?? ''} onChange={(e) => setChosen(e.target.value)} data-testid="sim-target">
            {targets.map((c) => (
              <option key={c.id} value={c.id}>{mcuLabel(c)}{mcus.some((m) => m.id === c.id) ? '' : '（非主控）'}</option>
            ))}
          </select>
        )}
      </section>

      <section className="sim-section">
        <div className="sim-section-title">程序</div>
        <div className="sim-program-list" data-testid="sim-program-list">
          {programs.length === 0 && <p className="muted small">{target ? '这个主控还没有程序。' : '选择主控后可以新建程序。'}</p>}
          {programs.map((p) => {
            const isActive = active?.id === p.id;
            return (
              <div key={p.id} className={`sim-program ${isActive ? 'active' : ''}`} data-testid={`sim-program-${p.id}`}>
                <div className="sim-program-head">
                  <input type="radio" name="sim-active-program" checked={isActive} onChange={() => setConfig({ active_program_id: p.id }, '设为当前程序')} title="设为当前运行的程序" data-testid={`sim-program-active-${p.id}`} />
                  <NameField value={p.name} onCommit={(name) => st.apply([{ op: 'update_program', id: p.id, patch: { name } }], '重命名程序')} testId={`sim-program-name-${p.id}`} />
                </div>
                <div className="sim-program-meta">
                  <span className="sim-lang">Studio TypeScript · <code>{p.id}</code></span>
                  <span className="spacer" />
                  <button className="small" onClick={() => sim.openEditor(p.id)} data-testid={`sim-open-editor-${p.id}`}>打开代码编辑器</button>
                  <button className="small danger" onClick={() => st.apply([{ op: 'remove_program', id: p.id }], '删除程序')} data-testid={`sim-delete-program-${p.id}`}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row">
          <button className="primary" onClick={newProgram} disabled={!target || !mcus.some((m) => m.id === target)} data-testid="sim-new-program">新建程序</button>
        </div>
      </section>

      <section className="sim-section">
        <div className="sim-section-title">启动配置</div>
        <div className="row">
          <label className="field">
            <span>倍速</span>
            <select
              value={String(config.speed ?? 1)}
              onChange={(e) => {
                const speed = Number(e.target.value) as SimulationSpeed;
                const r = setConfig({ speed }, '设置倍速');
                if (r.ok) sim.setSpeed(speed);
              }}
              data-testid="sim-speed"
            >
              {SIMULATION_SPEEDS.map((s) => (
                <option key={s} value={String(s)}>{s}×</option>
              ))}
            </select>
          </label>
          <SeedField value={config.random_seed} onCommit={(random_seed) => setConfig({ random_seed }, '设置随机种子')} />
        </div>
        <div className="field">
          <span>USB 供电</span>
          {mcus.length === 0 && <span className="muted small">没有主控。</span>}
          {mcus.map((c) => (
            <label key={c.id} className="toggle">
              <input
                type="checkbox"
                checked={usb.has(c.id)}
                onChange={(e) => {
                  const next = new Set(usb);
                  if (e.target.checked) next.add(c.id);
                  else next.delete(c.id);
                  setConfig({ usb_powered_components: next.size ? [...next] : null }, 'USB 供电');
                }}
                data-testid={`sim-usb-${c.id}`}
              />
              {c.id}
            </label>
          ))}
        </div>
      </section>

      <section className="sim-section">
        <div className="sim-section-title sim-section-head">
          诊断
          <span className="spacer" />
          {status === 'idle' && diagnostics.length > 0 && <button className="small" onClick={sim.clearDiagnostics} data-testid="sim-clear-diagnostics">清除</button>}
        </div>
        <ul className="sim-diagnostics" data-testid="sim-diagnostics">
          {diagnostics.length === 0 && <li className="muted small">没有诊断信息。</li>}
          {diagnostics.map((d, i) => (
            <li key={`${d.code}-${i}`} className="sim-diagnostic" onClick={() => onDiagnostic(d)} title={d.source ? `${d.source.programId}:${d.source.line}:${d.source.column}` : d.code} data-testid={`sim-diagnostic-${d.code}`}>
              <span className={`tag ${d.severity}`}>{SEVERITY_LABEL[d.severity]}</span>
              <span>
                <code>{d.code}</code> {d.message}
                {d.componentIds?.length ? <span className="muted"> · {d.componentIds.join(' ')}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="sim-section">
        <div className="sim-section-title">串口</div>
        <SerialConsole />
      </section>

      <section className="sim-section">
        <div className="sim-section-title">网络监视</div>
        <IoInspector />
      </section>

      <div className="sim-info" data-testid="sim-info">
        阶段 0：程序随项目保存、可撤销、可导出；代码执行后端将在下一阶段加入，运行现在会以“故障 · runtime_unavailable”结束。
      </div>
    </div>
  );
}
