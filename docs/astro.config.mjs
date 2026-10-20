// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'draw',
			logo: { src: './src/assets/logo.svg' },
			customCss: ['./src/styles/theme.css'],
			// Prompts are long single lines; wrap instead of scrolling.
			expressiveCode: { defaultProps: { wrap: true } },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/redcrayonai/draw' }],
			sidebar: [
				{ label: 'Start', items: [{ label: 'Overview', link: '/' }, { label: 'Connect your agent', slug: 'connect' }] },
				{ label: 'Use cases', items: [{ autogenerate: { directory: 'use-cases' } }] },
				{ label: 'Capabilities', items: [{ autogenerate: { directory: 'capabilities' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
				{ label: 'Self-host', items: [{ autogenerate: { directory: 'self-host' } }] },
			],
		}),
	],
});
