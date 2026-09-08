import { useMemo } from 'react';
import { netIdFor, type NetRuntimeView } from '@breadboard-studio/sim';
import { analysisOf, useStore } from '../../store';
import { useSimulatorStore } from '../simulatorStore';

/** Nets of the design with their runtime value when a session reports one (docs §11.2 引脚/网络监视器). */
export function IoInspector() {
  const design = useStore((s) => s.design);
  const runtime = useSimulatorStore((s) => s.nets);
  const nets = analysisOf(design).connectivity.nets;

  const lookup = useMemo(() => {
    const byId = new Map<string, NetRuntimeView>();
    const byName = new Map<string, NetRuntimeView>();
    for (const n of runtime) {
      byId.set(n.netId, n);
      if (n.name) byName.set(n.name, n);
    }
    return { byId, byName };
  }, [runtime]);

  const valueOf = (net: (typeof nets)[number]): string => {
    if (!runtime.length) return '—';
    const view = lookup.byId.get(netIdFor([...net.holes, ...net.pins])) ?? lookup.byName.get(net.name);
    return view ? String(view.value) : '—';
  };

  return (
    <div className="sim-nets-wrap" data-testid="sim-nets">
      {nets.length === 0 ? (
        <p className="muted small">设计里还没有导通的网络。</p>
      ) : (
        <table className="sim-nets">
          <thead>
            <tr>
              <th>网络</th>
              <th>成员</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            {nets.map((net) => (
              <tr key={net.id} data-testid={`sim-net-${net.id}`}>
                <td><span className="net">{net.name}</span></td>
                <td className="muted">{net.holes.length + net.pins.length}</td>
                <td><code>{valueOf(net)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
