/** Minimal canvas line chart (time series). */
export function drawChart(canvas: HTMLCanvasElement, t: number[], ys: { values: number[]; color: string; label: string }[], opts: { fmt?: (v: number) => string; xfmt?: (v: number) => string } = {}): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 120;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (t.length < 2) {
    ctx.fillStyle = '#8d9bb3';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('Collecting data…', 10, H / 2);
    return;
  }
  let lo = Infinity,
    hi = -Infinity;
  for (const s of ys) for (const v of s.values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) return;
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const t0 = t[0], t1 = t[t.length - 1];
  const L = 44, R = 8, T = 8, B = 18;
  const X = (x: number) => L + ((x - t0) / Math.max(t1 - t0, 1e-9)) * (W - L - R);
  const Y = (y: number) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  ctx.strokeStyle = 'rgba(140,170,220,0.15)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8d9bb3';
  ctx.font = '10px "JetBrains Mono", monospace';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.fillText(opts.fmt ? opts.fmt(v) : v.toPrecision(3), 2, y + 3);
  }
  if (opts.xfmt) {
    ctx.fillText(opts.xfmt(t0), L, H - 4);
    const s = opts.xfmt(t1);
    ctx.fillText(s, W - R - ctx.measureText(s).width, H - 4);
  }
  for (const s of ys) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < t.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      const x = X(t[i]), y = Y(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
