// ponytail: rough estimate — count * 4/3 for code, ~4 for prose. Add tiktoken when accuracy matters.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
