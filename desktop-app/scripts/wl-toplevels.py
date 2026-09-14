#!/usr/bin/env python3
"""wl-toplevels.py - print the Wayland app_id and title of every open window.

Zero dependencies: speaks the Wayland wire protocol over the compositor socket and binds
ext_foreign_toplevel_list_v1 (exposed by COSMIC, and by recent KWin/wlroots compositors).
Use it to read the exact app_id a launcher's StartupWMClass must match.

    wl-toplevels.py            all windows as "app_id | title"
    wl-toplevels.py md2web     only lines containing "md2web" (case-insensitive)
"""
import os, select, socket, struct, sys, time

# ─── Wire helpers ───
def send(sock, obj, opcode, payload=b''):
    sock.sendall(struct.pack('<IHH', obj, opcode, 8 + len(payload)) + payload)

def wl_string(s):
    b = s.encode() + b'\0'
    return struct.pack('<I', len(b)) + b + b'\0' * (-len(b) % 4)

def read_string(data, offset):
    n = struct.unpack_from('<I', data, offset)[0]
    return data[offset + 4:offset + 4 + n - 1].decode(errors='replace'), offset + 4 + (n + 3) // 4 * 4

# ─── Main ───
def main():
    needle = sys.argv[1].lower() if len(sys.argv) > 1 else ''
    display = os.environ.get('WAYLAND_DISPLAY', 'wayland-0')
    path = display if display.startswith('/') else os.path.join(os.environ['XDG_RUNTIME_DIR'], display)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)

    REGISTRY, next_id, list_id = 2, 3, None
    send(sock, 1, 1, struct.pack('<I', REGISTRY))        # wl_display.get_registry
    windows, buf, deadline = {}, b'', time.time() + 1.5
    while time.time() < deadline:
        if not select.select([sock], [], [], 0.2)[0]:
            continue
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
        while len(buf) >= 8:
            obj, opcode, size = struct.unpack_from('<IHH', buf)
            if len(buf) < size:
                break
            data, buf = buf[8:size], buf[size:]
            if obj == REGISTRY and opcode == 0:            # wl_registry.global
                name = struct.unpack_from('<I', data)[0]
                iface, _ = read_string(data, 4)
                if iface == 'ext_foreign_toplevel_list_v1':
                    list_id, next_id = next_id, next_id + 1
                    send(sock, REGISTRY, 0, struct.pack('<I', name) + wl_string(iface) + struct.pack('<II', 1, list_id))
            elif obj == list_id and opcode == 0:          # list.toplevel(new_id)
                windows[struct.unpack_from('<I', data)[0]] = {}
            elif obj in windows and opcode in (2, 3):     # handle.title / handle.app_id
                windows[obj]['title' if opcode == 2 else 'app_id'] = read_string(data, 0)[0]

    if list_id is None:
        sys.exit('compositor does not expose ext_foreign_toplevel_list_v1')
    for w in windows.values():
        line = f"{w.get('app_id', '')} | {w.get('title', '')}"
        if needle in line.lower():
            print(line)

if __name__ == '__main__':
    main()
