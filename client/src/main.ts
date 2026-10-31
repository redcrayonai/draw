import { DbConnection } from './module_bindings/index';
import type { Chart, CodeRef, Edge, Node, Session } from './module_bindings/types';
import { config } from './config';
import { setupShare, type ShareState } from './share';
import { setupChartEmbed } from './chart-embed-menu';
import {
  showError,
  showBoardUnavailable,
  LINK_GONE,
  setSaveStatus,
  showNotice,
  setupTheme,
  setupRailToggle,
  setupShortcutsToggle,
  setupHeaderActions,
  themeCommands,
  exportSvg,
  renderParticipantChips,
  renderPresencePop,
  renderInspector,
  showReconnect,
  initAccountBar,
  initSignInButton,
  copyText,
  nodeName,
  renderBoardCounts,
  renderExposure,
  placeLegend,
  renderLegendSummary,
  dashboardHref,
  initBoardsLink,
} from './chrome';
import { paintAccessLine } from './access-line';
import { renderBoard, focusOf, ghostEdges, contentBounds, evidenceClass, hasMachineEvidence, nodeRect, type RefBadge, type EdgeRefBadge, type LiveEdge } from './render';
import { LIVE_CHART_SOURCE, LiveSession, liveCsv, liveUrl, recordLive, resolveLive, tapPrompt, type LivePoint, type LiveState } from './live';
import { formatWindow, mountWindowBrush, zoomOut, type TimeWindow } from './time-window';
import { Glide, type XY } from './glide';
import { Viewport, chromeInsets } from './viewport';
import { History, Ops, type ChartPatch } from './ops';
import { Editor, TEXT_ENTRY } from './interactions';
import { LibraryPopover, type TemplatePick } from './library-popover';
import { buildLibraryPayload, iconNodePlacement, insertRefusal, parseLibraryPayload, samplePlacement, saveRefusal } from './library';
import { setLogoListener } from './node-icons';
import { resetChartDraft } from './chart-inspector';
import { bindChartTooltip } from './chart-tooltip';
import { renderPresence, rateLimited, latestWins, participantsOnBoard, ownPresenceLost, presenceOf } from './presence';
import { setupConnect, findAgentBoard, connectCommand } from './connect';
import { CommandPalette, offeredOn, type Command } from './palette';
import { tidyGrid, distributeHorizontally, connectInOrder, GRID, type Box } from './layout';
import { initAuth, SignedOutError, type Auth } from './auth';
import { runBootWithRecovery } from './connection-recovery';
import { openBoards, subscribeBoard, subscribeLists } from './subscribe';
import { selectBoard, hasBoardLink, shouldOpenDashboard, viewOnly, opensNewShareLink } from './board-select';
import { shareTokenOf } from '../../shared/share-link';
import { openBoardRename } from './board-rename';
import { openBoardDelete } from './board-delete';
import { setDb } from '../../shared/db-target';
import { canStartGuest, claimForBoard, guestReturnUrl } from './journey';
import { boardHref } from '../../shared/board-link';
import { signInWithGuestBoard } from './guest-handoff';
import { trackBoardWrites } from './save-status';
import { readAnonymousToken, saveAnonymousToken, clearAnonymousToken } from './anonymous-identity';
import {
  buildRefsIndex,
  pruneOrphanRefs,
  parseCoverage,
  buildBadgeTitles,
  buildEdgeBadges,
  buildNodeBadges,
  sizedBadge,
  type NodeBadgeBase,
  visibleStale,
  type BadgeTitle,
  type RefSummary,
  type StaleOwner,
} from './refs';
import { renderSessionBlock, codeOverlayHint } from './session-rail';
import { buildNoteIndex, type NoteIndex } from './change-notes-view';
import { buildThreatIndex, looksPii, threatRailText, type ThreatIndex } from './threats-view';
import { threatMarker, type MarkerSpec } from './board-marker';
import { peekPosition, renderThreatPeek } from './threat-peek';
import { blastRadius, type Blast, type Depth, type Direction } from './blast';
import { isThreatKind } from '../../module/src/threats';
import { blastLegs, loopBlast, playSpread } from './blast-play';
import { renderThreatCard, threatCardKey, threatCardStillValid, type ThreatCardActions, type ThreatCardModel } from './threat-card';
import { buildRouteModel, type RouteModel } from './route';
import { syncEmptyState } from './empty-state';
import { mountThinkingOrb } from './thinking-orb';
import { finishBoardLoading } from './board-loading';
import { readEditorScheme, cycleEditorScheme } from './editor-link';
import { comparisonBoard, diffScene, reconciliationSnapshot } from './architecture';
import { mountArchitectureRail } from './architecture-rail';
import { branchActions, branchTree, chipText, statusWord, type BranchAction, type BranchStatus, type Role } from './branches';
import { mountBranchPopover } from './branch-popover';
import { ACTION_LABELS, openBranchCreate, openBranchReview, type ChangeRow } from './branch-dialogs';
import { playRoute, routeLegs } from './route-play';
import { mountCrayon } from './crayon';
import { listening, setupReview } from './review-panel';
import { playTrace } from './trace-play';
import { traceMs, type TraceSpan } from '../../module/src/trace';
import {
  readOverlayPref,
  writeOverlayPref,
  resolveCodeOverlay,
  syncSessionChrome,
  codeCommands,
} from './code-overlay';

const svg = document.getElementById('board') as unknown as SVGSVGElement;
const world = document.getElementById('world') as unknown as SVGGElement;
const wrap = document.getElementById('canvas-wrap') as HTMLElement;
const title = document.getElementById('board-title') as HTMLHeadingElement;

setupTheme();
setupRailToggle(window.innerWidth < 640);
setupShortcutsToggle();

// Anonymous mode only: the server-issued long-lived token, persisted so the
// anonymous identity is stable per browser instead of minting a fresh one
// (and a fresh durable participant row) on every page load. Account mode never
// reads or writes this key — account tokens are fetched fresh per connect and
// never persisted.
const ANON_TOKEN_KEY = `stdb_token:${config.uri}/${config.db}`;
const SHARE_LOCAL_GUEST = import.meta.env.DEV && !config.accounts;
const RECONNECT_ATTEMPT_KEY = 'stdb_reconnect_attempt';
const ACCOUNT_SEEN_KEY = `account_seen:${config.accounts ?? ''}`;
const GUEST_CLAIM_KEY = `guest_claim:${config.uri}/${config.db}`;
const GUEST_RECOVERY_KEY = `guest_recovery:${config.uri}/${config.db}`;

let auth: Auth | undefined;
let currentConn: DbConnection | undefined;
let intentionalDisconnect = false;
let reconnectScheduled = false;
let authLoading: Promise<Auth> | undefined;

function dashboardLink(): string | undefined {
  const href = dashboardHref(config.dashboardUrl, config.db, config.defaultDb);
  return href ? auth?.authenticatedHref(href) ?? href : undefined;
}

function newBoardHref(): string {
  const url = new URL(location.href);
  url.searchParams.delete('boardId');
  url.searchParams.delete('board');
  url.searchParams.set('new', '1');
  url.hash = '';
  return url.toString();
}

/** The board's #b=<slug> link on this page; a board without a slug yet keeps the current URL. */
function showBoardLink(board: { slug: string }): void {
  if (board.slug) window.history.replaceState(null, '', boardHref({ app: location.href, slug: board.slug, db: config.db, home: config.defaultDb }));
}

function guestHomeHref(): string {
  return guestReturnUrl(location.href, sessionStorage.getItem(GUEST_RECOVERY_KEY));
}

async function loadAuth(): Promise<Auth> {
  if (auth) return auth;
  if (!authLoading) {
    authLoading = initAuth().then(loaded => {
      auth = loaded;
      if (loaded.hasSession()) localStorage.setItem(ACCOUNT_SEEN_KEY, '1');
      else localStorage.removeItem(ACCOUNT_SEEN_KEY);
      loaded.onSignedOut(() => {
        localStorage.removeItem(ACCOUNT_SEEN_KEY);
        sessionStorage.removeItem(GUEST_CLAIM_KEY);
        intentionalDisconnect = true;
        currentConn?.disconnect();
        location.assign(guestHomeHref());
      });
      return loaded;
    }).catch(error => {
      authLoading = undefined;
      throw error;
    });
  }
  return authLoading;
}

const dbParam = new URLSearchParams(location.search).get('db');
// A link names its database, except this build's own, which setDb leaves out.
const linkedDb = dbParam || config.defaultDb;
if (linkedDb !== config.db) {
  // pickDb refused it. Board ids are per database, so opening the link here would show an unrelated board.
  showError('This link is for a database this site does not serve, so it was not opened.');
} else {
  const url = setDb(new URL(location.href), config.db, config.defaultDb);
  if (config.db === config.defaultDb) url.searchParams.delete('db');
  window.history.replaceState(null, '', url);
  void start();
}

async function start(): Promise<void> {
  try {
    if (config.accounts) {
      try {
        auth = await loadAuth();
      } catch (error) {
        if (location.hash.startsWith('#/') || !canStartGuest(config.requireAuth, localStorage.getItem(ACCOUNT_SEEN_KEY) === '1', document.cookie)) throw error;
        showError('Sign-in is temporarily unavailable. Your guest drawing is still available; use Sign in to retry.');
      }
      // Excalidraw-style by default: the board is free to use anonymously
      // and sign-in is offered in the header. VITE_REQUIRE_AUTH gates the
      // whole app instead.
      if (config.requireAuth) {
        // A dismissed Google-return card resolves false; reopen the required one.
        while (!(await auth!.ensureSignedIn()));
      }
    }
    // The session event can precede the provider's redirect; its router still owns a #/ URL.
    // A redirect back to this page changes only the hash, which loads nothing: start once it leaves #/.
    if (auth?.hasSession() && location.hash.startsWith('#/')) {
      window.addEventListener('hashchange', function resume() {
        if (location.hash.startsWith('#/')) return;
        window.removeEventListener('hashchange', resume);
        void start();
      });
      return;
    }
    if (shouldOpenDashboard(location.search, auth?.hasSession() ?? false, location.hash)) {
      const href = dashboardLink();
      if (href) { location.replace(href); return; }
      showError('The dashboard is unavailable. You can still start a board here.');
    }
    await connect();
  } catch (err) {
    // Loading auth rejects on the same class of transient failure (provider
    // unreachable, DNS, adblocker) that post-auth code retries — go through
    // the same backoff instead of dead-ending on a static crash page.
    scheduleReconnect(String(err));
  }
}

async function connect(): Promise<void> {
  let token: string | undefined;
  const signedIn = auth?.hasSession() ?? false;
  if (auth && signedIn) {
    localStorage.setItem(ACCOUNT_SEEN_KEY, '1');
    // Invariant: when signed in a missing token must never reach
    // withToken() — a tokenless connect would silently mint a new
    // anonymous identity.
    try {
      token = await auth.freshToken();
    } catch (err) {
      if (err instanceof SignedOutError) {
        location.reload(); // lands on the gate or the anonymous board
        return;
      }
      scheduleReconnect(String(err));
      return;
    }
  } else {
    token = readAnonymousToken(ANON_TOKEN_KEY, SHARE_LOCAL_GUEST);
  }

  const builder = DbConnection.builder()
    .withUri(config.uri)
    .withDatabaseName(config.db)
    .onConnect((conn: DbConnection, identity, issuedToken) => {
      if (!signedIn && issuedToken) {
        // with no token passed, onConnect delivers the server-issued
        // long-lived token (never the short-lived websocket token)
        saveAnonymousToken(ANON_TOKEN_KEY, issuedToken, SHARE_LOCAL_GUEST);
      }
      void runBootWithRecovery(
        conn,
        () => boot(conn, identity.toHexString(), signedIn),
        () => sessionStorage.removeItem(RECONNECT_ATTEMPT_KEY),
        scheduleReconnect
      );
    })
    .onConnectError((_ctx, err) => {
      // A refused saved anonymous token would wedge every retry, but the SDK
      // throws the same 'Failed to verify token' for a 401 and for a 5xx at
      // the token exchange. Ask the endpoint and drop the token only on a 401,
      // so a server blip cannot discard a durable anonymous identity.
      const saved = signedIn ? undefined : readAnonymousToken(ANON_TOKEN_KEY, SHARE_LOCAL_GUEST);
      if (saved && String(err).includes('verify token')) {
        void fetch(new URL('v1/identity/websocket-token', config.uri.replace(/^ws/, 'http')), {
          method: 'POST', headers: { Authorization: `Bearer ${saved}` },
        }).then(res => { if (res.status === 401) clearAnonymousToken(ANON_TOKEN_KEY, SHARE_LOCAL_GUEST); }, () => {});
      }
      scheduleReconnect(String(err));
    })
    .onDisconnect((_ctx, err) => {
      if (intentionalDisconnect) {
        return;
      }
      scheduleReconnect(err ? String(err) : 'connection closed');
    });
  if (token !== undefined) {
    builder.withToken(token);
  }
  currentConn = builder.build();
}

// Fields that can hold a typed draft; a slider, switch, select or read-only field holds none.
const TYPED_TEXT = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([readonly]), [contenteditable]:not([contenteditable="false"])';

// Reconnect by reloading the page rather than rebuilding in place: boot()
// wires DOM listeners with no teardown path, so a clean page is the only
// leak-free path back to a working board. The account session and the
// anonymous token (localStorage) both survive reloads; the attempt counter
// lives in sessionStorage so the backoff survives them too.
function scheduleReconnect(reason: string): void {
  if (reconnectScheduled) {
    return;
  }
  reconnectScheduled = true;
  const attempt = Number(sessionStorage.getItem(RECONNECT_ATTEMPT_KEY) ?? '0') + 1;
  sessionStorage.setItem(RECONNECT_ATTEMPT_KEY, String(attempt));
  const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  showReconnect(reason, delayMs);
  // No draft survives a reload, so hold it while someone types; 'Retry now' still reloads.
  // shortcut: text committed after the drop is queued on the dead socket and lost on the
  // reload, persist drafts or hold while save-status is pending if this is reported.
  const reload = (): void => {
    if (document.activeElement?.matches(TYPED_TEXT)) setTimeout(reload, 1000);
    else location.reload();
  };
  setTimeout(reload, delayMs);
}

