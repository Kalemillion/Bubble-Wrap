let init;
let instance;
let heap;
const IMPORT_OBJECT = {
	env: {
		emscripten_notify_memory_growth: _ => {
			heap = new Uint8Array(instance.exports.memory.buffer);
		}
	}
};
/**
 * ZSTD (Zstandard) decoder.
 */
class ZSTDDecoder
{
	init() {
		if (init) return init;
		if (typeof fetch !== 'undefined') {

		 // Web.
			init =
fetch(`data:application/wasm;base64,${wasm}`).then(response => response.arrayBuffer()).then(arrayBuffer =>
WebAssembly.instantiate(arrayBuffer, IMPORT_OBJECT)).then(this._init);
		} else {
			// Node.js.

 init = WebAssembly.instantiate(Buffer.from(wasm, 'base64'),
IMPORT_OBJECT).then(this._init);
		}
		return init;
	}
	_init(result) {
		instance = result.instance;
		IMPORT_OBJECT.env.emscripten_notify_memory_growth(0); // initialize heap.
	}
	decode(array, uncompressedSize = 0) {
		if (!instance) throw new Error('ZSTDDecoder: Await .init() before decoding.');
		// Write compressed data into WASM memory.
		const compressedSize = array.byteLength;
		const compressedPtr = instance.exports.malloc(compressedSize);
		heap.set(array, compressedPtr);
		// Decompress into WASM memory.
		uncompressedSize = uncompressedSize || Number(instance.exports.ZSTD_findDecompressedSize(compressedPtr, compressedSize));
		const uncompressedPtr = instance.exports.malloc(uncompressedSize);
		const actualSize = instance.exports.ZSTD_decompress(uncompressedPtr, uncompressedSize, compressedPtr, compressedSize);
		// Read decompressed data and free WASM memory.
		const dec = heap.slice(uncompressedPtr, uncompressedPtr + actualSize);
		instance.exports.free(compressedPtr);
		instance.exports.free(uncompressedPtr);
		return dec;
	}
}
/**
 * BSD License
 *
 * For Zstandard software
 *
 * Copyright (c) 2016-present, Yann Collet, Facebook, Inc. All rights reserved.
 */
// wasm:begin
const wasm =
'AGFzbQEAAAABoAEUYAF/AGADf39/AGACf38AYAF/AX9gBX9/f39/AX9A39/fwF/YAR/f39/AX9gAn9/AX9gAAF/YAd/f39/f39/AX9gB39/f39/f38AYAR/f39/AX5gAn9/AX5Bn9/f39/fwBgDn9/f39/f39/f39/f39/AX9gCH9/f39/f39/AX9gCX9/f39/f39/fwF/YAN+f38BfmA'
// wasm:end

export { ZSTDDecoder };
//# sourceMappingURL=zstddec.modern.js.map
