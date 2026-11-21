import type { LocalBoard } from './local';

// Only fields visible on the diagram cross the device boundary.
export function localCopy(board: LocalBoard) {
  const nodes = board.nodes.map(({ id, label, description, kind, icon, x, y, w, h }) => ({
    id, label, doc: description, kind, icon: icon ?? '', x, y, w, h,
  }));
  const edges = board.edges.map(({ from, to, label, direction, description }) => ({
    from, to, label: [label, description].filter(Boolean).join(' '), direction,
  }));
  const labels = new Map([...board.nodes, ...board.edges].map(item => [item.id, item.label]));
  const x = board.nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + 32;
  board.notes.forEach((note, index) => {
    nodes.push({ id: 'note-' + note.id, kind: 'note', icon: '', x, y: index * 112, w: 224, h: 96,
      label: note.text, doc: [labels.get(note.target) === undefined ? 'Detached note' : labels.get(note.target) || 'Unnamed element', note.resolved ? 'Resolved' : 'Open', ...note.replies.map(r => r.text)].join('\n') });
  });
  return { name: board.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100) || 'Local board', nodes, edges };
}
