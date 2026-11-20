#!/usr/bin/env python3
"""Termosifoni — pannello locale per eQ-3 MAX! Cube.

Avvio:  python3 server.py [IP_CUBE] [--port 8765] [--data CARTELLA] [--idle-exit SECONDI]
Poi apri http://127.0.0.1:8765
Termosifoni.app lo avvia con --idle-exit 180: si spegne da solo quando chiudi il pannello.

Solo libreria standard (Python 3.9+). Il server:
  * interroga il Cube ogni 2 minuti;
  * ricorda l'ultima temperatura misurata da ogni valvola (le valvole la
    comunicano solo ogni tanto);
  * espone una piccola API JSON usata dalla pagina web.

Protocollo (porta TCP 62910): in lettura H:/M:/C:/L:, in scrittura s:<base64>
con pacchetto  00 <flag> <cmd> 000000 <rf destinatario> <stanza> <dati>.
Riferimenti: python-maxcube-api e il modulo MAX di FHEM.
"""
import argparse
import base64
import datetime as dt
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

CUBE_PORT = 62910
DISCOVERY_PORT = 23272
POLL_SECONDS = 120

TYPE_NAMES = {0: "Cube", 1: "Valvola termostatica", 2: "Valvola termostatica+",
              3: "Termostato a parete", 4: "Contatto finestra", 5: "Pulsante eco"}
RADIATOR = (1, 2)
WALL = 3
THERMOSTATS = (1, 2, 3)
MODES = {0: "auto", 1: "manuale", 2: "vacanza", 3: "boost"}
BOOST_MINUTES = [0, 5, 10, 15, 20, 25, 30, 60]

CMD_WEEK_PROFILE = 0x10
CMD_CONFIG_TEMPS = 0x11
CMD_CONFIG_VALVE = 0x12
CMD_SET_TEMP = 0x40

STATIC = Path(__file__).with_name("static")
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                ".png": "image/png"}


# ====================================================================== rete

def local_networks():
    """Reti IPv4 del Mac (da ifconfig): [(ip, maschera_int, broadcast)], escluse loopback e /16 o più grandi."""
    import ipaddress
    import re
    import subprocess
    nets = []
    try:
        out = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return nets
    for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+) netmask 0x([0-9a-f]{8})(?: broadcast (\d+\.\d+\.\d+\.\d+))?", out):
        ip, mask, bcast = m.group(1), int(m.group(2), 16), m.group(3)
        if ip.startswith("127.") or ip.startswith("169.254."):
            continue
        prefix = bin(mask).count("1")
        if prefix < 22:                       # reti troppo grandi da scandire
            continue
        net = ipaddress.ip_network("%s/%d" % (ip, prefix), strict=False)
        nets.append({"ip": ip, "network": str(net), "broadcast": bcast or str(net.broadcast_address)})
    return nets


def _parse_hello(data, ip, method):
    """Risposta UDP del Cube: 'eQ3MaxAp' + seriale(10) + 3 byte + rf(3) + firmware(2)."""
    info = {"ip": ip, "method": method, "serial": data[8:18].decode("latin1", "replace")}
    if len(data) >= 26:
        info["rf"] = data[21:24].hex()
        info["firmware"] = "%d.%d.%d" % tuple(int(c) for c in data[24:26].hex()[-3:])
    return info


