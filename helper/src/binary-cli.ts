import { runUpdate } from './update';
import { runNativeInstall, runNativePermissions } from './native-install';

declare const __DRAW_VERSION__: string;
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') console.log(`draw ${__DRAW_VERSION__} (Bun ${process.versions.bun})`);
else if (args[0] === '--executable-path') console.log(process.execPath);
else if (args[0] === '--help' || args[0] === '-h') console.log(
  'Draw — architecture boards for your coding agent\n\n' +
  '  draw [--repo path] [--port number] [--no-open]   Open a local board\n' +
  '  draw local --background [--repo path]          Start a persistent local server\n' +
  '  draw install <codex|claude-code|pi> [--url <https://...>] [--permissions-defaults]\n' +
  '  draw permissions codex [--permissions-defaults]\n' +
  '  draw update [--check] [--channel stable|preview] [--installer npm|bun]\n' +
  '  draw login [--url <MCP endpoint>]               Connect your hosted Draw account\n' +
  '  draw mcp                                        Local and hosted MCP router\n' +
  '  draw local-mcp --per-repo                       Local MCP bridge\n' +
  '  draw capture | chat | tap | marks | doctor      Hosted helper commands\n' +
  '  draw live --board slug --map mapping.json       Local piped activity\n\n' +
  'One Draw integration: new boards are local; request hosted explicitly or use a hosted link.\n' +
  'Codex --permissions-defaults: Allow boards/chat; Deny source reads/uploads.\n' +
  'Hosted source uploads set to Ask require browser approval before reading files.\n' +
  'Set DRAW_NO_UPDATE_CHECK=1 to disable automatic update checks.'
);
else if (['mcp', 'login', 'hosted-transport'].includes(args[0])) {
  try {
    const { runRouter, login, loginUrl, routerUrl } = await import('./mcp-router');
    if (args[0] === 'login') await login(loginUrl(args.slice(1)));
    else if (args[0] === 'mcp') await runRouter(routerUrl());
    else {
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      process.umask(0o077);
      process.env.MCP_REMOTE_CONFIG_DIR = join(homedir(), '.redcrayon', 'oauth');
      process.argv.splice(2, args.length, routerUrl(args[1]), '--transport', 'http-only', '--protocol', 'auto', '--auth-timeout', '150',
        '--static-oauth-client-metadata', JSON.stringify({ client_name: 'Draw', scope: 'board:read board:write' }));
      // @ts-expect-error The bundled CLI has a script-only declaration and starts on import.
      await import('mcp-remote/dist/proxy.js');
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Draw connection failed.'); process.exitCode = 1; }
}
else if (args[0] === 'install') {
  try { process.exitCode = await runNativeInstall(args.slice(1), __DRAW_VERSION__); }
  catch (error) { console.error(error instanceof Error ? error.message : 'UNAVAILABLE: install failed'); process.exitCode = 1; }
}
else if (args[0] === 'permissions') {
  try { process.exitCode = await runNativePermissions(args.slice(1)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'UNAVAILABLE: permission configuration failed'); process.exitCode = 1; }
}
else if (args[0] === 'update') process.exitCode = await runUpdate(args.slice(1), __DRAW_VERSION__);
else {
  if (!args.length || args[0].startsWith('--')) {
    process.argv.splice(2, process.argv.length - 2, 'local', ...(args.includes('--no-open') ? [] : ['--open']), ...args.filter(arg => arg !== '--no-open'));
  }
  // The source distribution retains its Node-compatible bundle and require shim.
  // @ts-ignore The distribution is generated before compiling this entry point.
  await import('../dist/redcrayon.mjs');
}
