/** Compact time-series store with progressive decimation (keeps the whole history). */
export class History {
  t: number[] = [];
  series: Record<string, number[]> = {};
  constructor(public maxLen = 720) {}

  push(time: number, values: Record<string, number>): void {
    this.t.push(time);
    for (const [k, v] of Object.entries(values)) {
      let arr = this.series[k];
      if (!arr) {
        arr = this.series[k] = new Array(this.t.length - 1).fill(NaN);
      }
      arr.push(v);
    }
    for (const [k, arr] of Object.entries(this.series)) if (arr.length < this.t.length) this.series[k].push(NaN);
    if (this.t.length > this.maxLen) this.decimate();
  }

  private decimate(): void {
    const keep = (_: number, i: number) => i % 2 === 0 || i === this.t.length - 1;
    this.t = this.t.filter(keep);
    for (const k of Object.keys(this.series)) this.series[k] = this.series[k].filter(keep);
  }

  clear(): void {
    this.t = [];
    this.series = {};
  }

  toJSON(): { t: number[]; series: Record<string, number[]> } {
    return { t: this.t, series: this.series };
  }

  static from(o: { t: number[]; series: Record<string, number[]> } | undefined): History {
    const h = new History();
    if (o) {
      h.t = o.t.slice();
      h.series = Object.fromEntries(Object.entries(o.series).map(([k, v]) => [k, v.slice()]));
    }
    return h;
  }
}
