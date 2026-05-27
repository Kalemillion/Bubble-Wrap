from pathlib import Path
import itertools
import msgpack
import zstandard as zstd

raw = Path('Msg_EUfr.product.sarc').read_bytes()
dict_bytes = Path('scripts/zstd_dict.bin').read_bytes()
out = zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(dict_bytes)).decompress(raw)
print('zstd_len', len(out))
print('zstd_head', out[:32].hex())
print('zstd_sarc', out.find(b'SARC'))
print('zstd_yaz0', out.find(b'Yaz0'))

unpacker = msgpack.Unpacker(raw=False)
unpacker.feed(out)
items = list(itertools.islice(unpacker, 24))
for idx, item in enumerate(items):
    print(idx, type(item).__name__, repr(item)[:200])
