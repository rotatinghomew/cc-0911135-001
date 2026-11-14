export class HarvestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HarvestError';
    this.code = options.code || 'harvestError';
    this.window = options.window ?? null;
    this.retryable = options.retryable ?? false;
    if (options.cause) this.cause = options.cause;
  }
}

export class TokenExpiredError extends HarvestError {
  constructor(window, message = '翻页令牌已失效，需要重开当前窗口') {
    super(message, { code: 'tokenExpired', window, retryable: true });
    this.name = 'TokenExpiredError';
  }
}

export class SourceConflictError extends HarvestError {
  constructor(window, conflicts) {
    super('同一天出现内容冲突的版本，停止提交该窗口', { code: 'conflict', window });
    this.name = 'SourceConflictError';
    this.conflicts = conflicts;
  }
}

export class WindowIncompleteError extends HarvestError {
  constructor(window) {
    super('窗口尚未完整接收，不能成为进度', { code: 'incompleteWindow', window });
    this.name = 'WindowIncompleteError';
  }
}

export class InvalidWindowError extends HarvestError {
  constructor(message, window = null) {
    super(message, { code: 'invalidWindow', window });
    this.name = 'InvalidWindowError';
  }
}

export class LedgerMismatchError extends HarvestError {
  constructor(message) {
    super(message, { code: 'ledgerMismatch' });
    this.name = 'LedgerMismatchError';
  }
}
