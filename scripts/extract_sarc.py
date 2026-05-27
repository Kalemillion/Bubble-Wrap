#!/usr/bin/env python3
import argparse
import json
import struct
import sys
import os
from io import BytesIO
from pathlib import Path

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
YAZ0_MAGIC = (b"Yaz0", b"YAZ0")


def find_magic(buf, magic):
    return buf.find(magic)


def read_u16(buf, off, endian):
    return struct.unpack(endian + "H", buf[off : off + 2])[0]


def read_u32(buf, off, endian):
    return struct.unpack(endian + "I", buf[off : off + 4])[0]


def safe_join(root, relative_path):
    target = (root / relative_path).resolve()
    root = root.resolve()
    if root not in target.parents and target != root:
        raise ValueError(f"Chemin invalide: {relative_path}")
    return target


def maybe_decompress_zstd(buf):
    if not buf.startswith(ZSTD_MAGIC):
        return buf
    try:
        import zstandard as zstd
    except ImportError as exc:
        raise RuntimeError(
            "Le fichier commence par une couche Zstd, mais le module Python 'zstandard' "
            "n'est pas installé. Installe-le avec: python -m pip install zstandard"
        ) from exc

    # No dictionary support by default here; callers may pass a dict via
    # `maybe_decompress_zstd_with_dict` below.
    return zstd.ZstdDecompressor().decompress(buf)


def maybe_decompress_zstd_with_dict(buf, dict_path=None):
    if not buf.startswith(ZSTD_MAGIC):
        return buf
    try:
        import zstandard as zstd
    except ImportError as exc:
        raise RuntimeError(
            "Le fichier commence par une couche Zstd, mais le module Python 'zstandard' "
            "n'est pas installé. Installe-le avec: python -m pip install zstandard"
        ) from exc

    dict_bytes = None
    if dict_path:
        dict_bytes = Path(dict_path).read_bytes()

    try:
        if dict_bytes:
            cd = zstd.ZstdCompressionDict(dict_bytes)
            dec = zstd.ZstdDecompressor(dict_data=cd)
        else:
            dec = zstd.ZstdDecompressor()
        return dec.decompress(buf)
    except Exception as exc:
        raise RuntimeError("Échec de la décompression Zstd: dictionnaire manquant ou incompatibilité.") from exc


def decompress_yaz0(buf):
    if len(buf) < 16 or buf[:4] not in YAZ0_MAGIC:
        return buf

    dst_size = struct.unpack(">I", buf[4:8])[0]
    src = 16
    dst = bytearray()
    valid_bit_count = 0
    curr_code = 0

    while len(dst) < dst_size:
        if valid_bit_count == 0:
            if src >= len(buf):
                raise ValueError("Flux Yaz0 tronqué")
            curr_code = buf[src]
            src += 1
            valid_bit_count = 8

        if curr_code & 0x80:
            if src >= len(buf):
                raise ValueError("Flux Yaz0 tronqué")
            dst.append(buf[src])
            src += 1
        else:
            if src + 1 >= len(buf):
                raise ValueError("Flux Yaz0 tronqué")
            byte1 = buf[src]
            byte2 = buf[src + 1]
            src += 2

            length = byte1 >> 4
            distance = ((byte1 & 0x0F) << 8) | byte2

            if length == 0:
                if src >= len(buf):
                    raise ValueError("Flux Yaz0 tronqué")
                length = buf[src] + 0x12
                src += 1
            else:
                length += 2

            copy_src = len(dst) - (distance + 1)
            if copy_src < 0:
                raise ValueError("Référence Yaz0 invalide")

            for i in range(length):
                dst.append(dst[copy_src + i])

        curr_code = (curr_code << 1) & 0xFF
        valid_bit_count -= 1

    return bytes(dst)


def decode_blob(buf):
    current = maybe_decompress_zstd(buf)
    while len(current) >= 4 and current[:4] in YAZ0_MAGIC:
        current = decompress_yaz0(current)
    return current


def decode_cbor_message_pack(buf):
    try:
        import cbor2
    except ImportError:
        return None

    try:
        decoded = cbor2.load(BytesIO(buf))
    except Exception:
        return None

    if not isinstance(decoded, dict):
        return None

    mergeable = decoded.get("Mergeable")
    if isinstance(mergeable, dict):
        message_pack = mergeable.get("MessagePack")
        if isinstance(message_pack, dict):
            return message_pack

    message_pack = decoded.get("MessagePack")
    if isinstance(message_pack, dict):
        return message_pack

    return None


def locate_sarc(buf):
    sarc = find_magic(buf, b"SARC")
    if sarc == -1:
        raise ValueError("Impossible de trouver la signature SARC")

    bom = buf[sarc + 4 : sarc + 6]
    if bom == b"\xfe\xff":
        endian = ">"
    elif bom == b"\xff\xfe":
        endian = "<"
    else:
        endian = ">"

    header_size = read_u16(buf, sarc + 6, endian)
    data_start = sarc + header_size
    return sarc, data_start, endian


