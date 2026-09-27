import { CLI_VERSION, noticeUpdate, updateAdvice } from './version.js';
type ApiFailure = {
  code?: string;
  message?: string;
  details?: unknown;
  hint?: string;
  requestId?: string;
};

const retryHint = (method: string) =>
  method === 'GET'
    ? 'This read is safe to retry.'
    : 'The server may have committed this write. Inspect the target record before retrying.';

/** Credentials for one request.
 *
 * `token` is sent as a bearer token whatever its kind: a human session token today, an
 * agent credential once those exist. The CLI deliberately does not parse it -- deciding
 * what a token is belongs to the server, and a client that inspects tokens grows opinions
 * about them.
 *
 * `organization` is only needed by a human session. An agent credential is bound to one
 * organization at issue time, so the server reads it from the credential and the header is
 * redundant; sending it anyway is harmless and keeps one code path. */
export type Credentials = { token?: string | undefined; organization?: string | undefined };

export async function request(
  baseUrl: string,
  path: string,
  method = 'GET',
  body?: unknown,
  credentials: Credentials = {},
): Promise<unknown> {
  const origin = baseUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        // Which client this is, so the server can say when a newer one exists.
        'X-Fieldwork-Client': `fieldwork-cli/${CLI_VERSION}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}),
        ...(credentials.organization
          ? { 'X-Fieldwork-Organization': credentials.organization }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    // Named, because the server is resolved from a flag, two environment variables, a
    // workspace file or a default, and "could not reach the server" leaves the reader to
    // guess which of those was in force. The origin carries no credential: tokens travel
    // in a header.
    throw Object.assign(
      new Error(
        timedOut
          ? `Request to ${origin} timed out after 15 seconds`
          : `Could not reach the server at ${origin}`,
      ),
      {
        code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        hint: retryHint(method),
        cause: error,
      },
    );
  }
  const update = updateAdvice(response.headers);
  if (update && response.ok) noticeUpdate(origin, update);
  if (response.status === 204) return { deleted: true };
  let data: ApiFailure;
  try {
    data = (await response.json()) as ApiFailure;
  } catch (error) {
    throw Object.assign(
      new Error(`Server returned an invalid response (HTTP ${response.status})`),
      {
        code: 'INVALID_RESPONSE',
        status: response.status,
        hint: retryHint(method),
        cause: error,
      },
    );
  }
  if (!response.ok)
    throw Object.assign(new Error(data.message ?? `HTTP ${response.status}`), {
      code: data.code ?? 'HTTP_ERROR',
      status: response.status,
      ...(response.status === 401 || response.status === 403
        ? {
            hint:
              response.status === 401
                ? 'Supply a credential with --token, FIELDWORK_TOKEN, or workspace configuration. Retrying without one will not succeed.'
                : 'This credential is valid but not permitted here. Check the selected organization with --org or FIELDWORK_ORGANIZATION, and that its access has not been revoked.',
          }
        : {}),
      // A refusal that says what to do instead -- a limit, say -- carries its own hint. An
      // outdated client comes first when the server says this one is too old: the failure
      // may well be the version, and retrying will not change that. Not for a credential
      // refusal, which is about the credential whatever the version.
      ...(update?.required && response.status !== 401 && response.status !== 403
        ? { hint: update.hint }
        : data.hint
          ? { hint: data.hint }
          : {}),
      ...(update ? { update } : {}),
      ...(data.details ? { details: data.details } : {}),
      ...(data.requestId ? { requestId: data.requestId } : {}),
    });
  return data;
}

/** Every page of a paged collection.
 *
 * The CLI filters, groups and formats over whole collections -- `--where`, superseded and
 * abandoned exclusions, field selection -- so a page of them would apply each filter to a
 * page and call it the answer. Walking is the honest reading of the same request; when a
 * campaign is large enough for that to hurt, the filters belong in the query.
 */
export async function requestAll<T>(
  baseUrl: string,
  path: string,
  credentials: Credentials = {},
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const page = (await request(
      baseUrl,
      cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path,
      'GET',
      undefined,
      credentials,
    )) as { items?: T[]; nextCursor?: string | null };
    // A collection that is not paged answers with an array, and is its own only page.
    if (Array.isArray(page)) return page as T[];
    all.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return all;
}
