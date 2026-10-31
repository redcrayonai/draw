import { initBoardLoading, failBoardLoading } from './board-loading';

// Paint loading feedback before downloading the editor and restoring auth.
initBoardLoading();
void import('./main').catch(error => {
  console.error('Board startup failed:', error);
  failBoardLoading();
});
