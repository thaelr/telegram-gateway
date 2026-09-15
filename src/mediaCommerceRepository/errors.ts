export class MediaRepositoryContractError extends Error {
  readonly code = "media_repository_contract_violation";

  constructor(readonly operation: string) {
    super(`${operation} returned no result row`);
    this.name = "MediaRepositoryContractError";
  }
}