def discover_udp(timeout=3.0):
    """Broadcast UDP ufficiale eQ-3, inviato su ogni rete del Mac. Ritorna tutti i Cube che rispondono."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    s.bind(("", DISCOVERY_PORT))            # il Cube risponde sempre alla porta 23272
    s.settimeout(0.3)
    msg = b"eQ3Max*\x00**********I"
    try:
        targets = {"255.255.255.255"} | {n["broadcast"] for n in local_networks()}
        for _ in range(2):
            for t in targets:
                try:
                    s.sendto(msg, (t, DISCOVERY_PORT))
                except OSError:
                    pass
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, addr = s.recvfrom(1024)
            except socket.timeout:
                continue
            if data.startswith(b"eQ3MaxAp") and addr[0] not in found:
                found[addr[0]] = _parse_hello(data, addr[0], "broadcast")
    finally:
        s.close()
    return list(found.values())


def probe_tcp(ip, timeout=0.35):
    """Prova la porta 62910: un Cube risponde subito con la riga H:<seriale>,<rf>,<firmware>,..."""
    try:
        with socket.create_connection((ip, CUBE_PORT), timeout=timeout) as c:
            c.settimeout(2.0)
            buf = b""
            while b"\n" not in buf and len(buf) < 256:
                chunk = c.recv(256)
                if not chunk:
                    break
                buf += chunk
    except OSError:
        return None
    line = buf.split(b"\n", 1)[0].decode("latin1", "replace").strip()
    if not line.startswith("H:"):
        return None
    f = line[2:].split(",")
    info = {"ip": ip, "method": "scansione", "serial": f[0]}
    if len(f) > 2:
        info["rf"] = f[1]
        info["firmware"] = "%d.%d.%d" % tuple(int(c) for c in f[2][-3:])
    return info


def scan_tcp(skip=(), workers=128):
    """Scansione della porta 62910 su tutte le reti locali (per i router che bloccano i broadcast)."""
    import ipaddress
    from concurrent.futures import ThreadPoolExecutor
    hosts = []
    for n in local_networks():
        for h in ipaddress.ip_network(n["network"]).hosts():
            h = str(h)
            if h != n["ip"] and h not in skip:
                hosts.append(h)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return [r for r in ex.map(probe_tcp, hosts) if r]


def discover():
    """Primo Cube trovato con il broadcast, o None."""
    found = discover_udp()
    return found[0]["ip"] if found else None


class CubeConnection:
    """Una sessione TCP: all'apertura il Cube invia H:, M:, C:..., L:."""

    def __init__(self, ip):
        self.sock = socket.create_connection((ip, CUBE_PORT), timeout=10)
        self.buf = b""
        self.lines = []
        while True:
            line = self._readline(10)
            self.lines.append(line)
            if line.startswith("L:"):
                break

    def _readline(self, timeout):
        self.sock.settimeout(timeout)
        while b"\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("il Cube ha chiuso la connessione")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode("latin1").strip()

    def radio(self, flags, cmd, rf, room, data: bytes):
        payload = bytes([0x00, flags, cmd]) + b"\x00\x00\x00" + bytes.fromhex(rf) + bytes([room]) + data
        self.sock.sendall(b"s:" + base64.b64encode(payload) + b"\r\n")
        while True:
            line = self._readline(30)
            if line.startswith("S:"):
                duty, status, slots = line[2:].split(",")
                return {"duty": int(duty, 16), "ok": status == "0", "slots": int(slots, 16)}

    def close(self):
        try:
            self.sock.sendall(b"q:\r\n")
        except OSError:
            pass
        self.sock.close()


# ================================================================ decodifica

