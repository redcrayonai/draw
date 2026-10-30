import { expect, it } from 'vitest';
import { boardHref } from './board-link';
import { DEFAULT_DB } from './db-target';

const slug = 'c4bb879c7355360696d9';

it('links a board by its slug, naming only a database other than the default', () => {
  expect(boardHref({ app: 'https://draw.example.com', slug, db: DEFAULT_DB })).toBe(`https://draw.example.com/#b=${slug}`);
  expect(boardHref({ app: 'https://draw.example.com/', slug, db: 'rc-dev' })).toBe(`https://draw.example.com/?db=rc-dev#b=${slug}`);
  // a deployment's own database stays out of its links, whatever its name
  expect(boardHref({ app: 'https://staging.draw.example.com', slug, db: 'redcrayon-staging', home: 'redcrayon-staging' })).toBe(`https://staging.draw.example.com/#b=${slug}`);
  expect(boardHref({ app: 'https://draw.example.com', slug, db: 'redcrayon', home: 'redcrayon' })).toBe(`https://draw.example.com/#b=${slug}`);
  // a page URL as the app: its path, query and fragment never carry over
  expect(boardHref({ app: 'http://localhost:5173/?boardId=9&new=1#b=old', slug, db: 'preview' })).toBe(`http://localhost:5173/?db=preview#b=${slug}`);
});

it('refuses a board without a slug instead of falling back to its id', () => {
  expect(() => boardHref({ app: 'https://draw.example.com', slug: '', db: DEFAULT_DB })).toThrow(/backfill_board_slugs/);
});
