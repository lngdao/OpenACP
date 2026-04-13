/**
 * Client compatibility requirements.
 *
 * The server declares the minimum and recommended versions of the OpenACP App
 * (desktop client) that are compatible with this server release. The values are
 * returned in the public health endpoint so the App can enforce version checks
 * on connect — similar to Docker's API version negotiation and Kubernetes'
 * version skew policy.
 *
 * - `minVersion`         — Hard block. The App MUST be at least this version to
 *                          use the server. Bump this when you ship a breaking API
 *                          change (removed endpoint, changed response shape, etc.).
 *
 * - `recommendedVersion` — Soft warning. The App SHOULD be at least this version
 *                          for the best experience. Bump this when you ship an
 *                          important new feature that the App needs to surface.
 *
 * Both follow the project's date-based version format: YYYY.MDD.N
 */

export interface ClientCompatibility {
  /** Minimum App version required (hard block below this). */
  minVersion: string
  /** Recommended App version (soft warning below this). */
  recommendedVersion: string
}

/**
 * Current client compatibility requirements for this server version.
 *
 * Update these values when shipping changes that affect the App:
 * - Breaking API changes → bump `minVersion`
 * - New features the App should adopt → bump `recommendedVersion`
 */
export const CLIENT_COMPATIBILITY: ClientCompatibility = {
  minVersion: '0.0.0',
  recommendedVersion: '0.0.0',
}
