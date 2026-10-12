/**
 * The firmware module 07 writes: the latest release of the TMsense repository
 * on GitHub, and nothing else.
 *
 * There is no file picker here on purpose. A board flashed from this page runs
 * something the repository published, built by its CI from a commit on main,
 * and the page can say which. The edge fetches the release from GitHub and
 * checks it (a browser cannot fetch a GitHub release across origins); this
 * reads it from the edge and checks it again before a byte goes near a board:
 * each file against the SHA-256 in the release's manifest, and the three
 * together as a flash plan.
 */
import { planFlash, type FlashPlan } from '../../../../src/shared/flasher/images.js';
import type { PublishedRelease, ReleaseFile, ReleaseFileName } from '../../../../src/shared/flasher/release.js';
import { permissionChanged } from '../../entities/admin-session/index.tsx';

export interface ReleaseBuild {
  plan: FlashPlan;
  release: PublishedRelease;
}

const hexOf = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function ask(path: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try { response = await fetch(`/api/flash/firmware${path}`, { signal }); } catch { throw new Error('could not reach the console'); }
  permissionChanged(response.status);
  if (response.status === 401) throw new Error('your console session ended; sign in again');
  return response;
}

async function fileOf(release: PublishedRelease, file: ReleaseFile, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await ask(`/${encodeURIComponent(release.tag)}/${file.name}`, signal);
  // The release moved on between the two requests, or a proxy answered instead.
  if (!response.ok || !response.headers.get('content-type')?.includes('application/octet-stream')) throw new Error(`the console did not hand over ${file.name}; check again`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== file.size || hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== file.sha256) {
    throw new Error(`${file.name} arrived damaged: it does not match the release's SHA-256`);
  }
  return new Uint8Array(bytes);
}

/** The release on offer, downloaded and checked. Throws a sentence a person can act on. */
export async function loadRelease(signal?: AbortSignal): Promise<ReleaseBuild> {
  const response = await ask('', signal);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`the console answered HTTP ${response.status} without a firmware release`);
  const answer = await response.json() as PublishedRelease & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `the console answered HTTP ${response.status}`);
  const part = async (name: ReleaseFileName): Promise<Uint8Array> => {
    const file = answer.files.find((entry) => entry.name === name);
    if (!file) throw new Error(`the release has no ${name}`);
    return fileOf(answer, file, signal);
  };
  const plan = planFlash({ bootloader: await part('bootloader.bin'), partitions: await part('partitions.bin'), application: await part('firmware.bin') });
  if (plan.version !== answer.version) throw new Error(`the release says ${answer.version} but its firmware reports ${plan.version}`);
  return { plan, release: answer };
}

export const releasePage = (release: PublishedRelease): string => `https://github.com/${release.repository}/releases/tag/${encodeURIComponent(release.tag)}`;
