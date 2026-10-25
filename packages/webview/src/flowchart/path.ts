/** SVG path through orthogonal points with rounded corners. */
export function roundedPath(points: { x: number; y: number }[], radius = 8): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(
      radius,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    );
    const toward = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: a.x + ((b.x - a.x) / len) * r, y: a.y + ((b.y - a.y) / len) * r };
    };
    const p1 = toward(cur, prev);
    const p2 = toward(cur, next);
    d += ` L ${p1.x} ${p1.y} Q ${cur.x} ${cur.y} ${p2.x} ${p2.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}
