import {throwDiagnosticError} from '../renderers/shared/diagnostics.mjs';

function invalid(message, evidence) {
  throwDiagnosticError(message, [{code: 'draft/main-path', subject: {mainPath: evidence}, evidence: {},
    supportedFixes: ['choose unique existing component IDs in actual directed edge order; feedback also requires a final edge back to the first node']}]);
}

export function resolveComposition(semantic, {composition = 'layered', mainPath = []} = {}) {
  if (!['layered', 'flow', 'feedback'].includes(composition)) invalid('Unknown composition; use layered, flow or feedback.', composition);
  if (composition === 'layered' && mainPath.length) invalid('Choose flow or feedback when supplying a main path.', mainPath);
  if (composition === 'layered') return {composition, mainPath};
  const nodes = new Set(semantic.components.map(node => node.id));
  if (mainPath.length < (composition === 'feedback' ? 4 : 2) || new Set(mainPath).size !== mainPath.length
    || mainPath.some(id => !nodes.has(id))) invalid('The main path must contain distinct existing component IDs.', mainPath);
  const pairs = mainPath.slice(1).map((id, i) => [mainPath[i], id]);
  if (composition === 'feedback') pairs.push([mainPath.at(-1), mainPath[0]]);
  if (pairs.some(([from, to]) => !semantic.connections?.some(edge => edge.from === from && edge.to === to))) {
    invalid('Every main-path step must be an existing directed relationship.', mainPath);
  }
  return {composition, mainPath};
}

// The author supplies meaning (real edge order); this function supplies only
// relative placement. Two rails leave a distinct return corridor for a loop.
// Boundary rectangles are checked before a proposal reaches the renderer.
export function compositionPositions(candidate, {composition, mainPath}, {spacing, split}) {
  const nodes = new Map(candidate.components.map(node => [node.id, node]));
  const boundaries = (candidate.boundaries || []).map(boundary => new Set(boundary.wraps));
  const maximal = boundaries.filter((members, i) => !boundaries.some((other, j) => j !== i
    && (other.size > members.size || other.size === members.size && j < i)
    && [...members].every(id => other.has(id))));
  const owner = id => maximal.findIndex(members => members.has(id));
  const cells = new Map();
  const columns = composition === 'feedback' ? Math.max(split, mainPath.length - split) : mainPath.length;
  for (const [index, id] of mainPath.entries()) {
    cells.set(id, {col: composition === 'feedback' && index >= split ? mainPath.length - index - 1 : index,
      row: index >= split && composition === 'feedback' ? null : 0});
  }
  // A unique external input chain belongs before the first main-path node,
  // rather than in a right-hand branch strip with a long line back to entry.
  // Ambiguous fan-in stays on the ordinary branch path instead of guessing.
  let entry = mainPath[0], inputColumn = -1;
  const inputs = new Set();
  while (true) {
    const incoming = [...new Set((candidate.connections || []).filter(edge => edge.to === entry
      && owner(edge.from) === -1 && !cells.has(edge.from)).map(edge => edge.from))];
    if (incoming.length !== 1) break;
    entry = incoming[0]; cells.set(entry, {col: inputColumn--, row: 0}); inputs.add(entry);
  }
  const branches = candidate.components.filter(node => !cells.has(node.id));
  // Infer a branch's nearest main-path owner without inventing an edge. This
  // also supports chains such as dashboard -> query -> store -> rule engine.
  const distances = new Map(mainPath.map(id => [id, 0]));
  const anchors = new Map(mainPath.map(id => [id, cells.get(id).col]));
  for (let depth = 1; depth <= branches.length; depth++) {
    for (const node of branches) {
      if (distances.has(node.id)) continue;
      const neighbors = (candidate.connections || []).flatMap(edge => edge.from === node.id ? [edge.to] : edge.to === node.id ? [edge.from] : []);
      const nearest = neighbors.filter(id => distances.has(id) && distances.get(id) < depth);
      if (!nearest.length) continue;
      distances.set(node.id, depth);
      anchors.set(node.id, nearest.reduce((sum, id) => sum + anchors.get(id), 0) / nearest.length);
    }
  }
  const occupied = new Set();
  for (const node of branches.sort((a, b) => (distances.get(a.id) ?? Infinity) - (distances.get(b.id) ?? Infinity))) {
    const membership = owner(node.id);
    const memberColumns = mainPath.filter(id => owner(id) === membership).map(id => cells.get(id).col);
    // Groups absent from the main path and external actors get separate strips;
    // they must never accidentally appear inside another ownership rectangle.
    const allowedColumns = memberColumns.length ? [...new Set(memberColumns)] : [columns + Math.max(0, membership)];
    const minimum = Math.min(...allowedColumns);
    // An external approval/input branch joins above the outbound rail. Keeping
    // it between the rails would cut across the loop's return into its entry.
    const above = (candidate.connections || []).some(edge => edge.to === node.id && inputs.has(edge.from));
    const choices = [];
    for (let row = 1; row <= branches.length + 1; row++) for (const col of allowedColumns) {
      const actualRow = above ? -row : row;
      if (!occupied.has(`${col}:${actualRow}`)) choices.push({col, row: actualRow,
        score: Math.abs(col - (anchors.get(node.id) ?? minimum)) + row * 0.7});
    }
    choices.sort((a, b) => a.score - b.score || a.row - b.row || a.col - b.col);
    const selected = choices[0];
    cells.set(node.id, selected); occupied.add(`${selected.col}:${selected.row}`);
  }
  const middleRows = Math.max(0, ...branches.map(node => cells.get(node.id).row));
  const bottomRow = middleRows + 1;
  for (const cell of cells.values()) if (cell.row === null) cell.row = bottomRow;
  const columnOffset = -Math.min(0, ...[...cells.values()].map(cell => cell.col));
  const rowOffset = -Math.min(0, ...[...cells.values()].map(cell => cell.row));
  for (const cell of cells.values()) {cell.col += columnOffset; cell.row += rowOffset;}
  const widths = [], heights = [];
  for (const [id, cell] of cells) {
    widths[cell.col] = Math.max(widths[cell.col] || 0, nodes.get(id).size[0]);
    heights[cell.row] = Math.max(heights[cell.row] || 0, nodes.get(id).size[1]);
  }
  const gapX = Math.round(100 * spacing), gapY = Math.round(100 * spacing);
  const starts = (values, gap) => {
    const result = []; let next = 70;
    for (let i = 0; i < values.length; i++) {result[i] = next; next += (values[i] || 0) + gap;}
    return result;
  };
  const xs = starts(widths, gapX), ys = starts(heights, gapY);
  const positions = Object.fromEntries([...cells].map(([id, cell]) => [id,
    [Math.round(xs[cell.col] + (widths[cell.col] - nodes.get(id).size[0]) / 2), ys[cell.row]]]));
  for (const members of boundaries) {
    const points = [...members].map(id => ({pos: positions[id], size: nodes.get(id).size}));
    const left = Math.min(...points.map(p => p.pos[0])) - 30;
    const right = Math.max(...points.map(p => p.pos[0] + p.size[0])) + 30;
    const top = Math.min(...points.map(p => p.pos[1])) - 30;
    const bottom = Math.max(...points.map(p => p.pos[1] + p.size[1])) + 50;
    for (const [id, node] of nodes) {
      if (members.has(id)) continue;
      const [x, y] = positions[id];
      if (x < right && x + node.size[0] > left && y < bottom && y + node.size[1] > top) return null;
    }
  }
  return positions;
}
