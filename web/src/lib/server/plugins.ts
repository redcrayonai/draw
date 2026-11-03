// The plugins this dashboard offers (PLUGINS.md). The deployment-wide switch is the operator's
// configuration: a plugin is available only when its settings are complete. Each workspace
// then turns an available plugin on or off (set_workspace_plugin; module/src/plugins.ts has the ids).
import { versionsConfigured } from './versions';

export const PLUGINS = [
  { id: 'versions', name: 'Versions', description: 'Save versions of a board. Restore any one as a new private board; the original stays as it is.', configured: versionsConfigured },
] as const;

export const available = (id: string) => PLUGINS.some((p) => p.id === id && p.configured());