// `signedIn` is the state the connection was actually built with — session
// state can change between connect and boot, and the join must describe the
// identity on the wire, not the current account state.
async function boot(conn: DbConnection, identityHex: string, signedIn: boolean): Promise<void> {
  (window as any).conn = conn; // debugging/console access
  (window as any).myIdentityHex = identityHex;
  let activeBoardId: bigint | undefined;
  const boardsHref = dashboardLink();
  trackBoardWrites(conn, setSaveStatus);
  if (auth && signedIn) {
    const doSignOut = async () => {
      await auth!.signOut();
      localStorage.removeItem(ACCOUNT_SEEN_KEY);
      sessionStorage.removeItem(GUEST_CLAIM_KEY);
      intentionalDisconnect = true;
      currentConn?.disconnect();
      location.assign(guestHomeHref());
    };
    initAccountBar(auth.displayName(), () => void doSignOut());
  }
  // Anonymous but sign-in available: offered in the header and the Connect
  // dialog, never as a gate.
  const signIn = signedIn || !config.accounts ? undefined : async () => {
    const button = document.getElementById('sign-in') as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      const loaded = await loadAuth();
      const guestBoard = [...conn.db.myBoards.iter()].find(row => row.boardId === activeBoardId && row.access === 'owner' && !row.isSession);
      const architecture = [...conn.db.visibleArchitectureVersion.iter()].some(row => row.boardId === activeBoardId);
      // Sign-in returns to this page's #b=<slug>; the stored claim carries the slug to match it (claimForBoard).
      const slug = conn.db.visibleBoard.id.find(activeBoardId!)?.slug ?? '';
      const ok = await signInWithGuestBoard(loaded,
        guestBoard && !architecture ? { id: activeBoardId!, slug } : undefined,
        request => conn.reducers.offerGuestClaim(request), sessionStorage, GUEST_CLAIM_KEY);
      if (ok) {
        localStorage.setItem(ACCOUNT_SEEN_KEY, '1');
        intentionalDisconnect = true;
        currentConn?.disconnect();
        location.reload();
      }
    } catch {
      showError('Sign-in is unavailable. Your drawing is still saved in this browser. Please try again.');
    } finally {
      if (button) button.disabled = false;
    }
  };
  if (signIn) initSignInButton(signIn);
  initBoardsLink(boardsHref, !signIn); // signIn is set only for a guest
  document.getElementById('preview-tag')!.hidden = !config.preview;
  const connectDialog = setupConnect(config.mcpUrl, {
    privacyUrl: config.privacyUrl,
    viewer: () =>
      signedIn
        ? {
            signedIn: true,
            name: auth!.displayName(),
            agent: findAgentBoard({
              me: identityHex,
              links: conn.db.myAgentLinks.iter(),
              participants: conn.db.visibleParticipant.iter(),
              selections: conn.db.visibleSelection.iter(),
              boards: conn.db.visibleBoard.iter(),
              onScreen: activeBoardId,
              now: Date.now(),
            }),
          }
        : { signedIn: false },
    signIn,
  });
  for (const table of [conn.db.myAgentLinks, conn.db.visibleSelection, conn.db.visibleParticipant, conn.db.visibleBoard]) {
    table.onInsert(connectDialog.refresh);
    table.onUpdate(connectDialog.refresh);
    table.onDelete(connectDialog.refresh);
  }
  const claim = signedIn ? claimForBoard(sessionStorage.getItem(GUEST_CLAIM_KEY), location.search, location.hash) : undefined;
  if (claim) {
    try {
      await conn.reducers.claimGuestBoard({ boardId: claim.boardId, code: claim.code });
      sessionStorage.removeItem(GUEST_CLAIM_KEY);
      sessionStorage.removeItem(GUEST_RECOVERY_KEY);
    } catch (error) {
      sessionStorage.setItem(GUEST_RECOVERY_KEY, claim.slug);
      if (/invalid or expired|requires a different account/.test(String(error))) sessionStorage.removeItem(GUEST_CLAIM_KEY);
      showBoardUnavailable(boardsHref, newBoardHref());
      showError('Your guest drawing is still saved in this browser. Sign out to return to it, then sign in again to save it to your account.');
      return;
    }
  }
  if (!signedIn || !hasBoardLink(location.search, location.hash)) {
    await new Promise<void>((resolve, reject) => {
      conn.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Guest board could not be loaded.')))
        .subscribe(['SELECT * FROM my_guest_board']);
    });
  }
  // A bare visit opens the guest's own board, held here until its #b= link replaces the URL below.
  let guestBoardId: bigint | undefined;
  if (!hasBoardLink(location.search, location.hash)) {
    await conn.reducers.ensureGuestBoard({fresh: new URLSearchParams(location.search).get('new') === '1'});
    guestBoardId = await waitForGuestBoard(conn);
    const url = new URL(location.href);
    url.searchParams.delete('new'); // a retried boot must not start yet another board
    window.history.replaceState(null, '', url);
  }
  // A share link (#s=<token>): record the visit, which is what makes the board readable.
  const shareToken = shareTokenOf(location.hash);
  if (shareToken !== null) {
    try {
      await conn.reducers.openSharedLink({ token: shareToken });
    } catch (error) {
      // Only a dead link ends here; anything else (network, auth) rethrows to runBootWithRecovery's retry.
      if (!/no longer shared/.test(String(error))) throw error;
      showBoardUnavailable(boardsHref, newBoardHref(), LINK_GONE);
      return;
    }
  }
  // The board the #s= link opened; once the visitor switches away, "no longer shared" copy no longer applies.
  let linkBoardId: bigint | undefined;
  const linkGone = () => (shareToken !== null && activeBoardId === linkBoardId ? LINK_GONE : undefined);
  await conn.reducers.joinBoard({
    displayName: signedIn ? auth!.displayName() : `human-${identityHex.slice(0, 6)}`,
    kind: 'human',
  });

  const boardFailed = (ctx: { event?: unknown }) => {
    console.error('Board subscription failed', ctx.event);
    showBoardUnavailable(boardsHref, newBoardHref(), linkGone());
    showError('We could not load this board. Please try again.');
  };
  // The board list comes first: the board tables return only the boards this connection opens (RC-605).
  const listed = await new Promise<boolean>(resolve =>
    subscribeLists(conn, () => resolve(true), ctx => { boardFailed(ctx); resolve(false); }, signedIn && config.mcpUrl !== undefined));
  if (!listed) return;
  const picked = guestBoardId === undefined
    ? selectBoard(conn.db.visibleBoard.iter(), location.search, location.hash, conn.db.myBoards.iter())
    : conn.db.visibleBoard.id.find(guestBoardId) ?? 'Your board has not arrived. Please reload.';
  if (typeof picked === 'string') {
    showBoardUnavailable(boardsHref, newBoardHref(), shareToken !== null ? LINK_GONE : undefined);
    return;
  }
  // The board on screen and the board its diff compares against.
  const boardsShown = (id: bigint): bigint[] => {
    const version = conn.db.visibleArchitectureVersion.boardId.find(id);
    const base = version ? comparisonBoard(version, conn.db.visibleArchitectureVersion.iter()) : null;
    return base === null || base === id || !conn.db.visibleBoard.id.find(base) ? [id] : [id, base];
  };
  let opened = '';
  // A failed switch keeps the previous open_board row, so the board on screen stays.
  const openShown = (id: bigint): Promise<boolean> => {
    const ids = boardsShown(id);
    opened = ids.join();
    return openBoards(conn, ids);
  };
  if (!(await openShown(picked.id))) {
    boardFailed({});
    return;
  }

  subscribeBoard(
    conn,
    () => {
      // A share link stays #s=, so reload works and the visitor can pass it on.
      if (shareToken === null) showBoardLink(picked);
      let board = picked;
      title.textContent = board.name;
      let boardId = board.id;
      activeBoardId = boardId;
      if (shareToken !== null) linkBoardId = boardId;
      const myRow = () => [...conn.db.myBoards.iter()].find(row => row.boardId === boardId);
      const permission = () => [...(conn.db.myBoardPermissions?.iter() ?? [])].find(row => row.boardId === boardId);
      const publicExample = () => viewOnly(myRow(), signedIn, permission());
      const canManage = () => permission()?.canManage ?? myRow()?.access === 'owner';
      const role = (): Role => {
        const row = myRow();
        const capability = permission();
        if (capability) return capability.canManage ? 'owner' : capability.canEdit ? 'editor' : 'viewer';
        if (row?.access === 'owner') return 'owner';
        if (row?.access === 'grant' || row?.access === 'team' || (row?.access === 'link' && row.linkMode === 'edit')) return 'editor';
        return 'viewer';
      };
      const signInButton = document.getElementById('sign-in');
      const syncSignInLabel = () => {
        const row = myRow();
        if (signInButton) signInButton.textContent = row?.access === 'link' && row.linkMode === 'edit' && !signedIn ? 'sign in to edit' : 'sign in';
      };
      syncSignInLabel();
      const getVersion = () => conn.db.visibleArchitectureVersion.boardId.find(boardId) ?? undefined;
      // hidden on versioned boards, like rename (canRename)
      const syncAccessLine = () => paintAccessLine(getVersion() ? undefined : myRow(), permission());
      syncAccessLine();
      const factual = () => getVersion()?.assertionMode === 'fact';
      let showDiff = getVersion()?.assertionMode === 'intent';
      // Rows that arrive after the first paint fade in (an agent drawing live); a load or board switch does not.
      let enter = false;
      let diffBoard = getVersion() ? boardId : undefined;
      let comparison: ReturnType<typeof diffScene> | undefined;
      const rebuildComparison = () => {
        const version = getVersion();
        const baseId = version ? comparisonBoard(version, conn.db.visibleArchitectureVersion.iter()) : null;
        comparison = baseId === null ? undefined : diffScene(
          [...conn.db.visibleNode.iter()].filter(n => n.boardId === baseId),
          [...conn.db.visibleEdge.iter()].filter(e => e.boardId === baseId),
          getAllNodes(), getAllEdges(),
          // a branch of a hand-drawn board: its labels and docs are the content
          { content: version?.historyId === 0n },
        );
      };

      const getAllNodes = () => [...conn.db.visibleNode.iter()].filter(n => n.boardId === boardId);
      const getAllEdges = () => [...conn.db.visibleEdge.iter()].filter(e => e.boardId === boardId);
      // Chart rows of this board by node id: rebuilt on table change, read per
      // frame. The chart subscription is unfiltered, like node and edge.
      let charts = new Map<bigint, Chart>();
      const rebuildCharts = () => {
        charts = new Map([...conn.db.visibleChart.iter()].filter(c => c.boardId === boardId).map(c => [c.nodeId, c]));
      };
      // Hand-set edge weights (RC-688), the same way: medium and bold only.
      let edgeWeights = new Map<bigint, string>();
      const rebuildEdgeWeights = () => {
        edgeWeights = new Map([...conn.db.visibleEdgeWeight.iter()].filter(w => w.boardId === boardId).map(w => [w.edgeId, w.weight]));
      };
      // Library icons of this board by node id (spec 2026-10-18), like charts.
      let icons = new Map<bigint, string>();
      const rebuildIcons = () => {
        icons = new Map([...conn.db.visibleNodeIcon.iter()].filter(r => r.boardId === boardId).map(r => [r.nodeId, r.icon]));
      };
      // Incident triage, like icons: chart pins, the shared time window, and the
      // incident and lifetime rows (empty on a module that predates them).
      let anchors = new Map<bigint, { targetKind: string; targetId: bigint }>();
      let timeWindow: TimeWindow | null = null;
      let incident: { status: string; title: string } | null = null;
      let ephemeral = false;
      const rebuildIncident = () => {
        anchors = new Map([...conn.db.visibleChartAnchor.iter()].filter(a => a.boardId === boardId).map(a => [a.nodeId, a]));
        const w = conn.db.visibleBoardWindow.boardId.find(boardId);
        timeWindow = w ? { startMs: w.startMs, endMs: w.endMs } : null;
        incident = conn.db.visibleIncident.boardId.find(boardId) ?? null;
        ephemeral = conn.db.visibleBoardLifetime.boardId.find(boardId)?.isEphemeral ?? false;
        renderWindow();
      };
      const setWindow = (w: TimeWindow | null) => {
        const call = w ? conn.reducers.setBoardWindow({ boardId, ...w }) : conn.reducers.clearBoardWindow({ boardId });
        void call.catch(err => showError(`Time window not changed: ${String(err)}`));
      };
      // The rail line under Live: incident state, then the shared window and its controls.
      function renderWindow(): void {
        const row = document.getElementById('window-row');
        if (!row) return;
        row.replaceChildren();
        const hasTimeChart = [...charts.values()].some(c => c.type === 'timeseries');
        row.hidden = incident === null && !ephemeral && timeWindow === null && !hasTimeChart;
        if (incident !== null || ephemeral) {
          const line = document.createElement('div');
          line.textContent = incident ? `Incident · ${incident.status}${ephemeral ? ' · ephemeral board' : ''}` : 'Ephemeral board';
          row.append(line);
        }
        if (timeWindow !== null) {
          const line = document.createElement('div');
          line.textContent = `Time window · ${formatWindow(timeWindow)}`;
          row.append(line);
          if (!publicExample()) {
            const w = timeWindow;
            row.append(windowButton('Zoom out', () => setWindow(zoomOut(w))), windowButton('Clear', () => setWindow(null)));
          }
        } else if (hasTimeChart && !publicExample()) {
          const line = document.createElement('div');
          line.textContent = 'Alt-drag across a time chart to set everyone\'s time window.';
          row.append(line);
        }
      }
      function windowButton(label: string, run: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'session-route-play live-action';
        b.textContent = label;
        b.addEventListener('click', run);
        return b;
      }
      mountWindowBrush(w => {
        if (!publicExample()) setWindow(w);
      });
      // Change notes (spec 2026-10-16): derived from the note rows, this board's
      // refs and its visible edges; rebuilt after rebuildRefs, never per frame.
      let changeNotes: NoteIndex = buildNoteIndex([], new Map(), []);
      const rebuildChangeNotes = () => {
        changeNotes = buildNoteIndex([...conn.db.visibleChangeNote.iter()].filter(n => n.boardId === boardId), refRows, getEdges());
      };
      // Threats (spec 2026-10-16): members-only rows, empty for everyone else.
      let threats: ThreatIndex = buildThreatIndex([]);
      const rebuildThreats = () => {
        threats = buildThreatIndex([...conn.db.visibleThreat.iter()].filter(t => t.boardId === boardId));
      };
      // Code refs: rebuilt on table change, never per frame. Orphans (target
      // deleted) are dropped here so neither badge nor inspector sees them.
      let refsByTarget = new Map<string, RefSummary[]>();
      const refRows = new Map<bigint, CodeRef>();
      let badgeTitles = new Map<bigint, BadgeTitle>();
      let edgeBadgeTitles = new Map<bigint, BadgeTitle>();
      let edgeBadges = new Map<bigint, EdgeRefBadge>();
      let nodeBadges = new Map<bigint, NodeBadgeBase>();
      let liveRefCount = 0;
      // Stale / ambiguous refs and the targets that hold them (G12).
      let refStatus = { stale: 0, ambiguous: 0 };
      let staleOwners: StaleOwner[] = [];
      let staleCursor = 0;
      const rebuildRefs = () => {
        refsByTarget = buildRefsIndex(conn.db.visibleCodeRef.iter(), boardId);
        liveRefCount = pruneOrphanRefs(
          refsByTarget,
          new Set(getAllNodes().map(n => n.id)),
          new Set(getAllEdges().map(e => e.id))
        );
        refRows.clear();
        for (const r of conn.db.visibleCodeRef.iter()) {
          if (r.boardId === boardId) {
            refRows.set(r.id, r);
          }
        }
        // Titles (and their revision, folded into the badge key) once per
        // table change, so a range shift or a replace updates the tooltip.
        badgeTitles = buildBadgeTitles(refsByTarget, badgeTitles);
        nodeBadges = buildNodeBadges(refsByTarget, badgeTitles);
        edgeBadgeTitles = buildBadgeTitles(refsByTarget, edgeBadgeTitles, 'edge');
        edgeBadges = buildEdgeBadges(refsByTarget, edgeBadgeTitles);
        // Only owners on the canvas: a hidden target never opens in the
        // inspector, so the rail line counts none of its refs. Hiding a node
        // or edge is a table change, so this stays current.
        const { owners, stale, ambiguous } = visibleStale(
          refsByTarget,
          new Set(getNodes().map(n => n.id)),
          new Set(getEdges().map(e => e.id))
        );
        staleOwners = owners;
        refStatus = { stale, ambiguous };
      };
      // Each click selects the next owner and opens its first stale ref.
      const selectStale = () => {
        if (staleOwners.length === 0) {
          return;
        }
        const owner = staleOwners[staleCursor % staleOwners.length];
        staleCursor = (staleCursor + 1) % staleOwners.length;
        editor.expandedRef = owner.refId;
        if (owner.kind === 'edge') {
          editor.selectEdges([owner.id]);
        } else {
          editor.selectNodes([owner.id]);
        }
      };
      // Each click on the rail's change note line selects the next visible anchor.
      let noteCursor = 0;
      const selectNote = () => {
        const visible = new Set(getNodes().map(n => n.id));
        const anchors = [...changeNotes.byAnchor.keys()].filter(id => visible.has(id)).sort((a, b) => (a < b ? -1 : 1));
        if (anchors.length === 0) return;
        editor.selectNodes([anchors[noteCursor % anchors.length]]);
        noteCursor = (noteCursor + 1) % anchors.length;
      };
      // The open threat (spec 2026-10-16 T11): local state, never stored. Its panel docks in the
      // inspector and its blast is rebuilt when it opens, its options change or a table changes; never per frame.
      let openThreat: { anchorId: bigint; threatId: bigint; direction: Direction; depth: Depth } | null = null;
      let blast: Blast | null = null;
      let blastDots: { stop(): void } | null = null;
      let blastDotsKey = '';
      let spreading = false; // playSpread cannot be cancelled: the loop waits, a second press is ignored
      let threatHover: bigint | null = null;
      const threatPanel = document.createElement('div');
      let threatCardKeyDrawn = '';
      // Repaints replace the panel's buttons and an inspector rebuild detaches the panel: either drops
      // focus, so it is put back on the control with the same data-key (indexes shift as rows come and go).
      const panelFocusKey = () => (threatPanel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined);
      const refocusPanel = (key: string | undefined) => {
        if (key !== undefined && !threatPanel.contains(document.activeElement)) threatPanel.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
      };
      const threatBlast = (anchorId: bigint, opts: { direction: Direction; depth: Depth }): Blast => {
        const nodes = getNodes();
        const names = new Map(nodes.map(n => [n.id, nodeName(n)]));
        // Only the kinds that can hold a threat join the blast or count as clear.
        const ids = nodes.filter(n => isThreatKind(n.kind)).map(n => n.id);
        return blastRadius(anchorId, ids, getEdges(), id => names.get(id) ?? '', opts);
      };
      const computeBlast = (): Blast | null => (openThreat === null ? null : threatBlast(openThreat.anchorId, openThreat));
      const stopBlastDots = () => {
        blastDots?.stop();
        blastDots = null;
        blastDotsKey = '';
      };
      // Runs after each render: restarts the loop only when its legs or their end nodes changed.
      const syncBlastDots = () => {
        if (blast === null || spreading) { stopBlastDots(); return; }
        const center = nodeCenter();
        const legs = blastLegs(blast, getEdges());
        const key = legs.map(l => `${l.edgeId}:${JSON.stringify(center(l.from))}:${JSON.stringify(center(l.to))}`).join('|');
        if (key === blastDotsKey) return;
        blastDots?.stop();
        blastDots = loopBlast(world, legs, center);
        blastDotsKey = key;
      };
      // The row being hovered in the panel lights its node; reapplied after each render.
      const lightThreatRow = () => {
        world.querySelector('.tc-lit')?.classList.remove('tc-lit');
        if (threatHover !== null) world.querySelector(`[data-id="${threatHover}"]`)?.classList.add('tc-lit');
      };
      const paintThreatCard = () => {
        const o = openThreat;
        if (o === null || blast === null) return;
        const nodes = new Map(getAllNodes().map(n => [n.id, n]));
        const model: ThreatCardModel = {
          threats: threats.byAnchor.get(o.anchorId) ?? [],
          selected: o.threatId,
          blast,
          direction: o.direction,
          depth: o.depth,
          nodeLabel: id => (nodes.has(id) ? nodeName(nodes.get(id)!) : ''),
          nodePii: id => nodes.has(id) && looksPii(nodes.get(id)!),
          canContain: signedIn && !publicExample(),
        };
        // Most table changes (route events, sessions) touch nothing the panel draws: keep its DOM.
        const key = threatCardKey(model);
        if (key === threatCardKeyDrawn) return;
        threatCardKeyDrawn = key;
        const focused = panelFocusKey();
        threatPanel.replaceChildren(renderThreatCard(model, threatActions));
        refocusPanel(focused);
      };
      const updateThreat = (patch: Partial<NonNullable<typeof openThreat>>) => {
        if (openThreat === null) return;
        openThreat = { ...openThreat, ...patch };
        blast = computeBlast();
        paintThreatCard();
        rerender();
      };
      const setThreatContained = (id: bigint, contained: boolean) =>
        conn.reducers.setThreatContained({ id, contained }).catch(err => showError((err as Error).message));
      const playThreatSpread = () => {
        if (spreading || blast === null) return;
        spreading = true;
        stopBlastDots();
        void playSpread(world, blastLegs(blast, getEdges()), nodeCenter()).finally(() => {
          spreading = false;
          syncBlastDots(); // no-op when the threat closed meanwhile
        });
      };
      const threatActions: ThreatCardActions = {
        selectThreat: threatId => updateThreat({ threatId }),
        setDirection: direction => updateThreat({ direction }),
        setDepth: depth => updateThreat({ depth }),
        hoverNode: id => { threatHover = id; lightThreatRow(); },
        playSpread: playThreatSpread,
        // D12 as change notes: the module refuses agents and anyone without edit access.
        setContained: setThreatContained,
      };
      const openThreatView = () => (openThreat === null ? undefined : threats.byAnchor.get(openThreat.anchorId)?.find(t => t.id === openThreat!.threatId));
      const markerOf = (anchorId: bigint) => world.querySelector<SVGGElement>(`[data-id="${anchorId}"] > .board-marker[role="button"]`);
      const closeThreat = () => {
        const o = openThreat;
        if (o === null) return;
        const hadFocus = threatPanel.contains(document.activeElement);
        openThreat = null;
        threatCardKeyDrawn = '';
        blast = null;
        threatHover = null;
        rerender(); // clears the blast, stops the dots and undocks the panel
        if (hadFocus) markerOf(o.anchorId)?.focus();
      };

      // The marker's peek: what the worst threat is and how far it reaches, beside the node on the
      // side the blast does not travel. Shown on hover or focus, never while that threat is open.
      const PEEK_OPTS = { direction: 'both', depth: 2 } as const; // the panel's defaults
      const peekEl = document.createElement('div');
      peekEl.className = 'threat-peek';
      peekEl.setAttribute('role', 'tooltip');
      peekEl.hidden = true;
      wrap.append(peekEl);
      let peek: { anchorId: bigint; near: bigint[] } | null = null;
      // Esc dismisses the peek until the pointer or focus leaves that marker: a marker rebuilt under a
      // still pointer (its threat changed) fires pointerover again.
      let peekDismissed: bigint | null = null;
      const hidePeek = () => {
        peek = null;
        peekEl.hidden = true;
      };
      const placePeek = () => {
        if (peek === null) return;
        const byId = new Map(getNodes().map(n => [n.id, n]));
        const n = byId.get(peek.anchorId);
        if (n === undefined) { hidePeek(); return; }
        const screen = (id: bigint) => {
          const r = nodeRect(byId.get(id)!, editor.overrides);
          const tl = viewport.worldToScreen(r.x, r.y);
          const br = viewport.worldToScreen(r.x + r.w, r.y + r.h);
          return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        };
        const near = peek.near.filter(id => byId.has(id)).map(screen);
        const ins = chromeInsets(wrap);
        const at = peekPosition(screen(n.id), near, { w: peekEl.offsetWidth, h: peekEl.offsetHeight },
          { left: ins.left + 12, top: ins.top + 12, right: wrap.clientWidth - ins.right - 12, bottom: wrap.clientHeight - ins.bottom - 12 });
        peekEl.style.left = `${at.x}px`;
        peekEl.style.top = `${at.y}px`;
      };
      const showPeek = (anchorId: bigint) => {
        const list = threats.byAnchor.get(anchorId);
        if (list === undefined || openThreat?.anchorId === anchorId || !getNodes().some(n => n.id === anchorId)) { hidePeek(); return; }
        const b = threatBlast(anchorId, PEEK_OPTS);
        const all = new Map(getAllNodes().map(n => [n.id, n]));
        let hops = 0;
        let pii = 0;
        for (const [id, x] of b.nodes) {
          hops = Math.max(hops, x.hop);
          if (all.has(id) && looksPii(all.get(id)!)) pii++;
        }
        peekEl.replaceChildren(renderThreatPeek({ threat: list[0], total: list.length, reach: { nodes: b.nodes.size, hops, pii } }));
        peekEl.hidden = false;
        peek = { anchorId, near: [...b.nodes].filter(([, x]) => x.hop === 1).map(([id]) => id) };
        placePeek();
      };

      /** Opens a threat on a visible node: its panel docks in the inspector and its blast plays. */
      const openThreatCard = (anchorId: bigint, threatId?: bigint, keyboard = false) => {
        const list = threats.byAnchor.get(anchorId);
        if (list === undefined || !getNodes().some(n => n.id === anchorId)) return;
        hidePeek();
        openThreat = {
          anchorId,
          threatId: threatId ?? list[0].id,
          direction: openThreat?.direction ?? 'both',
          depth: openThreat?.depth ?? 2,
        };
        blast = computeBlast();
        threatCardKeyDrawn = '';
        paintThreatCard();
        editor.selectNodes([anchorId]);
        rerender(); // the anchor may already be selected: dock the panel and draw the blast anyway
        if (keyboard) threatPanel.querySelector<HTMLElement>('button')?.focus();
      };
      // Threats on visible anchors in a stable order (anchor id, then worst first); open ones first.
      const stepThreat = (step: 1 | -1): { anchorId: bigint; threatId: bigint } | null => {
        const visible = new Set(getNodes().map(n => n.id));
        const all = [...threats.byAnchor].filter(([a]) => visible.has(a)).sort(([a], [b]) => (a < b ? -1 : 1))
          .flatMap(([anchorId, list]) => list.map(t => ({ anchorId, threatId: t.id, contained: t.contained })));
        const pool = all.some(t => !t.contained) ? all.filter(t => !t.contained) : all;
        if (pool.length === 0) return null;
        const at = pool.findIndex(t => t.anchorId === openThreat?.anchorId && t.threatId === openThreat?.threatId);
        return pool[at < 0 ? (step > 0 ? 0 : pool.length - 1) : (at + step + pool.length) % pool.length];
      };
      const nextThreat = () => stepThreat(1);
      // Called on every table change: the anchor or the threat may be gone (Review Focus 3).
      const syncThreatCard = () => {
        if (peek !== null) showPeek(peek.anchorId); // its threat, text or reach may have changed; gone hides it
        if (openThreat === null) return;
        if (!threatCardStillValid(openThreat, threats, new Set(getNodes().map(n => n.id)))) {
          closeThreat();
          return;
        }
        blast = computeBlast();
        paintThreatCard();
      };
      const markerAt = (target: EventTarget | null) => {
        const marker = target instanceof Element ? target.closest('.board-marker[role="button"]') : null;
        const id = marker?.closest<SVGGElement>('[data-id]')?.dataset.id;
        return id === undefined ? null : BigInt(id);
      };
      const onMarker = (target: EventTarget | null, keyboard = false): boolean => {
        const anchorId = markerAt(target);
        if (anchorId === null) return false;
        if (openThreat?.anchorId === anchorId) closeThreat(); // a second click collapses it (T1)
        else openThreatCard(anchorId, undefined, keyboard);
        return true;
      };
      svg.addEventListener('click', evt => { onMarker(evt.target); });
      svg.addEventListener('keydown', evt => {
        if ((evt.key === 'Enter' || evt.key === ' ') && onMarker(evt.target, true)) {
          evt.preventDefault();
          evt.stopPropagation(); // Space must not also arm the canvas pan
        }
      });
      for (const [on, off] of [['pointerover', 'pointerout'], ['focusin', 'focusout']] as const) {
        svg.addEventListener(on, evt => {
          const id = markerAt(evt.target);
          if (id !== null && id !== peekDismissed && peek?.anchorId !== id) showPeek(id);
        });
        svg.addEventListener(off, evt => {
          if (markerAt((evt as PointerEvent | FocusEvent).relatedTarget) !== peekDismissed) peekDismissed = null;
          if (peek !== null && markerAt(evt.target) !== null && markerAt((evt as PointerEvent | FocusEvent).relatedTarget) !== peek.anchorId) hidePeek();
        });
      }
      // J/K step through threats like a list (vim, Gmail, Linear); P plays the open one's spread;
      // Esc hides a peek, then closes the open threat, before the canvas's own Esc clears the selection.
      // Typing never triggers them.
      document.addEventListener('keydown', evt => {
        const target = evt.target instanceof Element ? evt.target : null;
        if (evt.metaKey || evt.ctrlKey || evt.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (evt.key === 'Escape' && peek !== null) {
          evt.stopPropagation();
          peekDismissed = peek.anchorId;
          hidePeek();
          return;
        }
        if (evt.key === 'Escape' && openThreat !== null) {
          evt.stopPropagation();
          closeThreat();
          return;
        }
        const key = evt.key.toLowerCase();
        if ((key === 'j' || key === 'k') && !evt.shiftKey) {
          const t = stepThreat(key === 'j' ? 1 : -1);
          if (t === null) return;
          evt.preventDefault();
          openThreatCard(t.anchorId, t.threatId);
        } else if (key === 'p' && !evt.shiftKey && openThreat !== null) {
          evt.preventDefault();
          playThreatSpread();
        }
      });
      const refAlive = (id: bigint): boolean => {
        const row = refRows.get(id);
        return row !== undefined && refsByTarget.has(`${row.targetKind}:${row.targetId}`);
      };
      const getSession = (): Session | null => {
        for (const s of conn.db.visibleSession.iter()) {
          if (s.boardId === boardId) {
            return s;
          }
        }
        return null;
      };
      const getRemote = () => [...conn.db.visibleSessionRemote.iter()].find(r => r.boardId === boardId) ?? null;
      // Build labels/history only on table changes; drag frames reuse markers.
      let routeModel: RouteModel | null = null;
      const rebuildRoute = () => {
        const route = [...conn.db.visibleSessionRoute.iter()].find(r => r.boardId === boardId) ?? null;
        routeModel = buildRouteModel(route, [...conn.db.visibleRouteEvent.iter()], new Map(getAllNodes().map(n => [n.id, n])));
      };
      const agentFocus = (): Node | null => {
        const agents = new Set(
          [...conn.db.visibleParticipant.iter()].filter(p => p.kind === 'agent' && presenceOf(p, Date.now()) !== 'gone').map(p => p.identity.toHexString())
        );
        if (agents.size === 0) {
          return null;
        }
        for (const sel of conn.db.visibleSelection.iter()) {
          if (sel.boardId !== boardId || sel.nodeIds.length === 0 || !agents.has(sel.identity.toHexString())) {
            continue;
          }
          return getAllNodes().find(x => x.id === sel.nodeIds[0]) ?? null;
        }
        return null;
      };
      // Deleted paths from the session's coverage, parsed once per coverage
      // string: rerender runs per frame during drags.
      let deletedFor: { json: string; paths: Set<string> } = { json: '', paths: new Set() };
      const deletedPaths = (): Set<string> => {
        const json = getSession()?.coverage ?? '';
        if (json !== deletedFor.json) {
          deletedFor = { json, paths: new Set(parseCoverage(json).deleted) };
        }
        return deletedFor.paths;
      };
      const sessionEl = document.getElementById('session-row') as HTMLDivElement;
      let editorScheme = readEditorScheme();
      // The reader's explicit ⌥C on this board, if any (G42).
      let overlayPref = readOverlayPref(board.name);
      // Default on for a session board with refs, unless toggled; off and
      // inert on a plain board. Runs on table changes, before the rerender.
      const syncCodeOverlay = () => {
        const want = resolveCodeOverlay({ hasSession: getSession() !== null, refCount: liveRefCount, pref: overlayPref });
        if (want !== editor.codeOverlay) {
          editor.setCodeOverlay(want);
        }
      };
      // Disclose badges hidden by the 60% density rule while the switch reads on (P1).
      const overlayHintEl = document.getElementById('code-overlay-hint') as HTMLDivElement;
      const syncOverlayHint = () => {
        const text = codeOverlayHint({
          codeOverlay: editor.codeOverlay && getSession() !== null,
          dense: viewport.scale < 0.6,
          refCount: liveRefCount,
        });
        if (overlayHintEl.textContent !== (text ?? '')) {
          overlayHintEl.textContent = text ?? '';
        }
        if (overlayHintEl.hidden !== (text === null)) {
          overlayHintEl.hidden = text === null;
        }
      };
      const renderSession = () => {
        const session = getSession();
        // The rail hint follows the session row arriving or going (G10); the
        // code overlay switch and its ? rows exist only with one (G42).
        editor.syncRail();
        syncSessionChrome(session !== null);
        const focus = agentFocus();
        const coverage = parseCoverage(session?.coverage ?? '');
        renderSessionBlock(sessionEl, {
          session,
          coverage,
          // Label first, path in the title (G37).
          agentFocus: focus !== null ? nodeName(focus) : null,
          agentFocusPath: focus?.sublabel,
          now: Date.now(),
          codeOverlay: editor.codeOverlay,
          refCount: liveRefCount,
          editorScheme,
          refStatus,
          onSelectStale: selectStale,
          changeNotes: { counts: changeNotes.counts, unconfirmed: coverage.unconfirmed?.length ?? 0 },
          onSelectNote: selectNote,
          // Every threat counts; those on hidden nodes are named (no marker), and the button opens only drawn ones.
          threats: threatRailText(threats, id => { const n = getAllNodes().find(x => x.id === id); return n === undefined ? '' : nodeName(n); }, new Set(getNodes().map(n => n.id))),
          threatsContained: threats.open === 0,
          onSelectThreat: () => { const t = nextThreat(); if (t !== null) openThreatCard(t.anchorId, t.threatId); else showError('Threats are on hidden nodes. Show them to open.'); },
          route: routeModel,
          onSelectWaypoint: nodeId => editor.selectNodes([nodeId]),
          onPlayRoute: () => {
            const ids = (routeModel?.waypoints ?? []).filter(w => w.availability === 'visible').map(w => w.nodeId);
            playRoute(world, ids, routeLegs(ids, getEdges()), nodeCenter());
          },
          trace: traceSummary(),
          onReplayTrace: replayTrace,
        });
        syncOverlayHint();
      };
      const nodeCenter = () => {
        const byId = new Map(getNodes().map(n => [n.id, n]));
        return (id: bigint) => {
          const n = byId.get(id);
          return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
        };
      };
      // ---- live tap: connected only while Live is on ----
      let liveMap: ReadonlyMap<bigint, LiveEdge> | undefined;
      // The last HISTORY_MS of live windows per edge, for "Save as charts".
      const liveHistory = new Map<bigint, LivePoint[]>();
      const saveLiveCharts = async () => {
        const nodesById = new Map(getAllNodes().map(n => [n.id, n]));
        const placeBoard = boardId, actionOps = ops;
        // New charts go in a row under the drawing, each under its edge where there is room.
        const W = 320, H = 176, at = (v: number) => Math.round(v / 4) * 4;
        const y = at(Math.max(0, ...getAllNodes().map(n => n.y + n.h)) + 48);
        const placed: number[] = [];
        await actionOps.history.batch('save live charts', async () => {
          for (const [edgeId, points] of liveHistory) {
            const edge = getEdges().find(e => e.id === edgeId);
            const csv = liveCsv(points);
            if (!edge || csv.split('\n').length < 3) continue; // a series needs two rows
            // A live chart already pinned to this edge takes the new numbers; otherwise a new one sits beside the edge.
            const own = [...anchors].find(([chartId, a]) => a.targetKind === 'edge' && a.targetId === edgeId && charts.get(chartId)?.source === LIVE_CHART_SOURCE);
            if (own) {
              await actionOps.setChartDataAction(own[0], { csv });
              continue;
            }
            const a = nodesById.get(edge.fromNode), b = nodesById.get(edge.toNode);
            if (!a || !b) continue;
            let x = at((a.x + a.w / 2 + b.x + b.w / 2) / 2 - W / 2);
            while (placed.some(p => Math.abs(p - x) < W + 24)) x += W + 24;
            placed.push(x);
            const id = await actionOps.createChartAction({
              boardId: placeBoard,
              label: `${a.label} → ${b.label}`,
              sublabel: 'live p50 / p95',
              x,
              y,
              w: W,
              h: H,
              type: 'timeseries',
              csv,
              options: '{"unit":"ms"}',
              source: LIVE_CHART_SOURCE,
            });
            await conn.reducers.anchorChart({ nodeId: id, targetKind: 'edge', targetId: edgeId });
          }
        });
      };
      let liveSession: LiveSession | null = null;
      let liveState: LiveState | null = null;
      const liveRow = document.getElementById('live-row') as HTMLButtonElement;
      const liveStatus = document.getElementById('live-status') as HTMLDivElement;
      const liveToken = async (): Promise<string | null> => {
        if (auth?.hasSession()) return auth.freshToken().catch(() => null);
        return readAnonymousToken(ANON_TOKEN_KEY, SHARE_LOCAL_GUEST) ?? null;
      };
      const liveButton = (label: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'session-route-play live-action';
        b.textContent = label;
        b.addEventListener('click', run);
        return b;
      };
      const renderLive = () => {
        const on = liveSession !== null;
        liveRow.setAttribute('aria-pressed', on ? 'true' : 'false');
        liveStatus.hidden = !on || liveState === null;
        liveStatus.replaceChildren();
        if (!on || liveState === null) return;
        const line = document.createElement('div');
        const s = liveState;
        line.textContent =
          s.kind === 'connecting' ? 'Connecting…'
          : s.kind === 'no-tap' ? 'No live source on this board yet.'
          : s.kind === 'waiting' ? 'Tap connected. Waiting for traffic.'
          : s.kind === 'live' ? `Live · ${s.edges} edge${s.edges === 1 ? '' : 's'}${s.unmapped > 0 ? ` · ${s.unmapped} unmapped call${s.unmapped === 1 ? '' : 's'}` : ''}`
          : s.reason;
        liveStatus.append(line);
        if (s.kind === 'no-tap') {
          liveStatus.append(liveButton('Copy a prompt for your agent', () => {
            void copyText(tapPrompt(boardId)).then(ok => { if (!ok) showError(tapPrompt(boardId)); });
          }));
        }
        if (s.kind === 'live' && !publicExample() && liveMap && liveMap.size > 0) {
          liveStatus.append(liveButton('Pin as latency', () => {
            const pins = [...(liveMap ?? new Map<bigint, LiveEdge>())];
            void Promise.all(pins.map(([edgeId, e]) => conn.reducers.setEdgeLatency({ edgeId, latencyMs: e.p50, source: 'local' })))
              .catch(err => showError(`Pin failed: ${String(err)}`));
          }));
        }
        if (!publicExample() && liveHistory.size > 0) {
          liveStatus.append(liveButton('Save as charts', () => {
            void saveLiveCharts().catch(err => showError(`Save failed: ${String(err)}`));
          }));
        }
      };
      const stopLive = () => {
        liveSession?.stop();
        liveSession = null;
        liveState = null;
        liveMap = undefined;
        renderLive();
        rerender();
      };
      const startLive = () => {
        if (config.mcpUrl === undefined) return;
        liveHistory.clear();
        const session = new LiveSession({
          url: liveUrl(config.mcpUrl, boardId),
          token: liveToken,
          onState: st => {
            if (liveSession !== session) return;
            liveState = st;
            renderLive();
          },
          onWindow: w => {
            if (liveSession !== session) return;
            liveMap = w ? resolveLive(w, getEdges()) : undefined;
            if (w && liveMap) recordLive(liveHistory, w.t * 1000, liveMap);
            renderLive();
            rerender();
          },
        });
        liveSession = session;
        void session.start();
      };
      liveRow.hidden = config.mcpUrl === undefined;
      liveRow.addEventListener('click', () => (liveSession ? stopLive() : startLive()));

      const traceRow = () => conn.db.visibleTracePlayback.boardId.find(boardId) ?? null;
      const traceSummary = () => {
        const row = traceRow();
        if (row === null) return null;
        const spans = JSON.parse(row.spans) as TraceSpan[];
        return `${row.title || 'trace'} · ${spans.length} spans · ${traceMs(spans)}ms · ${row.source}`;
      };
      const replayTrace = () => {
        const row = traceRow();
        if (row === null) {
          showError('No trace on this board yet. An agent sends one with play_trace.');
          return;
        }
        playTrace(world, JSON.parse(row.spans) as TraceSpan[], getEdges(), nodeCenter());
      };
      // hidden rows stay in the database but not on the canvas; hiding a node
      // implicitly hides its edges
      const getNodes = () => getAllNodes().filter(n => !n.hidden);
      const getEdges = () => {
        const visible = new Set(getNodes().map(n => n.id));
        return getAllEdges().filter(
          e => !e.hidden && visible.has(e.fromNode) && visible.has(e.toNode)
        );
      };
      const countsEl = document.getElementById('board-counts') as HTMLDivElement;
      const exposureEl = document.getElementById('exposure-chip') as HTMLButtonElement;
      const chipsEl = document.getElementById('chips-row') as HTMLDivElement;
      const legendEl = document.getElementById('legend') as HTMLDivElement;
      const legendSummaryEl = document.getElementById('legend-summary') as HTMLDivElement;
      const emptyEl = document.getElementById('empty-state') as HTMLDivElement;
      mountThinkingOrb(document.getElementById('empty-orb') as HTMLCanvasElement, 'shaping', 64);
      // The agent on this board, by name, while nothing is drawn (hosted MCP §12).
      let agentHere: string | undefined;
      const syncEmpty = () =>
        syncEmptyState(emptyEl, { nodeCount: getAllNodes().length, hasSession: getSession() !== null, agent: agentHere });
      // hide-sets a reader has toggled visible as low-opacity ghosts (view-local)
      const revealedSets = new Set<string>();
      // membership lookup: which named set (if any) a hidden row belongs to
      const setNameOf = (targetKind: 'node' | 'edge', targetId: bigint): string => {
        for (const mem of conn.db.visibleHideSetMember.iter()) {
          if (mem.targetKind === targetKind && mem.targetId === targetId) {
            const hs = [...conn.db.visibleHideSet.iter()].find(h => h.id === mem.setId);
            if (hs) {
              return hs.name;
            }
          }
        }
        return 'unsorted';
      };
      const renderCounts = () => {
        const nodes = getAllNodes();
        const shownN = getNodes().length;
        const edges = getAllEdges();
        const shownE = getEdges().length;
        const session = getSession();
        renderBoardCounts(countsEl, {
          nodes: nodes.length,
          shownNodes: shownN,
          edges: edges.length,
          shownEdges: shownE,
          checkpoint: session !== null ? session.checkpoint : null,
        });
        // The branch chip took the counts' slot: they live on in the title's tooltip.
        title.title = countsEl.title;
        const share = shareState();
        // An edit link always carries code (the module's linkIncludes).
        const link = share !== null && share.mode !== '' ? { code: share.code || share.mode === 'edit', threats: share.threats } : null;
        renderExposure(exposureEl, { code: liveRefCount, threats: threats.open + threats.contained, owner: share !== null, link });
        // one chip per hide-set with counts; click toggles ghost reveal
        chipsEl.replaceChildren();
        const perSet = new Map<string, number>();
        for (const n of nodes.filter(n => n.hidden)) {
          const name = setNameOf('node', n.id);
          perSet.set(name, (perSet.get(name) ?? 0) + 1);
        }
        for (const e of edges.filter(e => e.hidden)) {
          const name = setNameOf('edge', e.id);
          perSet.set(name, (perSet.get(name) ?? 0) + 1);
        }
        for (const [name, count] of [...perSet].sort((a, b) => a[0].localeCompare(b[0]))) {
          const chip = document.createElement('button');
          const debt = name === 'unsorted';
          chip.className =
            'chip' + (debt ? ' debt' : '') + (revealedSets.has(name) ? ' active' : '');
          chip.append(name + ' ');
          const countSpan = document.createElement('span');
          countSpan.className = 'count';
          countSpan.textContent = String(count);
          chip.append(countSpan);
          chip.title = revealedSets.has(name)
            ? 'Click to re-hide this set'
            : debt
              ? 'Curation debt — hidden without a named set. Click to reveal at low opacity.'
              : 'Click to reveal this set at low opacity';
          chip.addEventListener('click', () => {
            if (revealedSets.has(name)) {
              revealedSets.delete(name);
            } else {
              revealedSets.add(name);
            }
            renderCounts();
            rerender();
          });
          chipsEl.append(chip);
        }
      };
      const ghostNodes = () =>
        getAllNodes().filter(n => n.hidden && revealedSets.has(setNameOf('node', n.id)));
      const ghostEdgesFor = (renderable: Set<bigint>) =>
        ghostEdges(getAllEdges(), renderable, getNodes, e => revealedSets.has(setNameOf('edge', e.id)));

      const viewport = new Viewport(svg, world, () => {
        // Crossing 60% zoom hides sublabels and badges, so labels re-centre
        // (G9): one re-render at the crossing; other zoom steps move chrome only.
        if (world.classList.contains('dense') !== viewport.scale < 0.6) {
          rerender();
          syncOverlayHint();
        }
        editor.syncChrome();
        placePeek();
        crayonUi.place();
      });
      let ops = new Ops(conn, identityHex, new History());
      // Red crayon drafts stay in this tab until Send (spec 2026-10-19 D3, D13).
      const crayonUi = mountCrayon({
        wrap,
        world,
        viewport,
        rectOf: id => {
          const n = getNodes().find(x => x.id === id);
          return n && nodeRect(n, editor.overrides.has(id) ? editor.overrides : editor.glide);
        },
        label: id => {
          const n = getAllNodes().find(x => x.id === id);
          return n === undefined ? '' : nodeName(n);
        },
        exists: id => getAllNodes().some(n => n.id === id),
        // The module refuses agents, read-only visitors, off-board nodes and over-long batches.
        send: (nodeIds, notes) => conn.reducers.sendMarks({ boardId, nodeIds, notes }),
        listening: () => listening(
          [...conn.db.visibleMarkWaiter.iter()].filter(w => w.boardId === boardId).map(w => ({ lastWaitAt: w.lastWaitAt.microsSinceUnixEpoch })),
          BigInt(Date.now()) * 1000n,
        ),
      });

      const railEl = document.getElementById('rail') as HTMLElement;
      const overlayRow = document.getElementById('overlay-row') as HTMLButtonElement;
      const renderLegend = () => {
        placeLegend(legendEl, railEl, wrap);
        legendEl.hidden = !editor.overlay;
        const shown = getEdges();
        // Only machine evidence gives the overlay something to say; a hand-drawn board keeps ⌥E.
        // The switch stays while the overlay is on, or while it has focus, so a keyboard user keeps their place.
        const hidden = !editor.overlay && document.activeElement !== overlayRow && !hasMachineEvidence(shown);
        if (overlayRow.hidden !== hidden) overlayRow.hidden = hidden;
        if (!editor.overlay) {
          return;
        }
        const count = (cls: string) =>
          shown.filter(e => evidenceClass(e.evidence, e.evidenceStatus) === cls).length;
        const intent = getVersion()?.assertionMode === 'intent';
        const proven = intent ? 0 : count('import') + count('source');
        renderLegendSummary(legendSummaryEl, [
          `${shown.length} shown edges`,
          intent ? 'Intent proposal · edges describe planned changes' : `${proven} proven`,
          `${count('stale')} stale source`,
          `${count('test')} test-only`,
          `${count('human')} asserted by human`,
          `${count('agent')} claimed by agent`,
          `${count('none')} none`,
        ]);
      };

      // Collapsing or restoring the rail is a class flip, not a render.
      new MutationObserver(renderLegend).observe(railEl, { attributes: true, attributeFilter: ['class'] });

      const hideIntoSet = (
        kind: 'node' | 'edge',
        ids: bigint[],
        // Called with the ids that failed to hide, so the selection can keep
        // them for retry instead of clearing as though everything succeeded.
        done: (failed: bigint[]) => void
      ) => {
        const name = prompt('Hide into set (empty = unsorted):', '');
        if (name === null) {
          return;
        }
        void (async () => {
          const failed: bigint[] = [];
          for (const id of ids) {
            try {
              if (kind === 'node') {
                await conn.reducers.setNodeHidden({ nodeId: id, hidden: true, setName: name });
              } else {
                await conn.reducers.setEdgeHidden({ edgeId: id, hidden: true, setName: name });
              }
            } catch (err) {
              failed.push(id);
              showError((err as Error).message);
            }
          }
          done(failed);
        })();
      };

      const inspectorActions = {
        // Keep only the targets that failed to hide selected, for retry.
        // Route through the editor so presence broadcasts the new selection.
        hideNodes: (nodes: Node[]) =>
          hideIntoSet('node', nodes.map(n => n.id), failed => editor.selectNodes(failed)),
        hideEdges: (edges: Edge[]) =>
          hideIntoSet('edge', edges.map(e => e.id), failed => editor.selectEdges(failed)),
        deleteEdges: (edges: Edge[]) => {
          if (factual()) return;
          const actionOps = ops;
          editor.selectedEdges.clear();
          void actionOps.history.batch(
            edges.length === 1 ? 'delete edge' : `delete ${edges.length} edges`,
            async () => {
              for (const e of edges) {
                try {
                  await actionOps.deleteEdgeAction(e);
                } catch (err) {
                  showError((err as Error).message);
                }
              }
            }
          );
        },
        expandRef: (id: bigint) => {
          editor.expandedRef = id;
          rerender();
        },
        copyRef: (ref: RefSummary) => copyText(`${ref.path}:${ref.startLine}-${ref.endLine}`),
        // `ops` is read per call: it is replaced on a board switch.
        setChartData: (nodeId: bigint, patch: ChartPatch) => ops.setChartDataAction(nodeId, patch),
        pinChart: (nodeId: bigint, target: { targetKind: string; targetId: bigint } | null) => {
          const call = target ? conn.reducers.anchorChart({ nodeId, ...target }) : conn.reducers.unanchorChart({ nodeId });
          call.catch(err => showError((err as Error).message));
        },
        // D12: the module refuses agents and anyone without edit access; the button only shows to people who may.
        markReviewed: (id: bigint, reviewed: boolean) => {
          conn.reducers.markChangeNoteReviewed({ id, reviewed }).catch(err => showError((err as Error).message));
        },
        copyFixPrompt: copyText,
        openThreatCard: (anchorId: bigint, threatId: bigint) => openThreatCard(anchorId, threatId),
      };

      // Hot path: called per-frame during drags. Counts chrome renders
      // separately (renderCounts) since its inputs only change on table
      // changes and chip toggles.
      // Position glide: render-only overrides under the editor's own.
      const glide = new Glide();
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const lastSeen = new Map<bigint, XY>(); // stored positions as of the last table change
      const lastDragged = new Map<bigint, XY & { t: number }>(); // where local drags last drew a node, and when
      const DRAG_MEMORY_MS = 2000;
      let glideRaf = 0;
      let glideDone = true; // set by the last rerender from the same clock sample it drew
      const glideTick = () => {
        glideRaf = 0; // a throwing rerender must not leave a stale id that blocks restarts
        try {
          rerender();
        } finally {
          // The rerender that saw done drew no glide positions: that is the settle.
          if (!glideDone) glideRaf = requestAnimationFrame(glideTick);
        }
      };
      // Diffs stored positions against the last table change and glides movers.
      // The first call after load or a board switch only seeds lastSeen.
      const trackMoves = () => {
        const moves: Array<{ id: bigint; from: XY; to: XY }> = [];
        const seeded = lastSeen.size > 0;
        const now = performance.now();
        for (const n of getNodes()) {
          const prev = lastSeen.get(n.id);
          lastSeen.set(n.id, { x: n.x, y: n.y });
          if (!seeded || prev === undefined || (prev.x === n.x && prev.y === n.y) || editor.overrides.has(n.id)) continue;
          const dropped = lastDragged.get(n.id);
          if (dropped !== undefined) lastDragged.delete(n.id);
          // A local drag drew the node there just now: nothing to glide.
          if (dropped !== undefined && now - dropped.t < DRAG_MEMORY_MS && dropped.x === n.x && dropped.y === n.y) continue;
          moves.push({ id: n.id, from: prev, to: { x: n.x, y: n.y } });
        }
        if (moves.length === 0 || moves.length > 300 || reduceMotion.matches) return;
        glide.begin(moves, now);
        if (glideRaf === 0) glideRaf = requestAnimationFrame(glideTick);
      };
      let syncEmbed = () => {};
      const rerender = () => {
        const now = performance.now();
        // A local drag or resize owns the node: its old track must not resurface after the preview clears.
        for (const id of editor.overrides.keys()) glide.cancel(id);
        const step = glide.step(now);
        const glideNow = step.positions;
        glideDone = step.done;
        editor.glide = glideNow;
        for (const [id, o] of editor.overrides) lastDragged.set(id, { x: o.x, y: o.y, t: now });
        const drawn = glideNow.size === 0 ? editor.overrides : new Map<bigint, XY & { w?: number; h?: number }>([...glideNow, ...editor.overrides]);
        const ghosts = ghostNodes();
        const ghostIds = new Set(ghosts.map(n => n.id));
        const ghostSetNames = new Map(ghosts.map(n => [n.id, setNameOf('node', n.id)]));
        const removedNodes = showDiff ? comparison?.removedNodes.filter(n => !n.hidden) ?? [] : [];
        const renderNodes = [...getNodes(), ...ghosts, ...removedNodes];
        const renderable = new Set(renderNodes.map(n => n.id));
        const extraEdges = ghostEdgesFor(renderable);
        // Badge inputs are O(nodes) per frame: everything that needs a ref
        // list was built once in rebuildRefs; only the size is added here.
        const refsByNode = new Map<bigint, RefBadge>();
        if (editor.codeOverlay) {
          for (const n of renderNodes) {
            const base = nodeBadges.get(n.id);
            if (base !== undefined) {
              const r = nodeRect(n, editor.overrides);
              refsByNode.set(n.id, sizedBadge(base, r.w, r.h));
            }
          }
        }
        // Markers only for anchors that are visible nodes: hidden or deleted anchors get none.
        const threatMarkers = new Map<bigint, MarkerSpec>();
        if (threats.byAnchor.size > 0) {
          for (const n of getNodes()) {
            const list = threats.byAnchor.get(n.id);
            if (list !== undefined) threatMarkers.set(n.id, threatMarker(list, n.label));
          }
        }
        const removedEdges = showDiff ? comparison?.removedEdges.filter(e => !e.hidden && renderable.has(e.fromNode) && renderable.has(e.toNode)) ?? [] : [];
        const renderEdges = [...getEdges(), ...extraEdges, ...removedEdges];
        // Edge suffixes (G51) are size-independent: the map is built in
        // rebuildRefs and the renderer picks the edges it draws.
        const refsByEdge = editor.codeOverlay ? edgeBadges : undefined;
        renderBoard(world, renderNodes, renderEdges, {
          live: liveMap,
          selection: editor.selection,
          selectedEdges: editor.selectedEdges,
          overrides: drawn,
          handles: editor.handles,
          edgeTarget: editor.edgeTarget,
          ghosts: ghostIds,
          ghostEdges: new Set(extraEdges.map(e => e.id)),
          ghostSetNames,
          overlay: editor.overlay,
          codeOverlay: editor.codeOverlay,
          refsByNode,
          refsByEdge,
          routeByNode: getSession() === null ? undefined : routeModel?.byNode,
          scale: viewport.scale,
          enter,
          nodeDiff: showDiff ? comparison?.nodeDiff : undefined,
          edgeDiff: showDiff ? comparison?.edgeDiff : undefined,
          charts,
          window: timeWindow,
          anchors,
          edgeWeights,
          icons,
          focus: focusOf(editor.hoverId, editor.selection),
          notes: changeNotes,
          threatMarkers,
          blast,
        });
        placePeek();
        crayonUi.sync();
        lightThreatRow();
        syncBlastDots();
        renderLegend();
        syncEmpty();
        const nodesById = new Map(getAllNodes().map(n => [n.id, n]));
        const panelFocused = panelFocusKey();
        renderInspector(
          getNodes().filter(n => editor.selection.has(n.id)),
          getEdges().filter(e => editor.selectedEdges.has(e.id)),
          {
            nodes: getAllNodes(),
            edges: getAllEdges(),
            nodesById,
            participants: [...conn.db.visibleParticipant.iter()],
            refsByTarget,
            session: getSession(),
            remote: getRemote(),
            privacyUrl: config.privacyUrl,
            readOnly: publicExample(),
            expandedRef: editor.expandedRef,
            editorScheme,
            deletedPaths: deletedPaths(),
            refRow: id => refRows.get(id),
            chartRow: id => conn.db.visibleChart.nodeId.find(id) ?? undefined,
            chartPin: id => anchors.get(id),
            changeNotes: changeNotes.byAnchor,
            canReview: signedIn && !publicExample(),
            threats: threats.byAnchor,
            threatPanel: openThreat === null ? undefined : { anchorId: openThreat.anchorId, el: threatPanel },
          },
          inspectorActions
        );
        refocusPanel(panelFocused);
        editor.drawTransient();
        editor.syncChrome();
        syncEmbed();
        paintPresence();
        updateArchitecture();
      };
      // Each library logo is its own chunk (node-icons.ts): a board fetches the ones it
      // shows, and the board redraws as each arrives.
      setLogoListener(rerender);
      // Export the settled board: a glide mid-flight would serialise its in-between positions.
      const exportSettled = () => {
        glide.clear();
        rerender();
        exportSvg(svg, board.name);
      };

      /** Library placement (spec "Library popover"). A chart tile places the
       *  contract example with source 'sample'; an icon tile places a node
       *  with its icon (spec 2026-10-18); a saved item inserts as one undo
       *  entry. Node picks never reach here: the Editor arms the kind. The
       *  Editor refuses factual boards before calling this. */
      const placeTemplate = async (pick: TemplatePick, at: { x: number; y: number }): Promise<bigint[]> => {
        const actionOps = ops;
        const placeBoard = boardId;
        const onArchitectureBoard = Boolean(getVersion());
        if (pick.kind === 'chart') {
          const refusal = insertRefusal(pick, null, onArchitectureBoard);
          if (refusal) throw new Error(refusal);
          return [await actionOps.createChartAction({ boardId: placeBoard, x: at.x, y: at.y, ...samplePlacement(pick.type) })];
        }
        if (pick.kind === 'icon') {
          const refusal = insertRefusal(pick, null, onArchitectureBoard);
          if (refusal) throw new Error(refusal);
          return [await actionOps.createNodeAction({ boardId: placeBoard, x: at.x, y: at.y, ...iconNodePlacement(pick.icon) })];
        }
        const parsed = parseLibraryPayload(pick.item.payload);
        if (!parsed.ok) throw new Error(parsed.error);
        const refusal = insertRefusal(pick, parsed.payload, onArchitectureBoard);
        if (refusal) throw new Error(refusal);
        return actionOps.insertLibraryAction(pick.item.name, parsed.payload, at, placeBoard);
      };

      const editor: Editor = new Editor({
        conn,
        boardId,
        svg,
        wrap,
        viewport,
        ops,
        getNodes,
        getEdges,
        rerender,
        refAlive,
        edgeRefCount: id => refsByTarget.get(`edge:${id}`)?.length ?? 0,
        onCodeOverlayChange: () => {
          overlayPref = editor.codeOverlay;
          writeOverlayPref(board.name, overlayPref);
          renderSession();
        },
        hasSession: () => getSession() !== null,
        topologyReadOnly: () => factual() || publicExample(),
        readOnly: publicExample,
        // A build with no accounts has no sign-in to offer: the module decides who may send.
        canMark: () => signedIn || !config.accounts,
        onSelectionChange: () => {
          // Selecting anything but the anchor closes the open threat: its panel lives in the anchor's inspector.
          if (openThreat !== null && !(editor.selection.size === 1 && editor.selection.has(openThreat.anchorId) && editor.selectedEdges.size === 0)) closeThreat();
          publishSelection();
        },
        placeTemplate,
        toggleLibrary: () => library.toggle(),
        addToLibrary: () => addSelectionToLibrary(),
        crayon: crayonUi.crayon,
      });
      // Chart hover: select mode only, never during a gesture or an edit.
      bindChartTooltip(svg, wrap, () => editor.hoverReady);

      /* ---- ⌘K command palette ---- */

      const asBoxes = (nodes: Node[]): Box[] =>
        nodes.map(n => ({ id: n.id, ...nodeRect(n, editor.overrides) }));
      const selectedNodes = (): Node[] => getNodes().filter(n => editor.selection.has(n.id));
      const report = (err: unknown): void => showError((err as Error).message);
      // Managers can rename and delete; versioned boards are named by their history.
      const canRename = () => !getVersion() && canManage();
      const renameBoard = () => {
        const renameBoardId = boardId;
        openBoardRename(board.name, name => conn.reducers.renameBoard({ boardId: renameBoardId, name }));
      };
      // Same managers as rename; then off the dead board, as its unavailable card would offer.
      const deleteThisBoard = () => {
        const deleteBoardId = boardId;
        openBoardDelete(board.name, () => conn.reducers.deleteBoard({ boardId: deleteBoardId }),
          () => location.assign(signedIn && boardsHref ? boardsHref : newBoardHref()), report);
      };
      const syncRenamable = () => {
        const on = canRename();
        title.classList.toggle('renamable', on);
        title.title = on ? 'Rename board' : '';
      };
      title.onclick = () => { if (canRename()) renameBoard(); };

      const paletteCommands = (): Command[] => {
        const sel = selectedNodes();
        const boxes = asBoxes(sel);
        const commands: Command[] = [];

        if (sel.length >= 2) {
          commands.push({
            id: 'tidy',
            group: 'Arrange',
            undoable: true,
            title: 'Tidy up',
            hint: 'align to grid, equal gaps',
            keys: '\u21e7T',
            preview: () => {
              const plan = tidyGrid(boxes);
              return `${sel.length} nodes \u2192 one ${plan.cols}\u00d7${plan.rows} grid, ${plan.cellW} \u00d7 ${plan.cellH} each, ${plan.gap} px gaps. Snapped to the ${GRID} px grid.`;
            },
            run: () => {
              const { placements } = tidyGrid(boxes);
              if (placements.length > 0) {
                void ops.moveNodesAction(placements).catch(report);
              }
            },
          });
          commands.push({
            id: 'distribute',
            group: 'Arrange',
            undoable: true,
            title: 'Distribute horizontally',
            hint: 'equal spacing across the selection',
            keys: '\u2325\u21e7H',
            preview: () =>
              sel.length < 3
                ? 'Needs three or more nodes to have a gap to equalise.'
                : `Equalises ${sel.length - 1} gaps, holding the outer edges.`,
            run: () => {
              const placements = distributeHorizontally(boxes);
              if (placements.length > 0) {
                void ops.moveNodesAction(placements).catch(report);
              }
            },
          });
          commands.push({
            id: 'flow',
            group: 'Arrange',
            undoable: true,
            title: 'Connect in order as a flow',
            hint: 'creates edges \u00b7 evidence: human',
            keys: '\u2318\u21b5',
            preview: () => {
              const existing = new Set(getEdges().map(e => `${e.fromNode}->${e.toNode}`));
              const todo = connectInOrder(boxes).filter(
                p => !existing.has(`${p.from}->${p.to}`)
              ).length;
              if (todo === 0) {
                return 'Those nodes are already connected in that order.';
              }
              return `Creates ${todo} edge${todo === 1 ? '' : 's'} across ${sel.length} nodes in reading order, skipping pairs that already connect. Hand-drawn edges are cited as human, not imported.`;
            },
            run: () => {
              const actionOps = ops;
              const actionBoardId = boardId;
              // Skip pairs that are already connected: re-running the command
              // would otherwise stack a second edge on every pair.
              const existing = new Set(
                getEdges().map(e => `${e.fromNode}->${e.toNode}`)
              );
              const pairs = connectInOrder(boxes).filter(
                p => !existing.has(`${p.from}->${p.to}`)
              );
              if (pairs.length === 0) {
                showError('those nodes are already connected in that order');
                return;
              }
              void actionOps.history
                .batch(`connect ${pairs.length + 1} nodes`, async () => {
                  for (const pair of pairs) {
                    await actionOps.createEdgeAction({
                      boardId: actionBoardId,
                      fromNode: pair.from,
                      toNode: pair.to,
                      label: '',
                    });
                  }
                })
                .catch(report);
            },
          });
        }

        if (sel.length >= 1) {
          const allFocal = sel.every(n => n.focal);
          commands.push({
            id: 'focal',
            group: 'Selection',
            undoable: true,
            title: allFocal ? 'Clear focal' : 'Mark focal',
            hint: 'accent is reserved for focal nodes',
            keys: 'F',
            run: () => {
              const actionOps = ops;
              void actionOps.history
                .batch(allFocal ? 'clear focal' : 'mark focal', async () => {
                  for (const n of sel) {
                    await actionOps.updateNodeAction(n.id, { focal: !allFocal });
                  }
                })
                .catch(report);
            },
          });
          commands.push({
            id: 'duplicate',
            group: 'Selection',
            undoable: true,
            title: 'Duplicate selection',
            keys: '\u2318D',
            run: () => {
              void ops.duplicateNodesAction(sel).catch(report);
            },
          });
          commands.push({
            id: 'delete',
            group: 'Selection',
            undoable: true,
            title: 'Delete selection',
            hint: `${sel.length} node${sel.length === 1 ? '' : 's'}`,
            keys: '\u232b',
            run: () => {
              void ops.deleteNodesAction(sel, getEdges()).catch(report);
            },
          });
        }

        for (const kind of ['service', 'datastore', 'external', 'boundary', 'note', 'text'] as const) {
          commands.push({
            id: `place-${kind}`,
            group: 'Place',
            title: `Place ${kind}`,
            hint: 'then click the canvas',
            run: () => editor.arm(kind),
          });
        }

        commands.push({
          id: 'library-open',
          // Not 'Place': opening the popover writes nothing, and a read-only
          // board still renames and deletes its own saved items from it. The
          // tiles themselves are refused there (Editor.armTemplate), so this
          // entry matches what the L key already does.
          group: 'General',
          title: 'Open library',
          hint: 'objects, charts and saved items',
          keys: 'L',
          keywords: ['insert', 'chart', 'template'],
          run: () => library.open(),
        });
        if (sel.length > 0) {
          commands.push({
            id: 'library-add',
            group: 'Selection',
            title: 'Add selection to library',
            hint: `${sel.length} node${sel.length === 1 ? '' : 's'}`,
            keys: '⇧L',
            run: () => addSelectionToLibrary(),
          });
        }

        commands.push(
          {
            id: 'overlay',
            group: 'View',
            title: 'Toggle evidence overlay',
            hint: 'weight and dash carry the evidence class',
            keys: '\u2325E',
            run: () => editor.toggleOverlay(),
          },
          // Session boards only (G42).
          ...codeCommands({
            hasSession: getSession() !== null,
            editorScheme,
            toggleCodeOverlay: () => editor.toggleCodeOverlay(),
            cycleEditorScheme: () => {
              editorScheme = cycleEditorScheme();
              renderSession();
              rerender();
            },
          }),
          {
            id: 'fit',
            group: 'View',
            title: 'Fit to content',
            keys: '\u21e71',
            run: () => editor.fitView(),
          },
          { id: 'zoom-reset', group: 'View', title: 'Reset zoom to 100%', keys: '\u23180', run: () => viewport.reset() },
          { id: 'export', group: 'General', title: 'Export SVG', run: exportSettled },
          ...(nextThreat() === null ? [] : [{
            id: 'threat-next', group: 'View', title: 'Open next threat', keys: 'J', hint: 'panel and blast radius', keywords: ['security', 'blast', 'vulnerable', 'compromised'],
            run: () => { const t = nextThreat(); if (t !== null) openThreatCard(t.anchorId, t.threatId); },
          }]),
          ...(openThreat === null ? [] : [
            { id: 'threat-spread', group: 'View', title: 'Play threat spread', keys: 'P', run: playThreatSpread },
            ...(openThreatView() === undefined || !signedIn || publicExample() ? [] : [{
              id: 'threat-contain', group: 'View', title: openThreatView()!.contained ? 'Reopen threat' : 'Mark threat contained', keywords: ['security'],
              run: () => { const t = openThreatView(); if (t !== undefined) void setThreatContained(t.id, !t.contained); },
            }]),
            { id: 'threat-collapse', group: 'View', title: 'Close threat', keys: 'Esc', run: closeThreat },
          ]),
          { id: 'replay-trace', group: 'View', title: 'Replay trace', keywords: ['latency', 'request', 'flow'], run: replayTrace },
          ...(canRename() ? [
            { id: 'rename-board', group: 'General', title: 'Rename board', keywords: ['title', 'name'], run: renameBoard },
            { id: 'delete-board', group: 'General', title: 'Delete this board', keywords: ['remove', 'trash'], run: deleteThisBoard },
          ] : []),
          ...(boardsHref === undefined || signIn
            ? []
            : [
                {
                  id: 'dashboard',
                  group: 'General',
                  title: 'Go to dashboard',
                  hint: 'all boards',
                  keywords: ['boards', 'home', 'back'],
                  run: () => location.assign(boardsHref),
                },
              ]),
          ...(config.mcpUrl === undefined
            ? []
            : [connectCommand(() => connectDialog.open())]),
          ...themeCommands(),
          {
            id: 'shortcuts',
            group: 'General',
            title: 'Keyboard shortcuts',
            keys: '?',
            run: () => {
              const panel = document.getElementById('shortcuts');
              if (panel !== null) {
                panel.hidden = !panel.hidden;
              }
            },
          }
        );
        commands.push(...branchCommands());
        const offeredHere = { factual: factual(), publicExample: publicExample() };
        return commands.filter(c => offeredOn(offeredHere, c));
      };

      const palette = new CommandPalette({
        commands: paletteCommands,
        context: () => {
          const n = editor.selection.size;
          const e = editor.selectedEdges.size;
          if (n > 0) {
            return `${n} node${n === 1 ? '' : 's'} selected`;
          }
          if (e > 0) {
            return `${e} edge${e === 1 ? '' : 's'} selected`;
          }
          const v = getVersion();
          return v?.assertionMode === 'intent' ? `Branch of ${boardNames().get(v.baseBoardId) ?? 'board'} · ${statusWord(v.status as BranchStatus)}` : '';
        },
      });

      // Every shortcut the palette advertises has to actually work, so the
      // arrange commands get real bindings here. None of these collide with
      // the editor's keymap (bare 1-5/f/?/space/Esc/Delete, ⌥E, ⌘0/±, ⇧1,
      // ⌘Z/⌘⇧Z, ⌘D) and ⌘K was unbound. A plain window listener suffices; it
      // skips focused text fields, as the editor's keymap does.
      const arrangeBindings: Array<{ id: string; match: (e: KeyboardEvent) => boolean }> = [
        {
          id: 'tidy',
          match: e => e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyT',
        },
        { id: 'distribute', match: e => e.altKey && e.shiftKey && e.code === 'KeyH' },
        { id: 'flow', match: e => (e.metaKey || e.ctrlKey) && e.key === 'Enter' },
      ];

      window.addEventListener('keydown', evt => {
        if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === 'k') {
          evt.preventDefault();
          if (!evt.repeat) palette.toggle(); // a held ⌘K would flicker it
          return;
        }
        if (evt.target instanceof Element && evt.target.closest(TEXT_ENTRY)) {
          return; // typing, not a shortcut
        }
        if ((evt.metaKey || evt.ctrlKey) && evt.shiftKey && evt.code === 'KeyB') {
          evt.preventDefault();
          newBranch();
          return;
        }
        for (const binding of arrangeBindings) {
          if (binding.match(evt)) {
            // Absent when the selection is too small for the command; that is
            // a no-op, not an error.
            const command = paletteCommands().find(c => c.id === binding.id);
            if (command !== undefined) {
              evt.preventDefault();
              void command.run();
            }
            return;
          }
        }
      });

      document.getElementById('tb-more')?.addEventListener('click', () => palette.open());

      /* ---- library popover (L, ⇧L) ---- */

      /** ⇧L, #tb-library and ⌘K: save the selected nodes, their chart rows and
       *  the edges between them under a name. The payload is checked here
       *  and again when it is inserted; the server checks name and size. */
      const addSelectionToLibrary = (): void => {
        const sel = selectedNodes();
        if (sel.length === 0) {
          showError('Select the nodes to save, then add them to the library.');
          return;
        }
        const refusal = saveRefusal(sel, id => conn.db.visibleChart.nodeId.find(id) ?? undefined);
        if (refusal !== null) {
          showError(refusal);
          return;
        }
        const name = prompt('Save to library as:', sel[0].label);
        if (name === null) {
          return;
        }
        const payload = JSON.stringify(
          buildLibraryPayload(sel, getEdges(), id => conn.db.visibleChart.nodeId.find(id) ?? undefined, id => ops.edgeWeight(id), id => icons.get(id))
        );
        const check = parseLibraryPayload(payload);
        if (!check.ok) {
          showError(check.error);
          return;
        }
        void conn.reducers.saveLibraryItem({ name, payload })
          .then(() => showNotice(`Saved "${name.trim()}" to your library`))
          .catch(report);
      };
      const library = new LibraryPopover(document.getElementById('library-popover') as HTMLElement, {
        anchor: document.getElementById('tool-library') as HTMLElement,
        dropTarget: svg,
        onPick: pick => editor.armTemplate(pick),
        onDrop: (pick, clientX, clientY) => {
          const w = viewport.screenToWorld(clientX, clientY);
          editor.placeTemplateAt(pick, w.x, w.y);
        },
        onRename: item => {
          const name = prompt('Rename library item:', item.name);
          if (name === null || name === item.name) {
            return;
          }
          void conn.reducers.renameLibraryItem({ id: item.id, name }).catch(report);
        },
        onDelete: item => {
          if (!confirm(`Delete "${item.name}" from your library?`)) {
            return;
          }
          void conn.reducers.deleteLibraryItem({ id: item.id }).catch(report);
        },
      });
      document.getElementById('tb-library')?.addEventListener('click', () => addSelectionToLibrary());
      // my_library is primary-keyed: a rename arrives as an update.
      const syncLibrary = () => library.setItems([...conn.db.myLibrary.iter()]);
      conn.db.myLibrary.onInsert(syncLibrary);
      conn.db.myLibrary.onUpdate(syncLibrary);
      conn.db.myLibrary.onDelete(syncLibrary);
      syncLibrary();

      setupHeaderActions(exportSettled, () => {
        if (boardsHref) location.assign(boardsHref);
        else showError('Open the dashboard to import another repository ref.');
      });
      const paintShare = setupShare({
        base: location.origin + location.pathname,
        db: config.db,
        home: config.defaultDb,
        setLink: (mode, token) => conn.reducers.setLinkShare({ boardId, mode, token }),
        stopLink: () => conn.reducers.stopLinkShare({ boardId }),
        setIncludes: (threats, code) => conn.reducers.setLinkShareIncludes({ boardId, threats, code }),
      });
      const linkIncludes = () => {
        const row = conn.db.myLinkIncludes.boardId.find(boardId);
        return { threats: row?.threats ?? false, code: row?.code ?? false };
      };
      // Who may share, and what the link carries: one rule for the Share popover and the exposure chip.
      const shareState = (): ShareState | null => {
        const row = myRow();
        return canManage() && row && !factual()
          ? { mode: row.linkMode as ShareState['mode'], token: row.linkToken, ...linkIncludes(), counts: { threats: threats.open + threats.contained, code: liveRefCount } }
          : null;
      };
      const syncShare = () => paintShare(shareState());
      syncShare();
      const paintEmbed = setupChartEmbed({
        base: location.href, db: config.db, home: config.defaultDb,
        enable: (nodeId, token) => conn.reducers.enableChartEmbed({ nodeId, token }),
        disable: nodeId => conn.reducers.disableChartEmbed({ nodeId }),
        enableBoard: (boardId, token, threats, comparisonBoardId) => conn.reducers.enableBoardEmbed({ boardId, token, threats, comparisonBoardId }),
        disableBoard: boardId => conn.reducers.disableBoardEmbed({ boardId }),
      });
      syncEmbed = () => {
        const nodes = selectedNodes();
        const node = nodes.length === 1 && editor.selectedEdges.size === 0 && nodes[0].kind === 'chart' ? nodes[0] : undefined;
        const link = node && [...conn.db.myChartEmbeds.iter()].find(row => row.nodeId === node.id);
        const boardLink = [...conn.db.myBoardEmbeds.iter()].find(row => row.boardId === boardId);
        const version = conn.db.visibleArchitectureVersion.boardId.find(boardId);
        const previous = version ? comparisonBoard(version, conn.db.visibleArchitectureVersion.iter()) : null;
        paintEmbed(node && myRow()?.access === 'owner' ? { nodeId: node.id, title: node.label, token: link?.token ?? '' } : null,
          myRow()?.access === 'owner' ? { boardId, title: conn.db.visibleBoard.id.find(boardId)?.name ?? 'Board',
            token: boardLink?.token ?? '', threats: boardLink?.threats ?? false, comparisonBoardId: boardLink?.comparisonBoardId ?? 0n,
            previousBoardId: previous ?? 0n } : null);
      };
      syncEmbed();
      conn.db.myChartEmbeds.onInsert(syncEmbed);
      conn.db.myChartEmbeds.onDelete(syncEmbed);
      conn.db.myChartEmbeds.onUpdate(syncEmbed);
      conn.db.myBoardEmbeds.onInsert(syncEmbed);
      conn.db.myBoardEmbeds.onDelete(syncEmbed);
      conn.db.myBoardEmbeds.onUpdate(syncEmbed);
      document.getElementById('act-rescan')?.setAttribute('title', 'Import another ref from the dashboard');
      document.getElementById('empty-import')?.addEventListener('click', () => {
        if (boardsHref) location.assign(boardsHref);
        else showError('Open the dashboard to import a public GitHub repository.');
      });

      const presenceLayer = () => svg.querySelector('#presence') as SVGGElement | null;
      const paintPresence = () => {
        const layer = presenceLayer();
        if (layer) {
          renderPresence(layer, {
            nodes: getNodes(),
            cursors: [...conn.db.visibleCursor.iter()],
            selections: [...conn.db.visibleSelection.iter()],
            participants: [...conn.db.visibleParticipant.iter()],
            myIdentityHex: identityHex,
            boardId,
            scale: viewport.scale,
          });
        }
      };

      // Cursor writes: at most 20/s, dropped (not queued) while one is in flight.
      const sendCursor = rateLimited(50);
      let pointer: { x: number; y: number } | null = null; // last world position, written back after D6
      const publishCursor = (p: { x: number; y: number }) =>
        sendCursor(() =>
          conn.reducers.updateCursor({ boardId, x: p.x, y: p.y }).catch(err => {
            showError((err as Error).message);
          })
        );
      svg.addEventListener('pointermove', evt => {
        const w = viewport.screenToWorld(evt.clientX, evt.clientY);
        pointer = w;
        publishCursor(w);
      });

      const sendSelection = latestWins(100);
      const publishSelection = () =>
        sendSelection(() =>
          conn.reducers
            .setSelection({ boardId, nodeIds: [...editor.selection] })
            .catch(err => showError((err as Error).message))
        );
      // D6: the module deletes this identity's cursor and selection on every
      // disconnect, including another tab or the dashboard closing and each
      // dashboard HTTP call as the same account (/api/activity, every 30 s).
      // Write them back, or this tab drops off everyone's participant list.
      conn.db.visibleCursor.onDelete((_ctx, row) => {
        if (ownPresenceLost(row, identityHex, pointer !== null)) {
          publishCursor(pointer!);
        }
      });
      conn.db.visibleSelection.onDelete((_ctx, row) => {
        if (ownPresenceLost(row, identityHex, editor.selection.size > 0)) {
          publishSelection();
        }
      });

      // The board switchBoard is opening; its rows arrive before it draws.
      let switchTo: bigint | undefined;
      // The diff's base board can arrive after the board opened: the architecture rows load on their own.
      const syncOpenBoards = () => {
        if (switchTo === undefined && boardsShown(boardId).join() !== opened) void openShown(boardId);
      };
      // Red crayon history, unread badge and agent banner (spec 2026-10-19 D5, D6).
      const paintReview = (() => {
        const paint = setupReview({
          readOnly: publicExample,
          markRead: () => conn.reducers.markRepliesRead({ boardId }),
          agentName: hex => [...conn.db.visibleParticipant.iter()].find(p => p.kind === 'agent' && p.identity.toHexString() === hex)?.displayName ?? 'an agent',
          exists: id => getAllNodes().some(n => n.id === id),
          // The threat card's row light: a CSS class rerender reapplies.
          hoverNode: id => { threatHover = id; lightThreatRow(); },
          panTo: id => editor.selectNodes([id]), // selecting reveals it (revealSelection)
        });
        return () => paint({
          marks: [...conn.db.visibleMark.iter()].filter(m => m.boardId === boardId),
          lastReadAt: [...conn.db.visibleMarkRead.iter()].find(r => r.boardId === boardId)?.lastReadAt.microsSinceUnixEpoch ?? 0n,
          waiters: [...conn.db.visibleMarkWaiter.iter()]
            .filter(w => w.boardId === boardId)
            .map(w => ({ owner: w.owner, lastWaitAt: w.lastWaitAt.microsSinceUnixEpoch })),
          now: BigInt(Date.now()) * 1000n,
        });
      })();
      const onTableChange = () => {
        const current = conn.db.visibleBoard.id.find(boardId);
        if (!current) {
          paintShare(null);
          syncRenamable();
          showBoardUnavailable(boardsHref, newBoardHref(), linkGone());
          return;
        }
        board = current;
        syncOpenBoards();
        if (getVersion() && diffBoard !== boardId) {
          showDiff = getVersion()?.assertionMode === 'intent';
          diffBoard = boardId;
        }
        svg.dataset.assertionMode = getVersion()?.assertionMode ?? '';
        title.textContent = `${getVersion()?.assertionMode === 'intent' ? 'Branch · ' : ''}${board.name}${publicExample() ? ' · view only' : ''}`;
        syncSignInLabel();
        syncAccessLine();
        syncRenamable();
        rebuildComparison();
        rebuildRefs();
        rebuildChangeNotes();
        rebuildThreats();
        rebuildCharts();
        rebuildEdgeWeights();
        rebuildIcons();
        rebuildIncident();
        rebuildRoute();
        syncCodeOverlay();
        editor.pruneSelection();
        syncThreatCard();
        trackMoves();
        syncShare(); // after the refs and threats rebuild: the popover shows their counts
        renderCounts();
        renderSession();
        paintReview(); // a node removed under a row stops its pan
        rerender();
      };
      let refreshPending = false;
      const scheduleTableChange = () => {
        if (refreshPending) return;
        refreshPending = true;
        requestAnimationFrame(() => { refreshPending = false; onTableChange(); });
      };
      for (const table of [
        conn.db.visibleBoard,
        conn.db.myBoards,
        ...(conn.db.myBoardPermissions ? [conn.db.myBoardPermissions] : []),
        conn.db.myLinkIncludes,
        conn.db.visibleNode,
        conn.db.visibleEdge,
        conn.db.visibleEdgeWeight,
        conn.db.visibleHideSet,
        conn.db.visibleHideSetMember,
        conn.db.visibleCodeRef,
        conn.db.visibleSession,
        conn.db.visibleSessionRemote,
        conn.db.visibleSessionRoute,
        conn.db.visibleRouteEvent,
        conn.db.visibleArchitectureVersion,
        conn.db.visibleArchitectureHistory,
        conn.db.visibleChart,
        conn.db.visibleNodeIcon,
        conn.db.visibleChangeNote,
        conn.db.visibleThreat,
        conn.db.visibleChartAnchor,
        conn.db.visibleBoardWindow,
        conn.db.visibleBoardLifetime,
        conn.db.visibleIncident,
      ]) {
        table.onInsert(scheduleTableChange);
        table.onUpdate(scheduleTableChange);
        table.onDelete(scheduleTableChange);
      }
      // Marks touch nothing the board draws: repaint only the review chrome.
      for (const table of [conn.db.visibleMark, conn.db.visibleMarkWaiter, conn.db.visibleMarkRead]) {
        table.onInsert(paintReview);
        table.onUpdate(paintReview);
        table.onDelete(paintReview);
      }
      const rerenderParticipants = () => {
        const now = Date.now();
        // Online rows present on this board (G47): durable rows with
        // connections === 0 are offline; an identity whose cursor and
        // selection are on another board is elsewhere.
        const participants = participantsOnBoard({
          participants: [...conn.db.visibleParticipant.iter()],
          cursors: conn.db.visibleCursor.iter(),
          selections: conn.db.visibleSelection.iter(),
          myIdentityHex: identityHex,
          boardId,
          now,
        });
        renderParticipantChips(participants, now);
        renderPresencePop(
          participants,
          [...conn.db.visibleSelection.iter()],
          new Map(getAllNodes().map(n => [n.id, n])),
          now
        );
        agentHere = participants.find(p => p.kind === 'agent')?.displayName;
        syncEmpty();
        paintReview(); // agent names in the banner and rows
      };
      conn.db.visibleParticipant.onInsert(rerenderParticipants);
      conn.db.visibleParticipant.onUpdate(rerenderParticipants);
      conn.db.visibleParticipant.onDelete(rerenderParticipants);
      for (const table of [conn.db.visibleCursor, conn.db.visibleSelection]) {
        table.onInsert(paintPresence);
        table.onUpdate(paintPresence);
        table.onDelete(paintPresence);
      }
      conn.db.visibleSelection.onInsert(rerenderParticipants);
      conn.db.visibleSelection.onUpdate(rerenderParticipants);
      conn.db.visibleSelection.onDelete(rerenderParticipants);
      // Cursors move 20 times a second: only arriving, leaving or changing
      // board can change who is here.
      conn.db.visibleCursor.onInsert(rerenderParticipants);
      conn.db.visibleCursor.onDelete(rerenderParticipants);
      conn.db.visibleCursor.onUpdate((_ctx, old, row) => {
        if (old.boardId !== row.boardId) {
          rerenderParticipants();
        }
      });
      // agent focus line in the rail follows the agent's selection row
      for (const table of [conn.db.visibleSelection, conn.db.visibleParticipant]) {
        table.onInsert(renderSession);
        table.onUpdate(renderSession);
        table.onDelete(renderSession);
      }
      conn.db.visibleParticipant.onInsert(paintPresence);
      conn.db.visibleParticipant.onUpdate(paintPresence);
      conn.db.visibleParticipant.onDelete(paintPresence);
      // A trace that just arrived plays for everyone watching; an older one waits for Replay.
      const onTrace = (row: { boardId: bigint; playedAt: { microsSinceUnixEpoch: bigint } }) => {
        if (row.boardId !== boardId) return;
        renderSession();
        if (Date.now() - Number(row.playedAt.microsSinceUnixEpoch / 1000n) < 30_000) replayTrace();
      };
      conn.db.visibleTracePlayback.onInsert((_ctx, row) => onTrace(row));
      conn.db.visibleTracePlayback.onUpdate((_ctx, _old, row) => onTrace(row));

      window.addEventListener('resize', rerender);
      window.addEventListener('redcrayon:theme', rerender);
      window.addEventListener('redcrayon:fonts', rerender);

      const switchBoard = (id: bigint) => {
        if (id === (switchTo ?? boardId)) return;
        const next = conn.db.visibleBoard.id.find(id);
        if (!next) { showError('This snapshot is not available.'); return; }
        switchTo = id;
        // Open first: the old board stays on screen until the new board's rows are here.
        void openShown(id).then(ok => {
          if (switchTo !== id) return;
          switchTo = undefined;
          if (!ok) showError('We could not open this board. Please try again.');
          else if (id !== boardId) showBoard(id, next);
        });
      };
      const showBoard = (id: bigint, next: typeof board) => {
        board = next;
        stopLive();
        palette.close();
        library.close();
        boardId = id;
        activeBoardId = id;
        ops = new Ops(conn, identityHex, new History());
        editor.switchBoard(id, ops);
        crayonUi.crayon.clear(); // drafts belong to the board they were drawn on
        resetChartDraft();
        pointer = null;
        revealedSets.clear();
        staleCursor = 0;
        lastSeen.clear();
        lastDragged.clear();
        overlayPref = readOverlayPref(board.name);
        showDiff = getVersion()?.assertionMode === 'intent';
        showBoardLink(board);
        title.textContent = `${getVersion()?.assertionMode === 'intent' ? 'Branch · ' : ''}${board.name}`;
        enter = false;
        onTableChange();
        enter = true;
        publishSelection();
        rerenderParticipants();
      };
      const architecture = mountArchitectureRail(railEl, {
        switchBoard,
        toggleDiff: on => { showDiff = on; rerender(); },
        applyView: () => { void conn.reducers.propagateArchitectureCuration({ boardId }).catch(report); },
        sourceKey: () => {
          const node = selectedNodes()[0];
          if (!node) return;
          const sourceKey = prompt('Source key used by a future import (for example js:src/service.ts or go:example.com/repo/pkg):', node.sourceKey);
          if (sourceKey === null) return;
          void conn.reducers.setArchitectureNodeKey({ nodeId: node.id, sourceKey }).catch(report);
        },
      });

      /* ---- branches: the header chip, its tree, the dialogs and the palette ---- */
      const boardNames = () => new Map([...conn.db.visibleBoard.iter()].map(b => [b.id, b.name]));
      const versionsNow = () => [...conn.db.visibleArchitectureVersion.iter()];
      const baseIsFact = () => {
        const v = getVersion();
        return Boolean(v && v.assertionMode === 'intent' && conn.db.visibleArchitectureVersion.boardId.find(v.baseBoardId)?.assertionMode === 'fact');
      };
      const canBranch = () => role() !== 'viewer' && getVersion()?.assertionMode !== 'intent';
      const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
      const newBranch = () => {
        if (!canBranch()) { showError(getVersion()?.assertionMode === 'intent' ? 'Branch the board itself, not a branch.' : 'Only an owner or editor can branch this board.'); return; }
        openBranchCreate({
          baseName: board.name,
          counts: `${plural(getAllNodes().length, 'node')} · ${plural(getAllEdges().length, 'edge')}`,
          suggested: `${board.name}-branch`,
          create: name => new Promise<void>((resolve, reject) => {
            const requestKey = crypto.randomUUID();
            const onInsert = (_ctx: unknown, row: { boardId: bigint; requestKey: string }) => {
              if (row.requestKey !== requestKey) return;
              cleanup(); resolve(); switchBoard(row.boardId);
            };
            const cleanup = () => { clearTimeout(timeout); conn.db.visibleArchitectureVersion.removeOnInsert(onInsert); };
            const timeout = setTimeout(() => { cleanup(); reject(new Error('The branch has not arrived. Open it from the dashboard.')); }, 15000);
            conn.db.visibleArchitectureVersion.onInsert(onInsert);
            conn.reducers.createArchitectureProposal({ baseBoardId: boardId, name, requestKey }).catch(err => { cleanup(); reject(err); });
          }),
        });
      };
      /** The review dialog's change list, from the same diff the canvas paints. */
      const changeRows = (): ChangeRow[] => {
        if (!comparison) return [];
        const version = getVersion();
        const baseId = version ? comparisonBoard(version, versionsNow()) : null;
        const baseNodes = new Map([...conn.db.visibleNode.iter()].filter(n => n.boardId === baseId).map(n => [n.id, n]));
        const current = new Map(getAllNodes().map(n => [n.id, n]));
        const nodeAt = (id: bigint) => (id < 0n ? baseNodes.get(-id) : current.get(id));
        const keyMeta = (key: string) => (/^(node|proposal|legacy):/.test(key) ? '' : key);
        const sign = (status: string) => (status === 'added' ? '+' : status === 'removed' ? '−' : '~') as ChangeRow['sign'];
        const rows: ChangeRow[] = [];
        for (const [id, status] of comparison.nodeDiff) {
          const n = status === 'removed' ? comparison.removedNodes.find(r => r.id === id) : current.get(id);
          if (n) rows.push({ sign: sign(status), title: n.label, detail: n.kind, meta: keyMeta(n.sourceKey) });
        }
        for (const [id, status] of comparison.edgeDiff) {
          const e = status === 'removed' ? comparison.removedEdges.find(r => r.id === id) : getAllEdges().find(r => r.id === id);
          if (!e) continue;
          rows.push({ sign: sign(status), title: `${nodeAt(e.fromNode)?.label ?? '?'} → ${nodeAt(e.toNode)?.label ?? '?'}`, detail: e.label, meta: e.evidence });
        }
        return rows;
      };
      const runBranchAction = async (action: BranchAction): Promise<void> => {
        if (action === 'submit') await conn.reducers.submitArchitectureProposal({ boardId });
        else if (action === 'merge') await conn.reducers.mergeArchitectureProposal({ boardId });
        else if (action === 'reconcile') {
          const version = getVersion();
          const latest = version ? reconciliationSnapshot(version, versionsNow(), conn.db.visibleArchitectureHistory.iter()) : undefined;
          if (!latest || latest.boardId === version?.baseBoardId) throw new Error('Import a new ref before checking this branch.');
          await conn.reducers.reconcileArchitectureProposal({ boardId, snapshotBoardId: latest.boardId });
        } else await conn.reducers.reviewArchitectureProposal({ boardId, decision: action });
      };
      const openReview = (id: bigint) => {
        if (id !== boardId) { switchBoard(id); return; }
        const version = getVersion();
        if (!version || version.assertionMode !== 'intent') return;
        openBranchReview({
          name: board.name,
          baseName: boardNames().get(version.baseBoardId) ?? 'board',
          status: version.status as BranchStatus,
          baseIsFact: baseIsFact(),
          changes: changeRows(),
          actions: branchActions(version, role(), baseIsFact()),
          run: runBranchAction,
        });
      };
      const branchPopover = mountBranchPopover(
        document.getElementById('branch-chip') as HTMLButtonElement,
        document.getElementById('branch-pop') as HTMLElement,
        { newBranch, switchBoard, openReview }
      );
      const branchCommands = (): Command[] => {
        const version = getVersion();
        const commands: Command[] = [];
        if (canBranch()) commands.push({ id: 'branch-new', group: 'Branch', title: 'New branch', hint: 'a copy to edit and submit for review', keys: '\u2318\u21e7B', run: newBranch });
        for (const row of branchTree(boardId, versionsNow(), boardNames(), () => undefined)) {
          if (row.current) continue;
          commands.push({ id: `branch-switch:${row.boardId}`, group: 'Branch', title: `Switch to ${row.name}`, hint: row.base ? 'base' : row.status ? statusWord(row.status) : '', run: () => switchBoard(row.boardId) });
        }
        for (const action of branchActions(version, role(), baseIsFact())) commands.push({ id: `branch-${action}`, group: 'Branch', title: ACTION_LABELS[action], run: () => openReview(boardId) });
        if (version) commands.push({ id: 'branch-diff', group: 'Branch', title: 'Show changes', checked: showDiff, run: () => { showDiff = !showDiff; rerender(); } });
        return commands;
      };
      function updateArchitecture() {
        const d = comparison?.diff;
        const changedCount = comparison ? [...comparison.nodeDiff.values(), ...comparison.edgeDiff.values()].filter(s => s === 'changed').length : 0;
        const changes = d ? `Nodes +${d.addedNodes.length} −${d.removedNodes.length} · edges +${d.addedEdges.length} −${d.removedEdges.length} · ${changedCount} changed` : 'First snapshot';
        const version = getVersion();
        architecture.update(version, versionsNow(), boardNames(), changes, showDiff,
          editor.selection.size === 1 ? selectedNodes()[0]?.sourceKey : undefined);
        const delta = (id: bigint) => (id === boardId && d ? { addedNodes: d.addedNodes.length, removedNodes: d.removedNodes.length, addedEdges: d.addedEdges.length, removedEdges: d.removedEdges.length } : undefined);
        branchPopover.update(branchTree(boardId, versionsNow(), boardNames(), delta), chipText(version, board.name), canBranch());
      }
      window.addEventListener('popstate', () => {
        // Same-document navigation to another share link skips boot, which opens it.
        if (opensNewShareLink(location.hash, shareToken)) {
          intentionalDisconnect = true;
          currentConn?.disconnect();
          location.reload();
          return;
        }
        const target = selectBoard(conn.db.visibleBoard.iter(), location.search, location.hash, conn.db.myBoards.iter());
        if (typeof target !== 'string') switchBoard(target.id);
      });

      syncOpenBoards();
      rebuildComparison();
      svg.dataset.assertionMode = getVersion()?.assertionMode ?? '';
      title.textContent = `${getVersion()?.assertionMode === 'intent' ? 'Branch · ' : ''}${board.name}${publicExample() ? ' · view only' : ''}`;
      syncRenamable();
      rebuildRefs();
      rebuildChangeNotes();
      rebuildThreats();
      rebuildCharts();
      rebuildEdgeWeights();
      rebuildIcons();
      rebuildIncident();
      rebuildRoute();
      syncCodeOverlay();
      syncShare(); // after the refs and threats rebuild, as in onTableChange
      renderCounts();
      renderSession();
      // Frame the board in the canvas the rail and dock leave free (G6), once
      // the session block has given the rail its real size.
      editor.fitView();
      trackMoves();
      rerender();
      enter = true;
      rerenderParticipants();
      requestAnimationFrame(finishBoardLoading);
      // "checkpoint N · 4 min ago" keeps ticking without a table change.
      // So do D17's presence thresholds: hosted agents dim, then leave.
      window.setInterval(() => {
        renderSession();
        rerenderParticipants();
        paintPresence();
        connectDialog.refresh();
        paintReview(); // waiters go quiet and answered banners expire without a row change
      }, 30_000);
    },
    boardFailed
  );
}

function waitForGuestBoard(conn: DbConnection): Promise<bigint> {
  const existing = [...conn.db.myGuestBoard.iter()][0];
  if (existing) return Promise.resolve(existing.boardId);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      conn.db.myGuestBoard.removeOnInsert(check);
    };
    const check = () => {
      const row = [...conn.db.myGuestBoard.iter()][0];
      if (row) { cleanup(); resolve(row.boardId); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Your board has not arrived. Please reload.')); }, 10_000);
    conn.db.myGuestBoard.onInsert(check);
    check();
  });
}

// Surface unhandled reducer rejections rather than losing them.
window.addEventListener('unhandledrejection', evt => {
  showError(String(evt.reason?.message ?? evt.reason));
  evt.preventDefault();
});
