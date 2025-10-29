const sample = '{"ops":[{"op":"replace"}]}"}]}';
function extractOpsObject(raw) {
  if (!raw) return null;
  const txt = String(raw);
  const start = txt.indexOf('{"ops"');
  if (start === -1) return null;
  let inString = false;
  let escaping = false;
  let depth = 0;
  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const segment = txt.slice(start, i + 1);
        const sanitized = segment.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
        try {
          return JSON.parse(sanitized);
        } catch (e) {
          console.error('parse fail', e);
          return null;
        }
      } else if (depth < 0) {
        break;
      }
    }
  }
  return null;
}
console.log(extractOpsObject(sample));
