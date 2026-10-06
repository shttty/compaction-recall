export function codePointLength(text: string): number {
  let length = 0;
  for (const _point of text) length++;
  return length;
}

export function codePointSlice(text: string, offset: number, limit: number): string {
  if (limit <= 0) return "";
  let start = 0;
  let end = 0;
  let index = 0;
  for (const point of text) {
    if (index === offset) start = end;
    end += point.length;
    index++;
    if (index === offset + limit) break;
  }
  if (offset >= index) start = end;
  return text.slice(start, end);
}
