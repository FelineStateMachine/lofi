export interface SecretValue {
  name: string;
  value: string;
}

export interface SecretLeak {
  name: string;
  path: string;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  outer:
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

export function findSecretLeaks(
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  secrets: readonly SecretValue[],
): SecretLeak[] {
  const encoder = new TextEncoder();
  return files.flatMap(({ path, content }) =>
    secrets
      .filter(({ value }) => contains(content, encoder.encode(value)))
      .map(({ name }) => ({ name, path }))
  );
}
