import { beforeAll, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

vi.mock('./board-loading', () => ({ initBoardLoading: vi.fn() }));
vi.mock('./main', () => ({}));

beforeAll(async () => {
  document.body.innerHTML = html;
  await import('./start');
});

it.each([
  ['bug_report.yml', 'behavior'],
  ['feature_request.yml', 'problem'],
])('maps the canvas fields into %s', async (template, field) => {
  const form = document.querySelector<HTMLFormElement>('#issue-dialog form')!;
  form.querySelector('textarea')!.value = 'A & B?';
  form.querySelector<HTMLSelectElement>('[name="template"]')!.value = template;
  form.querySelector<HTMLSelectElement>('[name="component"]')!.value = 'MCP';
  expect(form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(true);
  expect(form.action).toBe('https://github.com/redcrayonai/draw/issues/new');
  const { template: filename, ...fields } = Object.fromEntries(new FormData(form));
  expect(filename).toBe(template);
  expect(fields).toEqual({ component: 'MCP', [field]: 'A & B?' });

  const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('node:fs');
  const yaml = readFileSync(`../.github/ISSUE_TEMPLATE/${filename}`, 'utf8');
  const ids = Array.from(yaml.matchAll(/^    id: ([\w-]+)$/gm), match => match[1]);
  expect(ids).toEqual(expect.arrayContaining(Object.keys(fields)));
});

it.each(['   ', '🐛'.repeat(400)])('retains invalid input and allows a corrected report', value => {
  const form = document.querySelector<HTMLFormElement>('#issue-dialog form')!;
  const message = form.querySelector('textarea')!;
  message.value = value;
  expect(form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(false);
  expect(message.validity.customError).toBe(true);
  expect(message.value).toBe(value);
  message.value = 'A shorter summary';
  message.dispatchEvent(new Event('input'));
  expect(message.validity.valid).toBe(true);
  expect(form.dispatchEvent(new Event('submit', { cancelable: true }))).toBe(true);
});
