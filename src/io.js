import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

let modules;

/** NodeIO that can read Draco/meshopt/WebP/AVIF inputs and write Draco output. */
export async function createIO() {
  modules ??= Promise.all([
    draco3d.createDecoderModule(),
    draco3d.createEncoderModule(),
    MeshoptDecoder.ready,
    MeshoptEncoder.ready,
  ]);
  const [dracoDecoder, dracoEncoder] = await modules;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': dracoDecoder,
    'draco3d.encoder': dracoEncoder,
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}
