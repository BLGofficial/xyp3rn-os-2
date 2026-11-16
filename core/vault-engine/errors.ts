export const VAULT_ERROR_CODES = [
  'PATH_TRAVERSAL',
  'SYMLINK_ESCAPE',
  'DISALLOWED_DIRECTORY',
  'DISALLOWED_EXTENSION',
  'ABSOLUTE_PATH_FORBIDDEN',
  'CANONICAL_WRITE_FORBIDDEN',
  'UNAUTHORIZED_ACTOR',
  'SELF_APPROVAL_FORBIDDEN',
  'CHECKSUM_MISMATCH',
  'SILENT_OVERWRITE_FORBIDDEN',
  'EXTERNAL_OBSIDIAN_EDIT',
  'LOCK_BUSY',
  'INVALID_YAML',
  'INVALID_SCHEMA',
  'INVALID_METADATA',
  'INVALID_ARCHIVE_OR_SUPERSESSION',
  'MISSING_ENTITY_ID',
  'ENTITY_ID_MUTATION_FORBIDDEN',
  'BROKEN_REFERENCE',
  'MISSING_PROVENANCE',
  'INSUFFICIENT_EVIDENCE',
  'SECRET_DETECTED',
  'NOTE_NOT_FOUND',
  'REVISION_NOT_FOUND',
  'APPROVAL_NOT_FOUND',
] as const;

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export class VaultEngineError extends Error {
  readonly code: VaultErrorCode;
  readonly vaultPath: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: VaultErrorCode,
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(message);
    this.name = 'VaultEngineError';
    this.code = code;
    this.vaultPath = options?.vaultPath;
    this.details = options?.details;
  }
}

export class VaultPathSecurityError extends VaultEngineError {
  constructor(
    code:
      | 'PATH_TRAVERSAL'
      | 'SYMLINK_ESCAPE'
      | 'DISALLOWED_DIRECTORY'
      | 'DISALLOWED_EXTENSION'
      | 'ABSOLUTE_PATH_FORBIDDEN',
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(code, message, options);
    this.name = 'VaultPathSecurityError';
  }
}

export class VaultPermissionError extends VaultEngineError {
  constructor(
    code: 'CANONICAL_WRITE_FORBIDDEN' | 'UNAUTHORIZED_ACTOR' | 'SELF_APPROVAL_FORBIDDEN',
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(code, message, options);
    this.name = 'VaultPermissionError';
  }
}

export class VaultConflictError extends VaultEngineError {
  constructor(
    code: 'CHECKSUM_MISMATCH' | 'SILENT_OVERWRITE_FORBIDDEN' | 'EXTERNAL_OBSIDIAN_EDIT' | 'LOCK_BUSY',
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(code, message, options);
    this.name = 'VaultConflictError';
  }
}

export class VaultValidationError extends VaultEngineError {
  constructor(
    code:
      | 'INVALID_YAML'
      | 'INVALID_SCHEMA'
      | 'INVALID_METADATA'
      | 'INVALID_ARCHIVE_OR_SUPERSESSION'
      | 'MISSING_ENTITY_ID'
      | 'ENTITY_ID_MUTATION_FORBIDDEN'
      | 'BROKEN_REFERENCE'
      | 'MISSING_PROVENANCE'
      | 'INSUFFICIENT_EVIDENCE'
      | 'SECRET_DETECTED',
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(code, message, options);
    this.name = 'VaultValidationError';
  }
}

export class VaultNotFoundError extends VaultEngineError {
  constructor(
    code: 'NOTE_NOT_FOUND' | 'REVISION_NOT_FOUND' | 'APPROVAL_NOT_FOUND',
    message: string,
    options?: {
      readonly vaultPath?: string | undefined;
      readonly details?: Record<string, unknown> | undefined;
    },
  ) {
    super(code, message, options);
    this.name = 'VaultNotFoundError';
  }
}
