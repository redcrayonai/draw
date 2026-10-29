// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightDocSearch from '@astrojs/starlight-docsearch';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), 'PUBLIC_ALGOLIA_');
const docSearch = {
	appId: env.PUBLIC_ALGOLIA_APP_ID,
	apiKey: env.PUBLIC_ALGOLIA_SEARCH_API_KEY,
	indexName: env.PUBLIC_ALGOLIA_INDEX_NAME,
};
const hasSearchSettings = Object.values(docSearch).some(Boolean);
if (hasSearchSettings && !Object.values(docSearch).every(Boolean)) {
	throw new Error('Set all three PUBLIC_ALGOLIA_ settings: APP_ID, SEARCH_API_KEY, and INDEX_NAME. See docs/.env.example.');
}

export default defineConfig({
	server: { allowedHosts: ['.trycloudflare.com'] },
	integrations: [
		starlight({
			title: 'draw',
			plugins: hasSearchSettings ? [starlightDocSearch(docSearch)] : [],
			logo: { src: './src/assets/logo.svg' },
			customCss: ['./src/styles/theme.css'],
			// Prompts are long single lines; wrap instead of scrolling.
			expressiveCode: { defaultProps: { wrap: true } },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/redcrayonai/draw' }],
			sidebar: [
				{ label: 'Start', items: [{ label: 'Overview', link: '/' }, { label: 'Connect your agent', slug: 'connect' }, { label: 'Find and manage your boards', slug: 'dashboard' }, { label: 'Your data and code consent', slug: 'data-and-consent' }] },
				{ label: 'Use cases', items: [{ autogenerate: { directory: 'use-cases' } }] },
				{ label: 'Capabilities', items: [{ autogenerate: { directory: 'capabilities' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
				{ label: 'Self-host', items: [{ autogenerate: { directory: 'self-host' } }] },
			],
		}),
	],
});
