import { useEffect, useRef } from 'react';
import { useSimulatorStore } from '../simulatorStore';

function formatUs(us: number): string {
  return `${(us / 1000).toFixed(1)} ms`;
}

/** Serial output of the running program(s); empty until a backend produces lines. */
export function SerialConsole() {
  const serial = useSimulatorStore((s) => s.serial);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [serial.length]);
  return (
    <div className="sim-serial" ref={ref} data-testid="sim-serial">
      {serial.length === 0 && <span className="muted">串口输出会在程序运行时出现</span>}
      {serial.map((line, i) => (
        <div key={i} className={`sim-serial-line ${line.stream}`}>
          <span className="muted">[{formatUs(line.atUs)}] {line.componentId}&gt; </span>
          {line.text}
        </div>
      ))}
    </div>
  );
}
