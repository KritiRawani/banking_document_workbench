export class UploadError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
  }
}
