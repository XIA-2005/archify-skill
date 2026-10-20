// Ranking is advisory and lexicographic, never a replacement for artifact,
// browser, provenance or actual screenshot acceptance.
export function compactPoints(points) {
  const result = [];
  for (const point of points || []) {
    if (result.length && result.at(-1).every((n, i) => n === point[i])) continue;
    result.push(point);
    while (result.length > 2) {
      const [a, b, c] = result.slice(-3);
      const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - b[i]);
      if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-7 || u[0] * v[0] + u[1] * v[1] <= 0) break;
      result.splice(-2, 1);
    }
  }
  return result;
}
const rounded = n => Math.round(n * 1000) / 1000;
export function readingMetrics(layout, candidate, intent) {
  const nodes = new Map(candidate.components.map(n => [n.id, n]));
  const edges = layout.connections.map(edge => ({...edge, points: compactPoints(edge.points)}));
  const mainPairs = new Set((intent?.mainPath || []).slice(1).map((id, i) => JSON.stringify([intent.mainPath[i], id])));
  let mainBends = 0, mainBacktracks = 0;
  for (const edge of edges.filter(e => mainPairs.has(JSON.stringify([e.from, e.to])))) {
    mainBends += Math.max(0, edge.points.length - 2);
    const a = nodes.get(edge.from), b = nodes.get(edge.to);
    const dx = b.pos[0] + b.size[0] / 2 - a.pos[0] - a.size[0] / 2;
    const dy = b.pos[1] - a.pos[1];
    const axis = Math.abs(dy) > 1 ? 1 : 0, direction = axis ? dy : dx;
    for (let i = 1; i < edge.points.length; i++) if ((edge.points[i][axis] - edge.points[i - 1][axis]) * direction < -1e-6) mainBacktracks++;
  }
  const shared = (intent?.sharedLayers || []).map(layer => {
    const routes = edges.filter(e => e.from === layer.node && layer.targets.includes(e.to));
    return {node: layer.node, outputs: routes.length,
      bentOutputs: routes.filter(e => e.points.length > 2).length,
      bends: routes.reduce((n, e) => n + Math.max(0, e.points.length - 2), 0)};
  });
  const rows = new Map();
  for (const node of candidate.components) {
    const key = node.pos[1], row = rows.get(key) || [];
    row.push(node); rows.set(key, row);
  }
  const envelopes = [...rows.values()].map(row => {
    const left = Math.min(...row.map(n => n.pos[0])), right = Math.max(...row.map(n => n.pos[0] + n.size[0]));
    return {center: (left + right) / 2, width: right - left};
  });
  const totalWidth = Math.max(1, ...candidate.components.map(n => n.pos[0] + n.size[0])) - Math.min(...candidate.components.map(n => n.pos[0]));
  const mean = envelopes.reduce((n, row) => n + row.center, 0) / envelopes.length;
  const rowDrift = envelopes.reduce((n, row) => n + Math.abs(row.center - mean), 0) / envelopes.length / Math.max(1, totalWidth);
  return {mainBends, mainBacktracks, shared, rowDrift: rounded(rowDrift),
    bendsPerEdge: rounded(edges.reduce((n, e) => n + Math.max(0, e.points.length - 2), 0) / Math.max(1, edges.length))};
}
export function qualityKey(metrics) {
  const r = metrics.reading || {};
  return [metrics.counterflowCorridors?.length || 0, metrics.crossings || 0,
    r.mainBacktracks || 0, (r.shared || []).reduce((n, s) => n + s.bentOutputs, 0),
    // A coarse diagnostic bucket avoids preferring microscopic center changes
    // over an extra main-path turn. No bucket is a visual acceptance threshold.
    Math.floor((r.rowDrift || 0) * 10), r.mainBends || 0,
    Math.max(0, 7.5 - (metrics.desktopText?.[0]?.projectedPx ?? 7.5)),
    r.bendsPerEdge || 0, Math.max(0, metrics.estimatedDiagramHeightPx - 774),
    metrics.routeLength / Math.max(1, metrics.edgeCount || 1), metrics.width * metrics.height];
}
export function compareDrafts(a, b) {
  const x = qualityKey(a.attempt.metrics), y = qualityKey(b.attempt.metrics);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function repairRecommendations(metrics) {
  const recommendations = [];
  for (const shared of metrics.reading?.shared || []) if (shared.bentOutputs >= 2) recommendations.push({
    code: 'draft/shared-fanout', action: 'reflow-connected-group', subject: {node: shared.node}, evidence: shared,
    reason: 'Multiple shared outputs turn; inspect placement before adding waypoints. This is an advisory signal, not a gate.',
  });
  if ((metrics.reading?.rowDrift || 0) >= 0.2) recommendations.push({code: 'draft/unbalanced-bands',
    action: 'compare-structural-candidate', evidence: {rowDrift: metrics.reading.rowDrift},
    reason: 'Row envelopes are displaced; inspect whether the empty space serves a real return or boundary.'});
  return recommendations;
}
