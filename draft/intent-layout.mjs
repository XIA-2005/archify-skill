import {labelGeometry} from '../renderers/shared/text-style.mjs';
import {rejectIntent} from './intent.mjs';

const round = value => Math.round(value * 1000) / 1000;
const pairKey = (from, to) => JSON.stringify([from, to]);

// Logical bands and roles are authored; every numeric position, size and port
// below is compiler-owned. The canonical renderer still owns routing and gates.
function placeIntent(candidate, intent, spacing, structure = 'spine') {
  // Equal-height bands preserve centered horizontal attachments without
  // reducing text size or changing explicit source typography.
  for (const band of intent.bands) {
    const height = Math.max(...candidate.components.filter(node => band.includes(node.id)).map(node => node.size[1]));
    for (const node of candidate.components) if (band.includes(node.id)) node.size[1] = height;
  }
  const nodes = new Map(candidate.components.map(node => [node.id, node]));
  const bandOf = new Map(intent.bands.flatMap((band, row) => band.map((id, column) => [id, {row, column}])));
  const shared = new Set(intent.sharedLayers.map(layer => layer.node));
  const ordinary = candidate.components.filter(node => !shared.has(node.id));
  const parent = new Map(ordinary.map(node => [node.id, node.id]));
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (id !== root) { const next = parent.get(id); parent.set(id, root); id = next; }
    return root;
  };
  const align = (a, b) => {
    if (!shared.has(a) && !shared.has(b)) parent.set(find(b), find(a));
  };
  for (let i = 1; i < intent.mainPath.length; i++) {
    const a = intent.mainPath[i - 1], b = intent.mainPath[i];
    if (structure === 'spine' && bandOf.get(a).row !== bandOf.get(b).row) align(a, b);
  }
  for (const {node, anchor} of intent.branches) {
    if (bandOf.get(node).row !== bandOf.get(anchor).row) align(node, anchor);
  }

  const gapFor = (a, b) => {
    const labels = (candidate.connections || []).filter(edge => edge.label
      && (edge.from === a && edge.to === b || edge.from === b && edge.to === a));
    return Math.ceil(Math.max(64, ...labels.map(edge =>
      labelGeometry(edge.label, edge.font_sizes?.label ?? 8 * candidate.meta.font_scale, [0, 0]).width + 28)) * spacing);
  };
  const constraints = [];
  for (const band of intent.bands) for (let i = 1; i < band.length; i++) {
    const [a, b] = [band[i - 1], band[i]];
    const from = find(a), to = find(b);
    if (from === to) rejectIntent('alignment', 'The intent aligns two nodes that must remain separate in one band.', {nodes: [a, b]});
    constraints.push({from, to, distance: (nodes.get(a).size[0] + nodes.get(b).size[0]) / 2 + gapFor(a, b)});
  }
  const groups = [...new Set(ordinary.map(node => find(node.id)))];
  const centers = new Map(groups.map(id => [id, 0]));
  // Difference constraints preserve every declared order and cross-band alignment.
  for (let pass = 0; pass < groups.length; pass++) {
    let changed = false;
    for (const edge of constraints) {
      const minimum = centers.get(edge.from) + edge.distance;
      if (centers.get(edge.to) + 0.000001 < minimum) { centers.set(edge.to, minimum); changed = true; }
    }
    if (!changed) break;
    if (pass === groups.length - 1) rejectIntent('alignment', 'Main-path/branch alignments conflict with the logical band order.');
  }

  // An auxiliary node should sit next to its anchor, not at the far left just
  // because the minimum-coordinate solution leaves slack before a fixed spine.
  const mainGroups = new Set(intent.mainPath.filter(id => !shared.has(id)).map(find));
  const branchAnchors = new Map(intent.branches.map(branch => [branch.node, branch.anchor]));
  const depth = id => { let count = 0; while (branchAnchors.has(id)) { id = branchAnchors.get(id); count++; } return count; };
  const branches = [...intent.branches].sort((a, b) => depth(a.node) - depth(b.node)
    || bandOf.get(a.node).row - bandOf.get(b.node).row || bandOf.get(a.node).column - bandOf.get(b.node).column);
  for (const {node, anchor} of branches) {
    if (shared.has(node) || shared.has(anchor)) continue;
    const group = find(node), owner = find(anchor);
    if (group === owner || mainGroups.has(group)) continue;
    const lower = Math.max(-Infinity, ...constraints.filter(edge => edge.to === group).map(edge => centers.get(edge.from) + edge.distance));
    const upper = Math.min(Infinity, ...constraints.filter(edge => edge.from === group).map(edge => centers.get(edge.to) - edge.distance));
    const sign = bandOf.get(node).column < bandOf.get(anchor).column ? -1 : 1;
    const desired = centers.get(owner) + sign * ((nodes.get(node).size[0] + nodes.get(anchor).size[0]) / 2 + gapFor(node, anchor));
    centers.set(group, Math.max(lower, Math.min(upper, desired)));
  }

  const neighbors = new Map(groups.map(group => [group, new Set()]));
  for (const edge of constraints) { neighbors.get(edge.from).add(edge.to); neighbors.get(edge.to).add(edge.from); }
  const componentOf = new Map(), components = [];
  for (const group of groups) {
    if (componentOf.has(group)) continue;
    const members = [group], index = components.length;
    componentOf.set(group, index);
    for (let i = 0; i < members.length; i++) for (const next of neighbors.get(members[i])) {
      if (!componentOf.has(next)) { componentOf.set(next, index); members.push(next); }
    }
    components.push(members);
  }
  // Center independently connected rails together instead of forcing every
  // cross-band main-path turn onto the preceding rail's far endpoint.
  // Authored band order and branch adjacency remain difference constraints.
  if (structure !== 'spine') for (const members of components) {
    const membersSet = new Set(members);
    const related = ordinary.filter(node => membersSet.has(find(node.id)));
    const left = Math.min(...related.map(node => centers.get(find(node.id)) - node.size[0] / 2));
    const right = Math.max(...related.map(node => centers.get(find(node.id)) + node.size[0] / 2));
    for (const group of members) centers.set(group, centers.get(group) - (left + right) / 2);
  }
  const centerOf = id => centers.get(find(id));
  const feedbackPairs = new Set(intent.feedbackEdges.map(edge => pairKey(edge.from, edge.to)));
  const incoming = id => [...new Set((candidate.connections || []).filter(edge => edge.to === id && edge.from !== id
    && !feedbackPairs.has(pairKey(edge.from, edge.to))).map(edge => edge.from))];
  const translated = new Set();
  for (const layer of intent.sharedLayers) {
    const targetComponent = componentOf.get(find(layer.targets[0]));
    const sources = incoming(layer.node).filter(id => !shared.has(id));
    if (structure === 'balanced' || !sources.length || translated.has(targetComponent)
      || sources.some(id => componentOf.get(find(id)) === targetComponent)) continue;
    const left = Math.min(...layer.targets.map(id => centerOf(id) - nodes.get(id).size[0] / 2));
    const right = Math.max(...layer.targets.map(id => centerOf(id) + nodes.get(id).size[0] / 2));
    const desired = (Math.min(...sources.map(centerOf)) + Math.max(...sources.map(centerOf))) / 2;
    const shift = desired - (left + right) / 2;
    for (const group of components[targetComponent]) centers.set(group, centers.get(group) + shift);
    translated.add(targetComponent);
  }

  const margin = 96;
  const tops = [];
  let y = margin;
  for (const band of intent.bands) {
    tops.push(y);
    // Budget vertical relationship text plus boundary/title clearance instead
    // of repeating a large empty strip around every auxiliary band.
    const labels = (candidate.connections || []).filter(edge => edge.label
      && band.includes(edge.from) && bandOf.get(edge.to).row > bandOf.get(edge.from).row);
    const gap = Math.max(80, ...labels.map(edge =>
      labelGeometry(edge.label, edge.font_sizes?.label ?? 8 * candidate.meta.font_scale, [0, 0]).height * 2 + 48));
    y += Math.max(...band.map(id => nodes.get(id).size[1])) + Math.ceil(gap * spacing);
  }
  for (const node of ordinary) node.pos = [round(centerOf(node.id) - node.size[0] / 2), tops[bandOf.get(node.id).row]];
  for (const layer of intent.sharedLayers) {
    const node = nodes.get(layer.node), targets = layer.targets.map(id => nodes.get(id));
    const sources = incoming(layer.node).map(id => nodes.get(id)).filter(source => source.pos);
    const left = Math.min(...targets.map(target => target.pos[0]), ...sources.map(source => source.pos[0] + source.size[0] / 2 - 24));
    const right = Math.max(...targets.map(target => target.pos[0] + target.size[0]), ...sources.map(source => source.pos[0] + source.size[0] / 2 + 24));
    node.size[0] = Math.ceil(Math.max(node.size[0], right - left));
    node.pos = [round((left + right - node.size[0]) / 2), tops[bandOf.get(node.id).row]];
  }
  const shift = margin - Math.min(...candidate.components.map(node => node.pos[0]));
  for (const node of candidate.components) node.pos[0] = round(node.pos[0] + shift);

  // Corridor preferences choose sides, not model-authored waypoints. The original
  // router may reject an infeasible preference; no acceptance rule is bypassed.
  const sides = {above: 'top', below: 'bottom', left: 'left', right: 'right'};
  for (const feedback of intent.feedbackEdges) {
    if (feedback.corridor === 'auto') continue;
    const edge = candidate.connections.find(edge => edge.from === feedback.from && edge.to === feedback.to);
    edge.fromSide = edge.toSide = sides[feedback.corridor];
  }

  // A shared layer spans its consumers. Compute the exact attachment fractions
  // from their centers instead of asking the model to guess decimal ports.
  const pinVertical = (edge, x) => {
    if ((candidate.connections || []).filter(other => other.from === edge.from && other.to === edge.to).length !== 1) return;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    const startY = from.pos[1] + from.size[1], endY = to.pos[1];
    if (startY >= endY || x < from.pos[0] + 16 || x > from.pos[0] + from.size[0] - 16
      || x < to.pos[0] + 16 || x > to.pos[0] + to.size[0] - 16) return;
    const blocked = candidate.components.some(node => node !== from && node !== to
      && x > node.pos[0] - 2 && x < node.pos[0] + node.size[0] + 2
      && startY < node.pos[1] + node.size[1] + 2 && endY > node.pos[1] - 2);
    if (blocked) return; // Leave obstructed incoming paths to the canonical router.
    edge.fromSide = 'bottom'; edge.toSide = 'top';
    edge.fromPort = [(x - from.pos[0]) / from.size[0], 1];
    edge.toPort = [(x - to.pos[0]) / to.size[0], 0];
  };
  for (const layer of intent.sharedLayers) {
    for (const edge of candidate.connections || []) {
      if (edge.from === layer.node && layer.targets.includes(edge.to)) {
        const target = nodes.get(edge.to);
        pinVertical(edge, target.pos[0] + target.size[0] / 2);
      } else if (edge.to === layer.node && !feedbackPairs.has(pairKey(edge.from, edge.to))) {
        const source = nodes.get(edge.from);
        pinVertical(edge, source.pos[0] + source.size[0] / 2);
      }
    }
  }
  return candidate;
}

export function architectureIntentDrafts(sized, intent) {
  const proposals = [], rejected = [];
  for (const structure of ['spine', 'balanced', 'source-centered']) {
    for (const spacing of [1, 1.25, 1.5]) {
      const id = `intent-${structure}-${spacing * 100}`;
      try {
        proposals.push({id, structure, intent,
          candidate: placeIntent(structuredClone(sized), intent, spacing, structure)});
      } catch (error) {
        if (!error.archifyDiagnostics) throw error;
        rejected.push({id, structure, diagnostics: error.archifyDiagnostics});
      }
    }
  }
  if (!proposals.length) rejectIntent('alignment', 'All structural arrangements conflict with the logical band order.', {}, {rejected});
  // Rejected structural probes are retained for tracing, not accepted candidates.
  Object.defineProperty(proposals, 'rejected', {value: rejected});
  return proposals;
}
