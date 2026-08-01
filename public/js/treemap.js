// Squarified treemap。板块框和板块内部的格子都用它。

function worst(row, short) {
  const sum = row.reduce((a, b) => a + b, 0);
  if (!sum) return Infinity;
  const max = Math.max(...row), min = Math.min(...row);
  return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
}

/** items: [{value, ...}] → [{item, x, y, w, h}]，方块尽量接近正方形。 */
export function squarify(items, rect) {
  const nodes = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = nodes.reduce((s, d) => s + d.value, 0);
  const out = [];
  if (!total || rect.w <= 0 || rect.h <= 0) return out;

  let { x, y, w, h } = rect;
  const areas = nodes.map((d) => (d.value / total) * rect.w * rect.h);
  let i = 0;

  while (i < areas.length && w > 0.5 && h > 0.5) {
    const short = Math.min(w, h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], short) <= worst(row, short)) {
      row.push(areas[j]); j++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    const thick = Math.min(rowSum / short, w >= h ? w : h);
    let off = 0;
    for (let k = 0; k < row.length; k++) {
      const len = thick > 0 ? row[k] / thick : 0;
      out.push(w >= h
        ? { item: nodes[i + k], x, y: y + off, w: thick, h: len }
        : { item: nodes[i + k], x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}
