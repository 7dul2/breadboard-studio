/**
 * Sliders for `action: 'slider'` controls (阶段 4).
 *
 * They live in the 仿真 panel rather than on the canvas, which is the decision
 * M-S2 already made when the overlay skipped sliders: dragging a temperature and
 * pressing a touch pad want different affordances, and a slider drawn over a
 * 4 mm sensor window would be unusable. The canvas keeps the things you *press*.
 *
 * Bounds come from the catalog binding, so this component renders a slider for
 * any part that declares one without knowing what the part is.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SimulationControlDef } from '@breadboard-studio/schema';
import { catalogForDesign } from '@breadboard-studio/core';
import { builtinCatalog } from '@breadboard-studio/catalog';
import { useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';

interface SliderControl {
  componentId: string;
  componentName: string;
  control: SimulationControlDef;
  range: NonNullable<SimulationControlDef['range']>;
}

/** Every slider in the design, in document order. */
function sliderControls(design: ReturnType<typeof useStore.getState>['design']): SliderControl[] {
  const catalog = catalogForDesign(design, builtinCatalog());
  const out: SliderControl[] = [];
  for (const instance of design.components) {
    const def = catalog.getComponent(instance.model);
    for (const control of def?.simulation?.controls ?? []) {
      // A slider with no declared bounds cannot be drawn; the catalog test keeps
      // that from happening, and skipping is better than inventing a range.
      if (control.action !== 'slider' || !control.range) continue;
      out.push({ componentId: instance.id, componentName: instance.name ?? instance.id, control, range: control.range });
    }
  }
  return out;
}

export function SensorSliders() {
  const design = useStore((s) => s.design);
  const status = useSimulatorStore((s) => s.status);
  const controls = useMemo(() => sliderControls(design), [design]);
  const [values, setValues] = useState<Record<string, number>>({});

  // Seed from the catalog defaults, and re-seed when the set of controls changes.
  useEffect(() => {
    setValues((current) => {
      const next: Record<string, number> = {};
      for (const c of controls) {
        const key = `${c.componentId}:${c.control.id}`;
        next[key] = current[key] ?? c.range.default ?? c.range.min;
      }
      return next;
    });
  }, [controls]);

  if (!controls.length) return null;

  const live = status === 'running' || status === 'paused' || status === 'stepping';

  const send = (c: SliderControl, value: number): void => {
    setValues((current) => ({ ...current, [`${c.componentId}:${c.control.id}`]: value }));
    useSimulatorStore.getState().sendControl(c.componentId, c.control.id, value);
  };

  return (
    <section className="sim-section" data-testid="sim-sliders">
      <div className="sim-section-title">传感器输入</div>
      {!live && <p className="muted small">运行仿真后拖动才会送进程序。</p>}
      {controls.map((c) => {
        const key = `${c.componentId}:${c.control.id}`;
        const value = values[key] ?? c.range.default ?? c.range.min;
        return (
          <label className="sim-slider" key={key} data-testid={`sim-slider-${key}`}>
            <span className="sim-slider-name">
              {c.componentName} · {c.control.id}
            </span>
            <input
              type="range"
              min={c.range.min}
              max={c.range.max}
              step={c.range.step ?? 1}
              value={value}
              disabled={!live}
              onChange={(e) => send(c, Number(e.target.value))}
              data-testid={`sim-slider-input-${key}`}
            />
            <output data-testid={`sim-slider-value-${key}`}>
              {value}
              {c.range.unit ? ` ${c.range.unit}` : ''}
            </output>
          </label>
        );
      })}
    </section>
  );
}
