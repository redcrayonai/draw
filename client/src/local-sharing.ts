import type { LocalBoard } from '../../shared/local';
import { localCopy } from '../../shared/local-copy';

export function mountLocalSharing(current: () => LocalBoard | undefined, call: <T>(input: unknown) => Promise<T>, say: (message: string) => void) {
  function dashboardOrigin(value: string) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
      if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return url.origin;
    } catch { /* An incomplete address stays in the dialog. */ }
  }
  let dashboard: string | undefined;
  const address = document.getElementById('sharing-dashboard') as HTMLInputElement;
  const destination = document.getElementById('sharing-destination')!;
  const configuredDashboard = dashboardOrigin(import.meta.env.VITE_DASHBOARD_URL ?? '');
  if (configuredDashboard) address.placeholder = configuredDashboard;
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const account = button('account-local'), share = button('share-local');
  const dialog = document.getElementById('local-sharing') as HTMLDialogElement;
  const skip = document.getElementById('skip-sharing') as HTMLInputElement;
  const copy = document.getElementById('shared-copy') as HTMLAnchorElement;
  let skipIntro = false, sharing = false, connected = false;
  let popup: Window | null = null;
  let snapshot: Promise<ReturnType<typeof localCopy>> | undefined, slug = '', name = '';
  let requestKey = '';
  function sync() {
    account.hidden = false;
    const href = current()?.sharedCopy;
    copy.hidden = !href;
    if (href) copy.href = href;
    share.hidden = !current();
  }
  function launch() {
    const board = current();
    if (sharing && !board) return;
    let target = dashboard;
    if (!address.hidden) {
      const origin = dashboardOrigin(address.value.trim());
      if (!origin) {
        const message = /\/mcp\/?$/i.test(address.value.trim())
          ? 'That’s the agent’s MCP endpoint. Enter your Draw dashboard address here.'
          : 'Enter the full address of your Draw dashboard.';
        address.setCustomValidity(message + ' Example: ' + address.placeholder);
        address.reportValidity();
        return;
      }
      target = origin;
    }
    if (!target) return;
    const url = new URL('/local-board', target);
    url.hash = new URLSearchParams({ origin: location.origin, action: sharing ? 'share' : 'account' }).toString();
    const next = window.open(url.href, '_blank');
    if (!next) { say('Allow Draw to open the sign-in tab, then try again.'); return; }
    popup?.close();
    popup = next;
    dashboard = target;
    requestKey = crypto.randomUUID();
    snapshot = undefined;
    name = sharing ? board!.name : '';
    slug = sharing ? board!.slug : '';
    dialog.close();
  }
  function start(forShare: boolean) {
    if (popup && !popup.closed && slug === (forShare ? current()?.slug : '')) {
      popup.focus();
      return;
    }
    sharing = forShare;
    if (dashboard && (skipIntro || connected)) launch();
    else {
      document.getElementById('sharing-intro')!.hidden = skipIntro;
      skip.parentElement!.hidden = skipIntro;
      document.getElementById('sharing-title')!.textContent = skipIntro ? 'Choose your Draw dashboard' : sharing ? 'Share a copy with a teammate?' : 'Bring a teammate into the conversation';
      button('connect-local').textContent = skipIntro ? 'Continue to sign in' : 'Sign in or create an account';
      dialog.showModal();
      if (!address.hidden) address.focus();
    }
  }
  address.oninput = () => address.setCustomValidity('');
  account.onclick = () => start(false);
  share.onclick = () => start(true);
  button('connect-local').onclick = launch;
  button('stay-offline').onclick = () => dialog.close();
  skip.onchange = () => {
    const checked = skip.checked;
    skip.disabled = true;
    void call({ action: 'set_sharing_preference', skip: checked }).then(() => { skipIntro = checked; }, () => {
      skip.checked = skipIntro; say('Could not save your reminder preference.');
    }).finally(() => { skip.disabled = false; });
  };
  window.addEventListener('message', event => {
    if (!popup || !dashboard || event.source !== popup || event.origin !== dashboard) return;
    if (event.data?.type === 'draw.account') {
      connected = true;
      account.textContent = 'Account';
      popup.postMessage({type: 'draw.ready', name}, dashboard);
    }
    if (event.data?.type === 'draw.copy' && slug) {
      const target = popup, origin = dashboard;
      snapshot ??= call<LocalBoard>({ action: 'read_board', board: slug }).then(localCopy);
      void snapshot.then(copy => {
        if (popup === target) target.postMessage({ type: 'draw.snapshot', snapshot: copy, requestKey }, origin);
      }, () => {
        if (popup === target) { snapshot = undefined; say('Could not read the local board. Try sharing again.'); }
      });
    }
    if (event.data?.type === 'draw.shared' && snapshot && typeof event.data.href === 'string') {
      let url: URL;
      try { url = new URL(event.data.href); } catch { return; }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return;
      snapshot = undefined;
      popup = null;
      void call({ action: 'remember_shared_copy', board: slug, href: url.href }).then(
        () => say('Shared copy created. This board stays on your device.'),
        () => say('Copy created. Save its link from the workspace tab.'),
      );
    }
  });
  let preference: Promise<void> | undefined;
  return () => {
    preference ??= call<{ skip: boolean; instance: string }>({ action: 'sharing_preference' }).then(result => {
      const instance = new URL(location.href).searchParams.get('instance') ?? result.instance;
      dashboard = instance ? undefined : configuredDashboard;
      destination.textContent = dashboard ? 'You’ll sign in at ' + new URL(dashboard).host : 'Where do you sign in to Draw?';
      address.hidden = !!dashboard;
      skipIntro = skip.checked = result.skip;
      sync();
    }).catch(() => { preference = undefined; });
    if (!account.hidden) sync();
  };
}
