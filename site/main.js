const svg = document.getElementById('board-svg');
if (svg) {
  const NS = 'http://www.w3.org/2000/svg';
  const cols = 30;
  const rows = 10;
  const x0 = 28;
  const y0 = 52;
  const pitch = 12;
  const half = cols * pitch;

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // board body
  svg.appendChild(el('rect', {
    x: 8, y: 28, width: 404, height: 196,
    rx: 4, fill: '#1a2420', stroke: '#2a3d34', 'stroke-width': 1
  }));

  // power rails
  const railYs = [38, 44, 208, 214];
  for (const y of railYs) {
    svg.appendChild(el('line', {
      x1: 20, y1: y, x2: 400, y2: y,
      stroke: y < 100 ? '#3d5a4c' : '#2f4a3e',
      'stroke-width': 1.2
    }));
  }
  // rail marks
  const marks = [
    { t: '−', x: 16, y: 45, c: '#4fc3f7' },
    { t: '+', x: 16, y: 38, c: '#e53935' },
    { t: '−', x: 16, y: 215, c: '#4fc3f7' },
    { t: '+', x: 16, y: 208, c: '#e53935' }
  ];
  for (const m of marks) {
    const t = el('text', {
      x: m.x, y: m.y + 3, fill: m.c,
      'font-size': '8', 'font-family': 'ui-monospace, monospace'
    });
    t.textContent = m.t;
    svg.appendChild(t);
  }

  // ravine
  svg.appendChild(el('rect', {
    x: 18, y: 116, width: 384, height: 10,
    fill: '#0d1512'
  }));

  // hole grid
  const holeAt = (c, r) => ({ x: x0 + c * pitch, y: y0 + r * pitch });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const { x, y } = holeAt(c, r);
      svg.appendChild(el('circle', {
        class: 'hole-dot', cx: x, cy: y, r: 2.4
      }));
    }
  }

  // column labels every 5
  for (let c = 0; c < cols; c += 5) {
    const { x } = holeAt(c, 0);
    const t = el('text', {
      x, y: y0 - 8, fill: '#6f877c',
      'font-size': '7', 'text-anchor': 'middle',
      'font-family': 'ui-monospace, monospace'
    });
    t.textContent = String(c + 1);
    svg.appendChild(t);
  }

  // wires: path through holes (col, row) pairs
  const path = (pts) => pts.map(([c, r], i) => {
    const { x, y } = holeAt(c, r);
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');

  const wires = [
    // VCC red: left rail-ish to component pins
    { cls: 'r', pts: [[0, 0], [0, 1], [4, 1], [4, 2], [10, 2]] },
    // GND blue
    { cls: 'b', pts: [[0, 9], [2, 9], [2, 7], [12, 7]] },
    // SDA yellow zig
    { cls: 'y', pts: [[8, 4], [14, 4], [14, 3], [20, 3], [20, 5], [24, 5]] },
    // SCL green
    { cls: 'g', pts: [[8, 5], [13, 5], [13, 6], [19, 6], [24, 6]] }
  ];

  for (const w of wires) {
    const p = el('path', {
      class: `wire ${w.cls}`,
      d: path(w.pts)
    });
    // dynamic dash length
    svg.appendChild(p);
    requestAnimationFrame(() => {
      try {
        const len = p.getTotalLength();
        p.style.strokeDasharray = String(len);
        p.style.strokeDashoffset = String(len);
        // re-trigger
        p.style.animation = 'none';
        // force reflow
        void p.getBoundingClientRect();
        p.style.animation = '';
      } catch {}
    });
  }

  // small IC pad suggestion
  svg.appendChild(el('rect', {
    x: holeAt(10, 2).x - 4, y: holeAt(10, 2).y - 8,
    width: 56, height: 48, rx: 2,
    fill: 'rgba(61,186,122,0.08)', stroke: 'rgba(61,186,122,0.35)', 'stroke-width': 1
  }));
  const label = el('text', {
    x: holeAt(10, 2).x + 24, y: holeAt(10, 2).y + 28,
    fill: '#8aa396', 'font-size': '8', 'text-anchor': 'middle',
    'font-family': 'ui-monospace, monospace'
  });
  label.textContent = 'MCU';
  svg.appendChild(label);
}
