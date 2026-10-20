import {throwDiagnosticError} from '../renderers/shared/diagnostics.mjs';

export const INTENT_CONTRACT = 'archify-architecture-intent-v1';

export function rejectIntent(reason, message, subject = {}, evidence = {}) {
  throwDiagnosticError(message, [{
    code: `draft/intent-${reason}`, severity: 'error', message, subject, evidence,
    supportedFixes: ['revise the coordinate-free intent using the existing semantic IDs and relationships; do not delete facts or weaken the delivery gates'],
  }]);
}

function object(value, allowed, required, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    rejectIntent('shape', `Expected an intent object at ${location}.`, {path: location});
  }
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) rejectIntent('field', `Unsupported intent field ${location}.${field}; pixel geometry belongs to the compiler.`, {path: `${location}.${field}`});
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) rejectIntent('shape', `Missing intent field ${location}.${field}.`, {path: `${location}.${field}`});
  }
}

function array(value, location, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    rejectIntent('shape', `Expected an array with at least ${minimum} item(s) at ${location}.`, {path: location});
  }
  return value;
}

const pairKey = (from, to) => JSON.stringify([from, to]);

// The caller validates the Architecture schema and rejects supplied geometry first.
// This contract describes a reading plan, never a second graph or diagram schema.
export function validateArchitectureIntent(semantic, input) {
  object(input, ['schemaVersion', 'question', 'bands', 'mainPath', 'branches', 'sharedLayers', 'feedbackEdges'],
    ['schemaVersion', 'question', 'bands', 'mainPath'], 'intent');
  if (input.schemaVersion !== 1) rejectIntent('version', 'Architecture intent requires schemaVersion 1.', {path: 'intent.schemaVersion'});
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 800) {
    rejectIntent('question', 'State the reader question in 1–800 characters before choosing geometry.', {path: 'intent.question'});
  }
  const nodes = new Set(semantic.components.map(node => node.id));
  const relations = new Map();
  for (const edge of semantic.connections || []) {
    const key = pairKey(edge.from, edge.to);
    relations.set(key, [...(relations.get(key) || []), edge]);
  }
  const known = (id, location) => {
    if (typeof id !== 'string' || !nodes.has(id)) rejectIntent('node', 'Intent references an unknown component.', {path: location, id});
    return id;
  };
  const oneEdge = (from, to, location) => {
    const matches = relations.get(pairKey(from, to)) || [];
    if (matches.length !== 1) rejectIntent('relationship', 'This intent role needs one unambiguous existing directed relationship.',
      {path: location, from, to}, {matches: matches.length});
  };
  const positions = new Map();
  const bands = array(input.bands, 'intent.bands', 1).map((band, row) =>
    array(band, `intent.bands[${row}]`, 1).map((id, column) => {
      known(id, `intent.bands[${row}][${column}]`);
      if (positions.has(id)) rejectIntent('coverage', 'A component must occur in exactly one logical band.', {id});
      positions.set(id, {row, column});
      return id;
    }));
  const missing = [...nodes].filter(id => !positions.has(id));
  if (missing.length) rejectIntent('coverage', 'Intent bands must retain every semantic component.', {missing});

  const mainPath = array(input.mainPath, 'intent.mainPath', 1).map((id, index) => known(id, `intent.mainPath[${index}]`));
  if (new Set(mainPath).size !== mainPath.length) rejectIntent('main-path', 'Main-path IDs must be distinct; declare return relationships separately.');
  const directions = new Map();
  for (let i = 1; i < mainPath.length; i++) {
    const [from, to] = [mainPath[i - 1], mainPath[i]];
    if (!relations.has(pairKey(from, to))) rejectIntent('main-path', 'Every main-path step must be an existing directed relationship.', {from, to});
    const a = positions.get(from), b = positions.get(to);
    if (b.row < a.row) rejectIntent('main-path', 'The main path must advance through the logical bands; put returns in feedbackEdges.', {from, to});
    if (a.row === b.row) {
      const direction = Math.sign(b.column - a.column);
      if (directions.has(a.row) && directions.get(a.row) !== direction) {
        rejectIntent('main-path', 'The main path doubles back within a band; revise its logical order.', {band: a.row, from, to});
      }
      directions.set(a.row, direction);
    }
  }

  const branchNodes = new Set();
  const branches = array(input.branches ?? [], 'intent.branches').map((branch, i) => {
    const location = `intent.branches[${i}]`;
    object(branch, ['node', 'anchor'], ['node', 'anchor'], location);
    const node = known(branch.node, `${location}.node`), anchor = known(branch.anchor, `${location}.anchor`);
    if (node === anchor || branchNodes.has(node) || mainPath.includes(node)) {
      rejectIntent('branch', 'A branch needs one distinct anchor and cannot also be a main-path node.', {node, anchor});
    }
    if (!relations.has(pairKey(node, anchor)) && !relations.has(pairKey(anchor, node))) {
      rejectIntent('branch', 'A branch must be directly related to its declared anchor.', {node, anchor});
    }
    branchNodes.add(node);
    return {node, anchor};
  });
  const anchors = new Map(branches.map(branch => [branch.node, branch.anchor]));
  for (const {node} of branches) {
    const seen = new Set();
    for (let current = node; anchors.has(current); current = anchors.get(current)) {
      if (seen.has(current)) rejectIntent('branch', 'Branch anchors form a cycle; use feedbackEdges for returns.', {node});
      seen.add(current);
    }
  }

  const sharedNodes = new Set();
  const sharedLayers = array(input.sharedLayers ?? [], 'intent.sharedLayers').map((layer, i) => {
    const location = `intent.sharedLayers[${i}]`;
    object(layer, ['node', 'targets'], ['node', 'targets'], location);
    const node = known(layer.node, `${location}.node`), row = positions.get(node).row;
    if (sharedNodes.has(node) || branchNodes.has(node) || bands[row].length !== 1) {
      rejectIntent('shared-layer', 'A shared layer must own a dedicated logical band and cannot also be a branch.', {node});
    }
    const targets = array(layer.targets, `${location}.targets`, 1).map((id, index) => known(id, `${location}.targets[${index}]`));
    if (new Set(targets).size !== targets.length || targets.some(id => positions.get(id).row !== row + 1)) {
      rejectIntent('shared-layer', 'Shared-layer targets must be distinct nodes in the immediately following band.', {node, targets});
    }
    for (const target of targets) oneEdge(node, target, location);
    const columns = targets.map(id => positions.get(id).column).sort((a, b) => a - b);
    if (columns.at(-1) - columns[0] + 1 !== columns.length) {
      rejectIntent('shared-layer', 'Keep a shared layer’s targets contiguous instead of spanning unrelated nodes.', {node, targets});
    }
    sharedNodes.add(node);
    return {node, targets: [...targets].sort((a, b) => positions.get(a).column - positions.get(b).column)};
  }).sort((a, b) => positions.get(a.node).row - positions.get(b.node).row);
  for (const layer of sharedLayers) {
    if (layer.targets.some(id => sharedNodes.has(id))) {
      rejectIntent('shared-layer', 'Intent v1 supports flat shared layers; nested shared layers need another plan or the existing authoring path.', {node: layer.node});
    }
  }

  const feedbackPairs = new Set();
  const feedbackEdges = array(input.feedbackEdges ?? [], 'intent.feedbackEdges').map((edge, i) => {
    const location = `intent.feedbackEdges[${i}]`;
    object(edge, ['from', 'to', 'corridor'], ['from', 'to'], location);
    const from = known(edge.from, `${location}.from`), to = known(edge.to, `${location}.to`);
    const corridor = edge.corridor ?? 'auto';
    if (!['auto', 'above', 'below', 'left', 'right'].includes(corridor)) rejectIntent('feedback', 'Unknown feedback corridor.', {from, to, corridor});
    oneEdge(from, to, location);
    const key = pairKey(from, to), a = positions.get(from), b = positions.get(to);
    if (from === to || feedbackPairs.has(key) || b.row > a.row) {
      rejectIntent('feedback', 'Feedback must be a distinct return to the same or an earlier band.', {from, to});
    }
    if (mainPath.some((id, index) => id === from && mainPath[index + 1] === to)) {
      rejectIntent('feedback', 'The same relationship cannot be both a main-path step and a feedback edge.', {from, to});
    }
    feedbackPairs.add(key);
    return {from, to, corridor};
  });
  const mainOrder = new Map(mainPath.map((id, index) => [id, index]));
  for (const edge of semantic.connections || []) {
    const returnsAlongMain = mainOrder.has(edge.from) && mainOrder.has(edge.to)
      && mainOrder.get(edge.to) < mainOrder.get(edge.from);
    if ((positions.get(edge.to).row < positions.get(edge.from).row || returnsAlongMain)
      && !feedbackPairs.has(pairKey(edge.from, edge.to))) {
      rejectIntent('feedback', 'Declare every return to an earlier band or main-path node before computing coordinates.', {from: edge.from, to: edge.to});
    }
  }
  return {schemaVersion: 1, question: input.question.trim(), bands, mainPath, branches, sharedLayers, feedbackEdges};
}
