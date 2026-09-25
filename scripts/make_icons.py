"""Generate the extension's PNG icons (no dependencies)."""
import math, struct, zlib, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "extension" / "icons"
BG = (29, 78, 216)   # blue
FG = (255, 255, 255)

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def sample(x, y):
    """x, y in [0,1]. Returns (r,g,b,a) for one sub-sample."""
    r = 0.22  # corner radius
    cx = min(max(x, r), 1 - r); cy = min(max(y, r), 1 - r)
    if math.hypot(x - cx, y - cy) > r:
        return (0, 0, 0, 0)
    # a "hop" arc above a check mark
    arc = abs(math.hypot(x - 0.5, y - 0.62) - 0.30) < 0.045 and y < 0.52
    check = min(seg_dist(x, y, 0.30, 0.60, 0.45, 0.74), seg_dist(x, y, 0.45, 0.74, 0.72, 0.44)) < 0.06
    return (*FG, 255) if (arc or check) else (*BG, 255)

def png(size):
    ss = 4
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    c = sample((i + (si + .5) / ss) / size, (j + (sj + .5) / ss) / size)
                    for k in range(3): acc[k] += c[k] * c[3]
                    acc[3] += c[3]
            a = acc[3] / (ss * ss)
            rgb = [int(acc[k] / acc[3]) if acc[3] else 0 for k in range(3)]
            row += bytes(rgb + [int(a)])
        rows.append(bytes(row))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))

OUT.mkdir(parents=True, exist_ok=True)
for s in (16, 32, 48, 128):
    (OUT / f"icon{s}.png").write_bytes(png(s))
    print("wrote", OUT / f"icon{s}.png")
