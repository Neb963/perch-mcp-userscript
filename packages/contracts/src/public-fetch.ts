import { ToolError } from './errors.js';

/** Validate a public retrieval URL without resolving or contacting the destination. */
export function parsePublicFetchDestination(raw: string, approvedHosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError('INVALID_INPUT', 'Fetch requires an absolute HTTPS URL.');
  }
  const host = url.hostname.toLowerCase();
  const publicHostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || url.hash || host.endsWith('.') || host.length > 253 || !publicHostname) {
    throw new ToolError('PATH_DENIED',
      'Fetch permits approved public HTTPS hostnames only; credentials, IP literals, fragments and alternate ports are denied.');
  }
  if (approvedHosts && !approvedHosts.includes(host)) {
    throw new ToolError('SCOPE_DENIED', 'This exact public hostname has not been approved by the Operator.');
  }
  return url;
}
