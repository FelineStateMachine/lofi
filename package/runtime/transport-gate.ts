/**
 * Package-owned transport gate.
 *
 * One shared flag records that the development inspector paused the cloud
 * transport. It lives outside both the inspector probe and the lifecycle
 * module so foreground recovery can honor the pause without a circular
 * import: the probe writes it, recovery reads it.
 *
 * @module
 */

let pausedByInspector = false;

/** Records whether the inspector has paused the cloud transport. */
export function setTransportPausedByInspector(paused: boolean): void {
  pausedByInspector = paused;
}

/** True while the inspector holds the cloud transport paused. */
export function isTransportPausedByInspector(): boolean {
  return pausedByInspector;
}
