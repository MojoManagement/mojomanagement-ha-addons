/** A Cast receiver as announced on the network via mDNS. */
export interface CastDevice {
  /** Stable Cast device id (survives IP changes and renames). */
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  /** Raw Cast capability bitfield (`ca` TXT record), or null when not announced. */
  capabilities: number | null;
  isGroup: boolean;
}

const CAP_VIDEO_OUT = 1;
const CAP_AUDIO_OUT = 4;
const CAP_MULTIZONE_GROUP = 32;

const AUDIO_NAME_HINT = /(speaker|soundbar|audio|mini|jbl|sonos|marshall|bose|harman|denon|yamaha|heos|home)/i;
const VIDEO_NAME_HINT = /(tv|display|monitor|shield|roku|fire tv|google tv|chromecast(?! audio)|hub|bravia)/i;

export function isGroupDevice(model: string, capabilities: number | null): boolean {
  return model === 'Google Cast Group' || (capabilities !== null && (capabilities & CAP_MULTIZONE_GROUP) !== 0);
}

/**
 * True for devices that play audio but have no screen. Uses the capability
 * bits the device announces; falls back to name hints for devices that omit them.
 */
export function isAudioOnly(device: Pick<CastDevice, 'name' | 'model' | 'capabilities' | 'isGroup'>): boolean {
  if (device.isGroup) return true;
  if (device.capabilities !== null) {
    return (device.capabilities & CAP_AUDIO_OUT) !== 0 && (device.capabilities & CAP_VIDEO_OUT) === 0;
  }
  const text = `${device.name} ${device.model}`;
  return AUDIO_NAME_HINT.test(text) && !VIDEO_NAME_HINT.test(text);
}
