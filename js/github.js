// Optional: commit calendar.ics and venues.json back into this site's repo with
// the GitHub contents API, so every device (and a Google Calendar subscription)
// sees the latest calendar.

// On https://owner.github.io/repo/ the repo can be inferred from the URL.
export function repoFromLocation(loc = globalThis.location) {
  const host = loc?.hostname || '';
  if (!host.endsWith('.github.io')) return {};
  const owner = host.slice(0, -'.github.io'.length);
  const first = (loc.pathname || '/').split('/').filter(Boolean)[0];
  return { ghOwner: owner, ghRepo: first && !first.includes('.') ? first : host };
}

export const pagesUrl = ({ ghOwner, ghRepo }, path = '') =>
  ghRepo.toLowerCase() === `${ghOwner}.github.io`.toLowerCase()
    ? `https://${ghOwner}.github.io/${path}`
    : `https://${ghOwner}.github.io/${ghRepo}/${path}`;

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function putFile({ ghOwner, ghRepo, ghBranch }, token, path, content, message) {
  const api = `https://api.github.com/repos/${encodeURIComponent(ghOwner)}/${encodeURIComponent(ghRepo)}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const branch = ghBranch || 'main';

  let sha;
  const cur = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers, cache: 'no-store' });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error(`${path}: GitHub said ${cur.status} ${await cur.text()}`);

  const res = await fetch(api, {
    method: 'PUT', headers,
    body: JSON.stringify({ message, content: toBase64(content), branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`${path}: GitHub said ${res.status} ${detail.message || ''}`.trim());
  }
}

export async function publishFiles(settings, token, files, message) {
  if (!settings.ghOwner || !settings.ghRepo || !token) throw new Error('Fill in the GitHub owner, repo and token in Settings first.');
  for (const [path, content] of Object.entries(files)) await putFile(settings, token, path, content, message);
}
