from pathlib import Path
from io import BytesIO
import zstandard as zstd
import cbor2

raw = Path('Msg_EUfr.product.sarc').read_bytes()
dict_bytes = Path('scripts/zstd_dict.bin').read_bytes()
out = zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(dict_bytes)).decompress(raw)
print('len', len(out))
print('head', out[:32].hex())
print('SARC', out.find(b'SARC'))
print('Yaz0', out.find(b'Yaz0'))

stream = cbor2.CBORDecoder(BytesIO(out))
for index in range(8):
    try:
        value = stream.decode()
    except Exception as exc:
        print('ERR', type(exc).__name__, str(exc))
        break
    print(index, type(value).__name__, repr(value)[:300])
