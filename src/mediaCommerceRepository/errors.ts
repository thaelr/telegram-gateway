export class MediaRepositoryContractError extends Error {
  readonly code = "media_repository_contract_violation";
  readonly field: string | null;
  readonly reason: string | null;

  constructor(
    readonly operation: string,
    details: { field?: string | null; reason?: string | null } = {},
  ) {
    const field = details.field ?? null;
    const reason = details.reason ?? null;
    super(
      field || reason
        ? `${operation} contract violation${field ? ` for ${field}` : ""}${reason ? `: ${reason}` : ""}`
        : `${operation} returned no result row`,
    );
    this.name = "MediaRepositoryContractError";
    this.field = field;
    this.reason = reason;
  }
}
