/** Import a tracked root Go module into a board using the shared history extractor.
 * SPACETIME_URI=ws://localhost:3000 SPACETIME_DB=redcrayon npm run import-go -- --repo /path/to/repo --board name
 */
import { DbConnection } from './module_bindings/index';
import { extractGraph } from './extract-graph';
import { readTokenAt, saveTokenAt, tokenPathFor } from './identity';

const uri = process.env.SPACETIME_URI;
const db = process.env.SPACETIME_DB;
if (!uri) throw new Error('SPACETIME_URI is not set');
if (!db) throw new Error('SPACETIME_DB is not set');
const tokenPath = tokenPathFor(uri, process.env.SPACETIME_TOKEN_FILE);
const savedToken = readTokenAt(tokenPath);

const args = process.argv.slice(2);
function argValue(flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) throw new Error(`missing required argument ${flag} <value>`);
  return args[index + 1];
}
const repo = argValue('--repo');
const boardName = argValue('--board');
function fail(reason: string): never {
  console.error(`FATAL: ${reason}`);
  process.exit(1);
}

console.log(`Extracting tracked Go packages in ${repo} ...`);
const graph = await extractGraph(repo, { goOnly: true });
const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length * 1.6)));
console.log(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(db)
  .withToken(savedToken)
  .onConnect((conn: DbConnection, _identity, token) => {
    try {
      saveTokenAt(tokenPath, token, savedToken);
    } catch (error) {
      fail(`could not save anonymous identity: ${String(error)}`);
    }
    conn.subscriptionBuilder()
      .onApplied(() => { void run(conn).catch(error => fail(String((error as Error).stack ?? error))); })
      .onError(ctx => fail(`subscription error: ${String(ctx.event)}`))
      .subscribeToAllTables();
  })
  .onConnectError((_ctx, error) => fail(`connection failed: ${String(error)}`))
  .build();

async function run(conn: DbConnection): Promise<void> {
  if ([...conn.db.visibleBoard.iter()].some(board => board.name === boardName)) fail(`board "${boardName}" already exists -- pick another name`);
  await conn.reducers.createBoard({ name: boardName });
  const board = [...conn.db.visibleBoard.iter()].find(board => board.name === boardName);
  if (!board) fail('board row not visible after create_board committed');
  const boardId = board.id;
  const idByKey = new Map<string, bigint>();
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index];
    const x = 40 + (index % columns) * 256;
    const y = 40 + Math.floor(index / columns) * 96;
    await conn.reducers.createNode({
      boardId, label: node.label, sublabel: node.sublabel.length <= 40 ? node.sublabel : `...${node.sublabel.slice(-37)}`,
      x, y, w: 224, h: 64, token: 'ink', focal: false, kind: node.kind, doc: '', imported: true,
    });
    const created = [...conn.db.visibleNode.iter()].find(row => row.boardId === boardId && row.x === x && row.y === y);
    if (!created) fail(`created node for ${node.key} not found in cache at (${x},${y})`);
    idByKey.set(node.key, created.id);
  }
  for (const edge of graph.edges) {
    await conn.reducers.createEdge({ boardId, fromNode: idByKey.get(edge.from)!, toNode: idByKey.get(edge.to)!, label: edge.label, evidence: edge.evidence, imported: true });
  }
  for (let index = 0; index < graph.files.length; index += 200) await conn.reducers.addRepoFiles({ boardId, paths: graph.files.slice(index, index + 200) });
  console.log(`imported board "${boardName}": ${graph.nodes.length} nodes, ${graph.edges.length} edges; registered ${graph.files.length} repo files`);
  conn.disconnect();
  setTimeout(() => process.exit(0), 300);
}