def decode_program(raw: bytes):
    """182 byte -> 7 giorni (indice 0 = sabato) di [{until, temp}]."""
    days = []
    for d in range(7):
        chunk = raw[d * 26:(d + 1) * 26]
        points = []
        for i in range(0, len(chunk) - 1, 2):
            word = (chunk[i] << 8) | chunk[i + 1]
            mins = (word & 0x1FF) * 5
            points.append({"until": "%02d:%02d" % (mins // 60, mins % 60), "temp": (word >> 9) / 2.0})
            if mins >= 1440:
                break
        days.append(points)
    return days


def parse(lines):
    """Trasforma le righe del Cube in un dizionario con cube, stanze e dispositivi."""
    cube, rooms, devices, configs, live = {}, [], [], {}, {}
    for line in lines:
        kind, _, rest = line.partition(":")
        if kind == "H":
            f = rest.split(",")
            cube = {"serial": f[0], "rf": f[1], "firmware": "%d.%d.%d" % tuple(int(c) for c in f[2][-3:])}
        elif kind == "M":
            b = base64.b64decode(rest.split(",", 2)[2])
            i = 3
            for _ in range(b[2]):
                rid, ln = b[i], b[i + 1]
                rooms.append({"id": rid, "name": b[i + 2:i + 2 + ln].decode("latin1")})
                i += 2 + ln + 3
            n = b[i]
            i += 1
            for _ in range(n):
                t = b[i]
                ln = b[i + 14]
                devices.append({"type": t, "type_name": TYPE_NAMES.get(t, str(t)),
                                "rf": b[i + 1:i + 4].hex(), "serial": b[i + 4:i + 14].decode("latin1"),
                                "name": b[i + 15:i + 15 + ln].decode("latin1"), "room": b[i + 15 + ln]})
                i += 16 + ln
        elif kind == "C":
            rf, data = rest.split(",", 1)
            configs[rf.lower()] = base64.b64decode(data)
        elif kind == "L":
            b = base64.b64decode(rest)
            i = 0
            while i < len(b):
                ln = b[i]
                d = b[i:i + ln + 1]
                i += ln + 1
                info = {}
                if len(d) >= 7:
                    f1, f2 = d[5], d[6]
                    info.update(mode=MODES[f2 & 3], battery_low=bool(f2 & 0x80),
                                link_error=bool(f2 & 0x40), error=bool(f1 & 0x08),
                                locked=bool(f2 & 0x20))
                if len(d) >= 9:
                    info["valve"] = d[7]
                    info["setpoint"] = (d[8] & 0x7F) / 2.0
                if ln == 12:                                   # termostato a parete
                    info["actual"] = (((d[8] & 0x80) << 1) | d[12]) / 10.0
                elif ln == 11 and info.get("mode") != "vacanza":
                    v = ((d[9] & 0x01) << 8) | d[10]
                    if v:
                        info["actual"] = v / 10.0
                live[d[1:4].hex()] = info

    for dev in devices:
        dev.update(live.get(dev["rf"], {}))
        c = configs.get(dev["rf"])
        if not c or dev["type"] not in THERMOSTATS:
            continue
        cfg = {"comfort": c[18] / 2.0, "eco": c[19] / 2.0, "max": c[20] / 2.0, "min": c[21] / 2.0}
        if dev["type"] in RADIATOR:
            cfg.update(offset=c[22] / 2.0 - 3.5, window_temp=c[23] / 2.0, window_minutes=c[24] * 5,
                       boost_minutes=BOOST_MINUTES[c[25] >> 5], boost_valve=(c[25] & 0x1F) * 5,
                       decalc_day=c[26] >> 5, decalc_hour=c[26] & 0x1F,
                       raw_max_valve=c[27], raw_valve_offset=c[28])
            dev["program"] = decode_program(c[29:29 + 182])
        else:
            dev["program"] = decode_program(c[22:22 + 182])
            if len(c) >= 206:
                cfg.update(offset=c[204] / 2.0 - 3.5, window_temp=c[205] / 2.0)
        dev["config"] = cfg
    return {"cube": cube, "rooms": rooms, "devices": devices}


def summarize_room(room, devices, last_actual):
    """Vista per stanza: temperatura misurata (o l'ultima nota), obiettivo, modalità, avvisi."""
    devs = [d for d in devices if d["room"] == room["id"]]
    therm = [d for d in devs if d["type"] in THERMOSTATS]
    radiators = [d for d in devs if d["type"] in RADIATOR]
    wall = next((d for d in devs if d["type"] == WALL), None)
    lead = wall or (radiators[0] if radiators else None)
    ref = radiators[0] if radiators else wall

    measured, measured_ts, source = None, None, None
    if wall and wall.get("actual") is not None:
        measured, measured_ts, source = wall["actual"], int(time.time()), wall["name"]
    else:
        best = None
        for d in radiators:
            la = last_actual.get(d["rf"])
            if la and (best is None or la[1] > best[1]):
                best = (la[0], la[1], d["name"])
        if best:
            measured, measured_ts, source = best

    valves = [d["valve"] for d in radiators if d.get("valve") is not None]
    alerts = []
    for d in devs:
        if d.get("battery_low"):
            alerts.append({"kind": "batteria", "device": d["name"], "text": "Batteria scarica"})
        if d.get("link_error"):
            alerts.append({"kind": "collegamento", "device": d["name"], "text": "Non raggiungibile via radio"})
        elif d.get("error"):
            alerts.append({"kind": "errore", "device": d["name"], "text": "L'ultimo comando non è stato confermato"})

    programs = [json.dumps(d.get("program")) for d in therm if d.get("program")]
    return {
        "id": room["id"], "name": room["name"],
        "measured": measured, "measured_ts": measured_ts, "measured_by": source,
        "setpoint": lead.get("setpoint") if lead else None,
        "mode": lead.get("mode") if lead else None,
        "valve": round(sum(valves) / len(valves)) if valves else None,
        "heating": any(v > 0 for v in valves),
        "program": ref.get("program") if ref else None,
        "program_mismatch": len(set(programs)) > 1,
        "config": ref.get("config") if ref else None,
        "devices": devs, "alerts": alerts,
    }


# ============================================================= memoria locale

class Store:
    """Piccolo file JSON: IP del Cube e ultima temperatura inviata da ogni valvola."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text())
        except (OSError, ValueError):
            self.data = {}

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.path)

    def get(self, k, default=None):
        with self.lock:
            return self.data.get(k, default)

    def put(self, k, v):
        with self.lock:
            self.data[k] = v
            self._save()

    def last_actuals(self):
        with self.lock:
            return {rf: tuple(v) for rf, v in self.data.get("last_actual", {}).items()}

    def remember_actuals(self, ts, devices):
        new = {d["rf"]: [d["actual"], ts] for d in devices if d.get("actual") is not None}
        if new:
            with self.lock:
                self.data.setdefault("last_actual", {}).update(new)
                self._save()


# ==================================================================== motore

class Engine:
    def __init__(self, store: Store, ip=None):
        self.store = store
        self.ip = ip or store.get("cube_ip")
        self.cube_lock = threading.Lock()           # il Cube accetta un solo client
        self.state = None
        self.error = None
        self.updated = None
        self.wake = threading.Event()

    # ---- connessione con riscoperta automatica se l'IP cambia
    def _connect(self):
        if self.ip:
            try:
                return CubeConnection(self.ip)
            except OSError:
                pass
        found = discover()
        if not found:
            raise ConnectionError("Cube non trovato sulla rete")
        self.ip = found
        self.store.put("cube_ip", found)
        return CubeConnection(found)

    def poll(self):
        with self.cube_lock:
            conn = self._connect()
            try:
                st = parse(conn.lines)
            finally:
                conn.close()
        ts = int(time.time())
        self.store.remember_actuals(ts, st["devices"])
        last = self.store.last_actuals()
        st["rooms"] = [summarize_room(r, st["devices"], last) for r in st["rooms"]]
        st["cube"]["ip"] = self.ip
        self.state, self.error, self.updated = st, None, ts
        return st

    def loop(self):
        while True:
            try:
                self.poll()
            except Exception as e:                     # rete giù, Cube occupato…
                self.error = str(e)
            self.wake.wait(POLL_SECONDS)
            self.wake.clear()

    # ---- ricerca e scelta del Cube
    def search(self):
        """Broadcast + scansione della porta 62910. Tiene il lock: il Cube accetta un solo client."""
        t0 = time.time()
        with self.cube_lock:
            found = {c["ip"]: c for c in discover_udp()}
            for c in scan_tcp(skip=set(found)):
                found.setdefault(c["ip"], c)
        for c in found.values():
            c["current"] = c["ip"] == self.ip
        return {"cubes": sorted(found.values(), key=lambda c: tuple(int(x) for x in c["ip"].split("."))),
                "networks": [n["network"] for n in local_networks()],
                "seconds": round(time.time() - t0, 1)}

    def use_cube(self, ip):
        import ipaddress
        try:
            ip = str(ipaddress.IPv4Address(ip.strip()))
        except (ValueError, AttributeError):
            raise ValueError("Indirizzo IP non valido")
        with self.cube_lock:
            info = probe_tcp(ip, timeout=2.0)
        if not info:
            raise ValueError("A %s non risponde nessun Cube MAX!" % ip)
        self.ip = ip
        self.store.put("cube_ip", ip)
        self.poll()
        return self.snapshot()

    def snapshot(self):
        return {"state": self.state, "error": self.error, "updated": self.updated,
                "poll_seconds": POLL_SECONDS}

    def room(self, room_id):
        if not self.state:
            raise ValueError("Stato non ancora disponibile")
        r = next((r for r in self.state["rooms"] if r["id"] == room_id), None)
        if not r:
            raise ValueError("Stanza sconosciuta")
        return r

    def _send(self, messages):
        """messages: lista di (descrizione, flags, cmd, rf, room, data). Si ferma al primo rifiuto."""
        results = []
        with self.cube_lock:
            conn = self._connect()
            try:
                for label, flags, cmd, rf, room, data in messages:
                    r = conn.radio(flags, cmd, rf, room, data)
                    r["label"] = label
                    results.append(r)
                    if not r["ok"]:
                        break
                    time.sleep(0.25)
            finally:
                conn.close()
        ok = all(r["ok"] for r in results)
        threading.Timer(3, self.wake.set).start()      # rilegge lo stato a breve
        out = {"ok": ok, "sent": sum(r["ok"] for r in results), "total": len(messages)}
        if not ok:
            duty = results[-1]["duty"]
            out["error"] = ("Il Cube ha raggiunto il limite di trasmissioni radio (%d%%). "
                            "Riprova tra circa un'ora." % duty if duty >= 90
                            else "Il Cube ha rifiutato il comando.")
        return out

    # ---- comandi
    def set_mode(self, room_id, mode, temp=None, until=None):
        rooms = self.state["rooms"] if room_id == "all" else [self.room(int(room_id))]
        msgs = []
        for r in rooms:
            therm = [d for d in r["devices"] if d["type"] in THERMOSTATS]
            if not therm:
                continue
            extra = b""
            if mode == "auto":
                byte = 0 if temp is None else int(check_temp(temp) * 2)
            elif mode == "manuale":
                byte = (1 << 6) | int(check_temp(temp) * 2)
            elif mode == "boost":
                byte = 3 << 6
            elif mode == "vacanza":
                byte = (2 << 6) | int(check_temp(temp) * 2)
                extra = encode_until(until)
            else:
                raise ValueError("Modalità sconosciuta")
            # flag 04 = comando di gruppo: vale per tutta la stanza
            msgs.append(("%s: %s" % (r["name"], mode), 0x04, CMD_SET_TEMP, therm[0]["rf"], r["id"],
                         bytes([byte]) + extra))
        return self._send(msgs)

    def set_program(self, room_id, days, points):
        r = self.room(room_id)
        validate_points(points)
        norm = [{"until": p["until"], "temp": float(p["temp"])} for p in points]
        words = encode_points(norm)
        msgs = []
        for d in r["devices"]:
            if d["type"] not in THERMOSTATS or "program" not in d:
                continue
            for day in days:
                if d["program"][day] == norm:
                    continue
                first = words[:7]
                first += [0] * (7 - len(first))
                msgs.append(("%s, giorno %d" % (d["name"], day), 0x00, CMD_WEEK_PROFILE, d["rf"], r["id"],
                             bytes([day]) + b"".join(w.to_bytes(2, "big") for w in first)))
                if len(words) > 7:                      # seconda metà: fasce 8–13
                    msgs.append(("%s, giorno %d (2)" % (d["name"], day), 0x00, CMD_WEEK_PROFILE, d["rf"],
                                 r["id"], bytes([0x10 | day]) + b"".join(w.to_bytes(2, "big") for w in words[7:])))
        if not msgs:
            return {"ok": True, "sent": 0, "total": 0}
        return self._send(msgs)

    def set_config(self, room_id, cfg):
        r = self.room(room_id)
        comfort, eco = check_temp(cfg["comfort"]), check_temp(cfg["eco"])
        tmax, tmin = check_temp(cfg["max"]), check_temp(cfg["min"])
        if tmin > tmax:
            raise ValueError("La minima non può superare la massima")
        wtemp = check_temp(cfg["window_temp"])
        wmin = int(cfg["window_minutes"])
        if wmin % 5 or not 0 <= wmin <= 60:
            raise ValueError("Durata finestra aperta: da 0 a 60 minuti, a passi di 5")
        boost_min, boost_valve = int(cfg["boost_minutes"]), int(cfg["boost_valve"])
        if boost_min not in BOOST_MINUTES or boost_valve % 5 or not 0 <= boost_valve <= 100:
            raise ValueError("Valori di boost non validi")
        dday, dhour = int(cfg["decalc_day"]), int(cfg["decalc_hour"])
        if not (0 <= dday <= 6 and 0 <= dhour <= 23):
            raise ValueError("Orario anticalcare non valido")
        msgs = []
        for d in r["devices"]:
            c = d.get("config")
            if d["type"] not in THERMOSTATS or not c:
                continue
            offset = c.get("offset", 0.0)
            temps = bytes([int(comfort * 2), int(eco * 2), int(tmax * 2), int(tmin * 2),
                           int((offset + 3.5) * 2), int(wtemp * 2), wmin // 5])
            if any(c.get(k) != v for k, v in (("comfort", comfort), ("eco", eco), ("max", tmax), ("min", tmin),
                                              ("window_temp", wtemp))) or \
                    (d["type"] in RADIATOR and c.get("window_minutes") != wmin):
                msgs.append(("%s: temperature" % d["name"], 0x00, CMD_CONFIG_TEMPS, d["rf"], 0, temps))
            if d["type"] in RADIATOR and (c["boost_minutes"], c["boost_valve"], c["decalc_day"], c["decalc_hour"]) \
                    != (boost_min, boost_valve, dday, dhour):
                valve = bytes([(BOOST_MINUTES.index(boost_min) << 5) | (boost_valve // 5),
                               (dday << 5) | dhour, c["raw_max_valve"], c["raw_valve_offset"]])
                msgs.append(("%s: valvola" % d["name"], 0x00, CMD_CONFIG_VALVE, d["rf"], 0, valve))
        if not msgs:
            return {"ok": True, "sent": 0, "total": 0}
        return self._send(msgs)


def check_temp(t):
    t = float(t)
    if not 4.5 <= t <= 30.5 or t * 2 != int(t * 2):
        raise ValueError("Temperatura non valida: %s" % t)
    return t


def encode_until(s):
    """'2026-12-24T18:30' -> 3 byte nel formato MAX! (minuti solo :00 o :30)."""
    t = dt.datetime.strptime(s, "%Y-%m-%dT%H:%M")
    if t.minute not in (0, 30):
        raise ValueError("L'orario di fine deve essere all'ora o alla mezz'ora")
    if t <= dt.datetime.now():
        raise ValueError("La fine deve essere nel futuro")
    v = ((t.month & 0xE) << 20) | (t.day << 16) | ((t.month & 1) << 15) | ((t.year - 2000) << 8) \
        | (t.hour * 2 + t.minute // 30)
    return v.to_bytes(3, "big")


def validate_points(points):
    if not 1 <= len(points) <= 13:
        raise ValueError("Servono da 1 a 13 fasce per giorno")
    last = 0
    for p in points:
        check_temp(p["temp"])
        h, m = (int(x) for x in p["until"].split(":"))
        mins = h * 60 + m
        if mins % 5:
            raise ValueError("Gli orari devono essere multipli di 5 minuti")
        if mins <= last:
            raise ValueError("Gli orari devono essere crescenti")
        last = mins
    if last != 1440:
        raise ValueError("L'ultima fascia deve finire alle 24:00")


def encode_points(points):
    out = []
    for p in points:
        h, m = (int(x) for x in p["until"].split(":"))
        out.append((int(float(p["temp"]) * 2) << 9) | ((h * 60 + m) // 5))
    return out


# ====================================================================== HTTP

ENGINE = None
PORT = 8765
LAST_SEEN = time.time()        # ultima richiesta da una pagina aperta


class Handler(BaseHTTPRequestHandler):
    server_version = "Termosifoni"

    def parse_request(self):
        global LAST_SEEN
        ok = super().parse_request()
        if ok:
            LAST_SEEN = time.time()
        return ok

    def _send(self, code, body: bytes, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        origin = self.headers.get("Origin")
        okhosts = ("127.0.0.1", "localhost")
        if host not in okhosts:
            return False
        if origin and urlparse(origin).hostname not in okhosts:
            return False
        return True

    def do_GET(self):
        if not self._local_only():
            return self._json(403, {"error": "accesso consentito solo da questo Mac"})
        u = urlparse(self.path)
        if u.path == "/api/state":
            return self._json(200, ENGINE.snapshot())
        if u.path == "/api/ping":                 # segnale di presenza della pagina
            return self._json(200, {"ok": True})
        name = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        f = (STATIC / name).resolve()
        if f.parent != STATIC.resolve() or not f.is_file() or f.suffix not in STATIC_TYPES:
            return self._json(404, {"error": "non trovato"})
        self._send(200, f.read_bytes(), STATIC_TYPES[f.suffix], "no-cache")

    def do_POST(self):
        if not self._local_only():
            return self._json(403, {"error": "accesso consentito solo da questo Mac"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
            p = urlparse(self.path).path
            if p == "/api/refresh":
                ENGINE.poll()
                return self._json(200, ENGINE.snapshot())
            if p == "/api/discover":
                return self._json(200, ENGINE.search())
            if p == "/api/cube":
                return self._json(200, ENGINE.use_cube(data.get("ip", "")))
            if p == "/api/mode":
                res = ENGINE.set_mode(data["room"], data["mode"], data.get("temp"), data.get("until"))
            elif p == "/api/program":
                res = ENGINE.set_program(int(data["room"]), [int(d) for d in data["days"]], data["points"])
            elif p == "/api/config":
                res = ENGINE.set_config(int(data["room"]), data["config"])
            else:
                return self._json(404, {"error": "non trovato"})
            self._json(200 if res["ok"] else 409, res)
        except (ValueError, KeyError) as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(502, {"error": "Il Cube non risponde: %s" % e})

    def log_message(self, fmt, *args):
        pass


def main():
    global ENGINE, PORT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ip", nargs="?", help="IP del Cube (se omesso lo cerca in rete)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", default=str(Path(__file__).with_name("data")), help="cartella per i dati locali")
    ap.add_argument("--idle-exit", type=int, default=0, metavar="SECONDI",
                    help="si spegne se nessuna pagina lo contatta per questo tempo (0 = mai)")
    a = ap.parse_args()
    PORT = a.port
    ENGINE = Engine(Store(Path(a.data) / "stato.json"), a.ip)
    httpd = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    threading.Thread(target=ENGINE.loop, daemon=True).start()
    if a.idle_exit > 0:
        threading.Thread(target=idle_watchdog, args=(httpd, a.idle_exit), daemon=True).start()
    print("Termosifoni: http://127.0.0.1:%d" % a.port, flush=True)
    httpd.serve_forever()
    print("Nessuna pagina aperta da %d s: server spento." % a.idle_exit, flush=True)


def idle_watchdog(httpd, idle):
    """Spegne il server quando il pannello è chiuso da `idle` secondi (mai durante un comando al Cube)."""
    while True:
        time.sleep(5)
        if time.time() - LAST_SEEN > idle and ENGINE.cube_lock.acquire(blocking=False):
            httpd.shutdown()
            return


if __name__ == "__main__":
    main()
