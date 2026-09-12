/** Reproduce milestone 3 geometry/length evidence without changing example files. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeDesign, applyOps, loadDesign } from '@breadboard-studio/core';
import { exportSvg } from '@breadboard-studio/render';
const output = process.argv[2] ?? '/tmp/bbs-autowire-audit';
mkdirSync(output, { recursive: true });
for (const [name, components] of [
  ['desk_device', ['oled', 'touch']],
  ['touch_display', ['oled', 'touch']],
  ['environment_node', ['sht41', 'bmp390', 'ltr390', 'sen66']]
] as const) {
  const source = loadDesign(readFileSync(`examples/${name}.breadboard.json`, 'utf8')).design!;
  source.wires = []; source.net_intents = [];
  const result = applyOps(source, [{ op: 'auto_wire', host: 'mcu', components: [...components], options: { time_budget_ms: 20000 } }]);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const plan = result.reports[0]!.plan;
  const a = analyzeDesign(result.design);
  const wires = [...a.model.wires.values()];
  const summary = { example: name, hard: wires.filter((w) => w.instance.route === 'flat').length, dupont: wires.filter((w) => w.instance.route === 'elevated').length,
    total_um: wires.reduce((n, w) => n + w.length_um, 0), dupont_um: wires.filter((w) => w.instance.route === 'elevated').reduce((n, w) => n + w.length_um, 0),
    unresolved: plan.unresolved.length, errors: a.summary.error,
    sen66: plan.connections.filter((c) => c.component === 'sen66').map((c) => ({ pin: c.pin, to: c.to, length_um: c.length_um })) };
  console.log(JSON.stringify(summary));
  writeFileSync(join(output, `${name}.svg`), exportSvg(a.model, { legend: true, title: name }));
  writeFileSync(join(output, `${name}.json`), JSON.stringify(result.design, null, 2) + '\n');
  if (name === 'environment_node') {
    const unbundled = structuredClone(result.design);
    for (const wire of unbundled.wires) if (wire.route === 'elevated') { wire.path_mode = 'auto'; wire.waypoints_um = []; }
    writeFileSync(join(output, `${name}-unbundled.svg`), exportSvg(analyzeDesign(unbundled).model, { legend: true, title: `${name} — same endpoints, no bundling` }));
    const suggestions = applyOps(source, [{ op: 'auto_wire', host: 'mcu', components: [...components], options: { place_suggestions: true, time_budget_ms: 20000 } }]);
    if (!suggestions.ok) throw new Error(JSON.stringify(suggestions.error));
    console.log(JSON.stringify({ suggestions: suggestions.reports[0]!.plan.suggestions }));
  }
}
