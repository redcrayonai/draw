import { describe, it, expect } from 'vitest';
import { loadHighlighter } from './highlighter-loader';
import { shikiTheme } from './shiki-themes';

describe('snippet grammar tokenization', () => {
  it.each([
    ['python', 'def greet(name: str):\n    return "Hello " + name'],
    ['rust', 'fn main() { let value: i32 = 42; }'],
    ['c', 'int main(void) { return 42; }'],
    ['cpp', 'template<typename T> T twice(T value) { return value + value; }'],
    ['java', 'public class Main { public static int value() { return 42; } }'],
    ['csharp', 'public class Program { public static string Name => "hello"; }'],
    ['sql', "SELECT name FROM users WHERE id = 42; -- lookup"],
  ])('highlights %s with the real JavaScript regex engine', async (lang, code) => {
    const hl = await loadHighlighter(lang);
    for (const theme of ['light', 'dark'] as const) {
      const { tokens } = hl.codeToTokens(code, { lang, theme: shikiTheme(theme) });
      expect(tokens.map(line => line.map(token => token.content).join('')).join('\n')).toBe(code);
      expect(new Set(tokens.flat().map(token => token.color)).size).toBeGreaterThan(1);
    }
  });
});