def parse_entries(buf, sarc, data_start, endian):
    sfat = find_magic(buf, b"SFAT")
    sfnt = find_magic(buf, b"SFNT")
    if sfat == -1 or sfnt == -1:
        raise ValueError("SFAT ou SFNT introuvable")

    found = None
    for hdr in (8, 12, 16):
        region_len = sfnt - (sfat + hdr)
        for entry_size in (12, 16):
            if region_len > 0 and region_len % entry_size == 0:
                node_count = region_len // entry_size
                if 0 < node_count < 100000:
                    found = (hdr, entry_size, node_count)
                    break
        if found:
            break

    if not found:
        raise ValueError("Impossible de déterminer la structure SFAT")

    hdr_len, entry_size, node_count = found
    entries = []
    off = sfat + hdr_len
    for _ in range(node_count):
        namehash = read_u32(buf, off, endian)
        start = read_u32(buf, off + 4, endian)
        end = read_u32(buf, off + 8, endian)
        entries.append((namehash, start, end))
        off += entry_size

    str_off = sfnt + 8
    if data_start and data_start > str_off:
        str_end = data_start
    elif sarc and sarc > str_off:
        str_end = sarc
    else:
        str_end = len(buf)

    names = []
    cur = []
    for b in buf[str_off:str_end]:
        if b == 0:
            if cur:
                names.append(bytes(cur).decode("utf-8", errors="replace"))
                cur = []
        else:
            cur.append(b)
    if cur:
        names.append(bytes(cur).decode("utf-8", errors="replace"))

    if len(names) >= len(entries):
        names = names[-len(entries) :]
    else:
        names = [f"file_{i:04d}" for i in range(len(entries))]

    return entries, names


def extract_message_pack(buf, outdir):
    message_pack = decode_cbor_message_pack(buf)
    if not message_pack:
        return None

    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    written = []
    for key, value in message_pack.items():
        rel_name = Path(*Path(f"{key}.json").parts)
        out_path = safe_join(outdir, rel_name)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        if isinstance(value, str):
            try:
                payload = json.loads(value)
                text = json.dumps(payload, ensure_ascii=False, indent=2)
            except Exception:
                text = value
        else:
            text = json.dumps(value, ensure_ascii=False, indent=2)

        out_path.write_text(text, encoding="utf-8")
        written.append(rel_name.as_posix())
        print(rel_name.as_posix())

    return 0 if written else 1


def extract_sarc(path, outdir):
    raw = Path(path).read_bytes()
    # Try decode without dict first, but allow environment variable or
    # presence of scripts/zstd_dict.bin to be used automatically.
    dict_path = None
    # Allow explicit env var override
    env_path = os.environ.get("UKMM_ZSTD_DICT")
    if env_path:
        p = Path(env_path)
        if p.exists():
            dict_path = str(p)

    # Common candidate locations (project-local or sibling ukmm patch)
    if not dict_path:
        candidates = [
            Path(__file__).parent / 'zstd_dict.bin',
            Path(__file__).parent / 'zstd_dict',
            Path(__file__).parent / 'data' / 'zsdic',
            Path(__file__).parent.parent / 'data' / 'zsdic',
            Path(__file__).parent.parent / 'ukmm-modzip-patch' / 'data' / 'zsdic',
            Path.cwd() / 'ukmm-modzip-patch' / 'data' / 'zsdic',
        ]
        for candidate in candidates:
            try:
                if candidate.exists():
                    dict_path = str(candidate)
                    break
            except Exception:
                continue

    try:
        # prefer dict-aware path if dict present
        if dict_path:
            buf = maybe_decompress_zstd_with_dict(raw, dict_path)
        else:
            buf = decode_blob(raw)
    except RuntimeError:
        # fallback to generic decode_blob to preserve original behavior
        buf = decode_blob(raw)

    try:
        sarc, data_start, endian = locate_sarc(buf)
    except ValueError:
        fallback = extract_message_pack(buf, outdir)
        if fallback is not None:
            return fallback
        raise
    entries, names = parse_entries(buf, sarc, data_start, endian)

    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    written = []
    for index, (_, start, end) in enumerate(entries):
        rel_name = Path(*Path(names[index]).parts)
        abs_start = data_start + start
        abs_end = data_start + end
        if abs_end > len(buf):
            abs_end = len(buf)
        data = decode_blob(buf[abs_start:abs_end])

        out_path = safe_join(outdir, rel_name)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(data)
        written.append(rel_name.as_posix())
        print(rel_name.as_posix())

    return 0 if written else 1


def main():
    parser = argparse.ArgumentParser(
        description="Décompresse un SARC UKMM et recrée son arborescence de fichiers."
    )
    parser.add_argument("input", help="Fichier .sarc ou archive compressée en entrée")
    parser.add_argument("output", help="Dossier de sortie")
    args = parser.parse_args()
    return extract_sarc(args.input, args.output)


if __name__ == "__main__":
    sys.exit(main())
