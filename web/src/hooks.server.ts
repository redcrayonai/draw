import type { HandleServerError } from '@sveltejs/kit';
import { log } from '$lib/server/log';

// An uncaught throw (a webhook's reducer call, say) as one structured line instead of the default object dump.
export const handleError: HandleServerError = ({ error, event, status }) => {
  if (status >= 500) log('error', 'http.unhandled_error', { route: event.route.id, status }, error);
};
