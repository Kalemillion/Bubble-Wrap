import sys

def main(path):
    with open(path, 'rb') as f:
        buf = f.read()
    print('len', len(buf))
    for m in (b'SARC', b'Yaz0', b'YAZ0', b'SFAT', b'SFNT'):
        print(m.decode(), buf.find(m))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: check_magic.py <file>')
        sys.exit(2)
    main(sys.argv[1])
