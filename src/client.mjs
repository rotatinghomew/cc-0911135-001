import { assertDate } from '../lib/calendar.mjs';

export class SourceError extends Error {
  constructor(message, { code = 'sourceError', status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function endpoint(base) {
  return String(base).replace(/\/+$/, '') + '/oai';
}

function tokenCode(value) {
  const text = String(value);
  if (/bad.*token|token.*(bad|invalid|expired)|resumption/i.test(text)) return 'badResumptionToken';
  return 'sourceError';
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function requestJson(url, { timeout = 15_000, retries = 2, retryDelay = 100 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json' }
      });
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SourceError('源端返回的不是 JSON', { code: 'protocolError', status: response.status, cause: error });
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        const retryable = response.status >= 500;
        throw new SourceError(message, {
          code: response.status >= 500 ? 'serverError' : tokenCode(message),
          status: response.status,
          retryable
        });
      }
      if (payload && typeof payload.error === 'string') {
        throw new SourceError(payload.error, { code: tokenCode(payload.error), status: response.status });
      }
      return payload;
    } catch (error) {
      const sourceError = error instanceof SourceError
        ? error
        : new SourceError(error.message || '无法连接源端', { code: 'networkError', retryable: true, cause: error });
      lastError = sourceError;
      if (!sourceError.retryable || attempt === retries) throw sourceError;
      await sleep(retryDelay * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function identify(base, options = {}) {
  const payload = await requestJson(endpoint(base) + '?verb=Identify', options);
  const earliest = payload && payload.earliest;
  const today = payload && payload.today;
  try {
    assertDate(earliest, '源端最早日期');
    assertDate(today, '源端截止日期');
  } catch (error) {
    throw new SourceError(error.message, { code: 'protocolError', cause: error });
  }
  if (earliest > today) throw new SourceError('源端日期范围无效', { code: 'protocolError' });
  return {
    earliest,
    today,
    granularity: typeof payload.granularity === 'string' ? payload.granularity : 'day',
    pageSize: Number.isInteger(payload.pageSize) ? payload.pageSize : null
  };
}

export async function listPage(base, { from, until, resumptionToken } = {}, options = {}) {
  const url = new URL(endpoint(base));
  url.searchParams.set('verb', 'ListRecords');
  if (resumptionToken) {
    url.searchParams.set('resumptionToken', resumptionToken);
  } else {
    assertDate(from, '窗口开始日期');
    assertDate(until, '窗口截止日期');
    url.searchParams.set('from', from);
    url.searchParams.set('until', until);
  }
  return requestJson(url, options);
}

export async function inspect(base) {
  const identity = await identify(base);
  const page = await listPage(base, { from: identity.earliest, until: identity.today });
  return { identity, firstPage: page };
}
