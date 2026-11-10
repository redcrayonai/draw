/**
 * The canvas's extension seam. A build points VITE_CANVAS_EXTRA (a path from
 * client/, or absolute) at a module whose default export is a CanvasExtra;
 * vite.config.ts aliases it as `$extra`. Unset, the build gets this empty
 * one. Like `$auth`, it lets a private build add to the canvas without the
 * core importing it.
 *
 * Keep the surface small and every member optional: a module built against an
 * older core keeps working when a field is added.
 */
export interface CanvasExtra {
  /** Called once per page, when the first board is drawn, in the frame that first paints it. */
  boardReady?(ctx: BoardReady): void;
}

export interface BoardReady {
  /** The page was opened without a board or share link (#b=, #s=, ?board=, ?boardId=), as it was before boot
   *  rewrote the URL. Also true for ?new=1, the "start a new board" link, signed in or not. */
  bareVisit: boolean;
  /** Opens the Connect guide, even to a signed-out viewer. Undefined when this build has no agent server. */
  openConnectGuide?: () => void;
}

const none: CanvasExtra = {};
export default none;
