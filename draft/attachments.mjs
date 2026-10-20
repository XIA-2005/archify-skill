// Draft-only correction. No canonical renderer, editor or authored candidate is
// changed implicitly. Read resolved endpoints including incoming connections.
export function loneAttachmentDefects(candidate, layout) {
  const nodes = new Map(candidate.components.map(node => [node.id, node]));
  const sides = new Map();
  for (const [index, relation] of layout.connections.entries()) {
    for (const end of ['from', 'to']) {
      const node = nodes.get(relation[end]);
      const point = end === 'from' ? relation.points[0] : relation.points.at(-1);
      const neighbor = end === 'from' ? relation.points[1] : relation.points.at(-2);
      const [x, y] = node.pos, [w, h] = node.size;
      const side = Math.abs(point[1] - y) < 0.75 ? 'top' : Math.abs(point[1] - y - h) < 0.75 ? 'bottom'
        : Math.abs(point[0] - x) < 0.75 ? 'left' : Math.abs(point[0] - x - w) < 0.75 ? 'right' : null;
      if (!side) continue; // Canonical validation owns invalid endpoint geometry.
      const axis = ['top', 'bottom'].includes(side) ? 0 : 1;
      const midpoint = axis ? y + h / 2 : x + w / 2;
      const key = JSON.stringify([node.id, side]);
      const records = sides.get(key) || [];
      records.push({node: node.id, side, end, index,
        offset: Math.abs(point[axis] - midpoint), perpendicular: Math.abs(point[axis] - neighbor[axis]) < 0.75});
      sides.set(key, records);
    }
  }
  return [...sides.values()].filter(records => records.length === 1).flat()
    .filter(record => record.offset > 0.75 || !record.perpendicular);
}
export function centerLoneAttachments(candidate, defects) {
  const ports = {top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5]};
  for (const defect of defects) {
    const edge = candidate.connections[defect.index];
    edge[`${defect.end}Side`] = defect.side;
    edge[`${defect.end}Port`] = [...ports[defect.side]];
  }
}
