import { ConfigurationError, RunningDataSyncError } from '../foundation/errors.js'

/**
 * Error thrown when an SVG poster cannot be rendered (e.g. empty tracks or invalid layout).
 */
export class PosterError extends RunningDataSyncError {}

/**
 * Error thrown when user-supplied poster parameters (e.g. poster type or year range) are invalid.
 */
export class ParameterError extends ConfigurationError {}
