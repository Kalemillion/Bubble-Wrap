from pathlib import Path
p=Path('Msg_EUfr.product.sarc')
if not p.exists():
    print('not found')
    raise SystemExit(1)
b=p.read_bytes()
seq=b'SARC'
found=[i for i in range(len(b)) if b.startswith(seq,i)]
print('found',len(found),'occurrences')
if found:
    for o in found[:50]:
        print(o)
