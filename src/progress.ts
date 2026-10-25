/** Bounded textual execution details for MCP observers. Redact before truncating. */
export function executionDetails(
  value: unknown,
  redact: (value: unknown) => string,
  limit = 16000,
) {
  const serialized = JSON.stringify(value, (key, entry) => {
    if (
      /authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret/i.test(
        key,
      )
    )
      return '[REDACTED]';
    if (
      entry &&
      typeof entry === 'object' &&
      ['image', 'audio', 'blob'].includes(entry.type)
    )
      return { type: entry.type, omitted: 'binary content' };
    return entry;
  });
  const text = redact(serialized ?? 'null');
  return text.length > limit
    ? { details: text.slice(0, limit), truncated: true }
    : { details: JSON.parse(text) as unknown, truncated: false };
}
