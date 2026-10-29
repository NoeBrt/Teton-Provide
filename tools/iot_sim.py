#!/usr/bin/env python3
"""Simulated sensors over real Bluetooth LE, for the iPhone app (configurator/).

One Bumble host owns hci0 through the kernel's HCI user channel. Each identity directory (`stage init` +
`iot-workshop certify` + `stage install`, the same files as /var/lib/iot-device) becomes one sensor with its own
static random address; ~20 legacy ADV_IND sets rotate over all identities. The GATT and Noise behaviour is a port of
device/bin/main.rs and device/src/provision.rs; NetworkManager is replaced by a timed outcome per identity (PLAN).

  sudo .venv/bin/python iot_sim.py ~/noe-ws/lab-sensors      # iot-device + bluetooth stopped, hci0 down
  .venv/bin/python iot_sim.py --selftest .../configurator/src/noise-vectors.json
"""
import asyncio
import hashlib
import hmac
import itertools
import os
import re
import struct
import sys
import time
from pathlib import Path

from bumble import att, hci
from bumble.device import AdvertisingEventProperties, AdvertisingParameters, Device, DeviceConfiguration
from bumble.gatt import Characteristic, CharacteristicValue, Service
from bumble.gatt_server import Server
from bumble.pairing import PairingConfig, PairingDelegate
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

SERVICE_UUID = '3b0a90ce-9564-40d1-b96b-14cf8858aba3'  # device/src/protocol.rs:7
HELLO_UUID = '29b3765c-de49-4114-889e-89b05852c968'  # device/src/protocol.rs:8
PROVISION_UUID = '3c2c02fa-847e-480c-9f22-b239dfa524c9'  # device/src/provision.rs:30
NOISE_NAME = b'Noise_XX_25519_ChaChaPoly_SHA256'  # exactly 32 bytes, so h = name
PROLOGUE = b'iot-provision/2'  # device/src/provision.rs:29
CERT_DOMAIN, TOKEN_DOMAIN = b'iot-device-cert/1', b'iot-technician-token/2'  # device/src/authority.rs:13-14
FIRMWARE_BUILT = 1_792_454_400  # device/bin/main.rs:47: token expiry is never checked against an earlier clock
IDLE_S = 60  # device/bin/main.rs:42
MAX_MESSAGE = 511  # device/src/provision.rs:34
MAX_RECORDS = 64  # device/src/provision.rs:604
GAP_NAME = 'noe-lab'  # what BlueZ serves as 0x2A00 on noe-lab (Adapter1.Alias)

# Calibration knobs (the hardware decides): see the spec's open questions.
INTERVAL_MS = 40  # the real sensor uses 1280 ms; a rotating identity needs several events per dwell
DWELL_S = 0.5  # longest time a set shows one identity
SPARE_SETS = 6  # enabled sets given back, so the controller has memory for the app's 6 links (BATCH_CONCURRENCY)
CYCLE_S = 3.0  # every identity back on air within this, well under the app's 10 s connect timeout (setup.ts:83)
MAX_SETS = 20
JOIN_S = 5.5  # measured on noe-lab: 5-6 s from pending to connected
NOT_IN_RANGE_S = 10.0  # never measured on hardware
WRONG_PSK_S = 15.0  # never measured on hardware
TIMEOUT_S = 45.0  # device/bin/wifi.rs:36
SLOW_S = 40.0
WRONG_PASSWORD = b'wrong-password'  # typed in the app, every sensor fails WrongPsk (the batch stops, batch.ts:11)
# Directory number -> behaviour; anything else is 'ok'. Customer OTHER comes from the certificate itself.
PLAN = {range(171, 176): 'slow', range(176, 181): 'not_in_range', range(181, 184): 'busy',
        range(184, 186): 'timeout', range(186, 191): 'online', range(191, 194): 'offline', range(197, 200): 'clone'}

PENDING, UNKNOWN = b'\x00', b'\x03'
FAILURES = ['WrongPsk', 'NotInRange', 'Timeout', 'NmcliError', 'AlreadyProvisioned', 'Busy', 'Conflict']


def log(*parts):
    print(time.strftime('%H:%M:%S'), *parts, flush=True)


def failed(code):
    return bytes([2, code])


# --- Noise_XX_25519_ChaChaPoly_SHA256, responder (snow in device/src/provision.rs:470-485; noise.ts is the initiator) ---
def _hmac(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf(ck, ikm):
    temp = _hmac(ck, ikm)
    first = _hmac(temp, b'\x01')
    return first, _hmac(temp, first + b'\x02')


def x25519_public(private):
    return X25519PrivateKey.from_private_bytes(private).public_key().public_bytes_raw()


def dh(private, public):
    return X25519PrivateKey.from_private_bytes(private).exchange(X25519PublicKey.from_public_bytes(public))


class Cipher:
    """Nonce: 4 zero bytes, then a 64-bit little-endian counter (configurator/src/noise.ts:36-40)."""

    def __init__(self, key=None):
        self.aead, self.n = (ChaCha20Poly1305(key) if key else None), 0

    def seal(self, ad, plain):
        if not self.aead:
            return plain
        out = self.aead.encrypt(struct.pack('<4xQ', self.n), plain, ad)
        self.n += 1
        return out

    def open(self, ad, data):  # raises InvalidTag on a wrong key, tampering, replay or reordering
        if not self.aead:
            return data
        out = self.aead.decrypt(struct.pack('<4xQ', self.n), data, ad)
        self.n += 1
        return out


class Responder:
    def __init__(self, static_private, ephemeral_private=None):
        self.s, self.e = static_private, ephemeral_private or os.urandom(32)
        self.h = self.ck = NOISE_NAME
        self.c = Cipher()
        self.mix_hash(PROLOGUE)

    def mix_hash(self, data):
        self.h = hashlib.sha256(self.h + data).digest()

    def mix_key(self, ikm):
        self.ck, key = hkdf(self.ck, ikm)
        self.c = Cipher(key)

    def encrypt_and_hash(self, plain):
        out = self.c.seal(self.h, plain)
        self.mix_hash(out)
        return out

    def decrypt_and_hash(self, data):
        out = self.c.open(self.h, data)
        self.mix_hash(data)
        return out

    def read_first(self, message):  # -> e ; returns the payload (must be empty)
        if len(message) < 32:
            raise ValueError('handshake or decryption failed')
        self.re = message[:32]
        self.mix_hash(self.re)
        return self.decrypt_and_hash(message[32:])

    def write_second(self, payload):  # <- e, ee, s, es
        e = x25519_public(self.e)
        self.mix_hash(e)
        self.mix_key(dh(self.e, self.re))
        s = self.encrypt_and_hash(x25519_public(self.s))
        self.mix_key(dh(self.s, self.re))
        return e + s + self.encrypt_and_hash(payload)

    def read_third(self, message):  # -> s, se ; returns the payload, sets the phone's static key
        self.rs = self.decrypt_and_hash(message[:48])
        self.mix_key(dh(self.e, self.rs))
        return self.decrypt_and_hash(message[48:])

    def split(self):  # the phone sends with k1: the device receives with k1, sends with k2
        k1, k2 = hkdf(self.ck, b'')
        return Cipher(k1), Cipher(k2)


# --- Certificates and technician tokens (device/src/authority.rs) ---
CUSTOMER = re.compile(rb'[A-Za-z0-9_-]{1,32}')


def device_id(public_key):
    return 'IOT-' + hashlib.sha256(public_key).digest()[:5].hex().upper()


def field(data, at):
    if at >= len(data) or at + 1 + data[at] > len(data):
        raise ValueError('malformed')
    return data[at + 1:at + 1 + data[at]], at + 1 + data[at]


def split_signed(data, version):
    body, signature = data[:-64], data[-64:]
    if len(data) < 64 or body[:1] != bytes([version]):
        raise ValueError('malformed')
    return body, signature


def parse_certificate(data):  # -> (device public key, customer)
    body, _ = split_signed(data, 1)
    if len(body) < 34:
        raise ValueError('malformed')
    customer, end = field(body, 33)
    if end != len(body) or not CUSTOMER.fullmatch(customer):
        raise ValueError('malformed')
    return body[1:33], customer.decode()


class Refused(Exception):
    def __init__(self, reason, text):
        super().__init__(text)
        self.reason = reason


def check_token(data, technician_authority, customer, now, holder_proven):
    """Returns the technician's name, or raises Refused(reason): device/src/provision.rs:538-545, authority.rs:306-325."""
    try:
        body, signature = split_signed(data, 2)
        if len(body) < 41:
            raise ValueError
        expires, holder = int.from_bytes(body[1:9], 'big'), body[9:41]
        name, at = field(body, 41)
        count, at = body[at], at + 1
        customers = []
        for _ in range(count):
            c, at = field(body, at)
            customers.append(c)
        name.decode()
        if at != len(body) or not 1 <= len(name) <= 64 or not 1 <= count <= 8 or \
                not all(CUSTOMER.fullmatch(c) for c in customers):
            raise ValueError
    except (ValueError, IndexError, UnicodeDecodeError):
        raise Refused(1, 'malformed') from None
    try:  # ponytail: OpenSSL's Ed25519, not dalek's verify_strict; they differ only on crafted signatures
        Ed25519PublicKey.from_public_bytes(technician_authority).verify(signature, TOKEN_DOMAIN + body)
    except Exception:
        raise Refused(1, 'signature does not verify') from None
    if customer.encode() not in customers:
        raise Refused(2, 'not valid for this customer')
    if now >= expires:
        raise Refused(3, 'expired')
    if holder_proven != holder:
        raise Refused(1, 'presented without its holder key')
    return name.decode()


def decode_request(plain):  # device/src/provision.rs:102-129 -> ('status'|'provision', attempt, ssid, password)
    if len(plain) >= 17:
        tag, attempt, rest = plain[0], plain[1:17], plain[17:]
        if tag == 2 and not rest:
            return 'status', attempt, None, None
        if tag == 1:
            try:
                ssid, at = field(rest, 0)
                password, at = field(rest, at)
            except ValueError:
                raise ValueError('malformed message') from None
            if at == len(rest) and 1 <= len(ssid) <= 32 and 8 <= len(password) <= 63:
                return 'provision', attempt, ssid, password
    raise ValueError('malformed message')


# --- One simulated sensor ---
class Peer:
    def __init__(self, session, now):
        self.session, self.last, self.reply, self.proven = session, now, None, False


class Session:
    """Noise state for one phone; any error closes it for good (device/src/provision.rs:457-583)."""

    def __init__(self, sensor, now):
        self.sensor, self.now, self.phase = sensor, now, 'start'
        self.noise = Responder(sensor.static_private)
        self.technician = self.refused = None

    def on_write(self, message):
        if len(message) > MAX_MESSAGE:
            raise ValueError('message too large')
        phase, self.phase = self.phase, 'closed'
        if phase == 'start':
            if self.noise.read_first(message):
                raise ValueError('malformed message')  # nothing may ride on the first message
            reply = self.noise.write_second(self.sensor.certificate)
            self.phase = 'token'
            return reply
        if phase == 'token':
            token = self.noise.read_third(message)
            self.receive, self.send = self.noise.split()
            try:
                self.technician = check_token(token, self.sensor.technician_authority, self.sensor.customer,
                                              self.now, self.noise.rs)
            except Refused as refused:
                self.refused = refused  # the phone reads why, then the session stays closed
                return self.send.seal(b'', bytes([1, refused.reason]))
            self.phase = 'transport'
            return self.send.seal(b'', b'\x00')
        if phase == 'transport':
            kind, attempt, ssid, password = decode_request(self.receive.open(b'', message))
            reply = self.send.seal(b'', attempt + self.sensor.handle(kind, attempt, ssid, password))
            self.phase = 'transport'
            return reply
        raise ValueError('session closed')


class Sensor:
    def __init__(self, directory, profile):
        identity = (directory / 'identity').read_bytes()
        self.certificate = (directory / 'certificate').read_bytes()
        self.technician_authority = (directory / 'technician-authority').read_bytes()
        public, self.customer = parse_certificate(self.certificate)
        assert len(identity) in (64, 96) and identity[32:64] == public, f'{directory}: key and certificate disagree'
        self.profile, self.name = profile, device_id(public)
        # 'clone': the certificate and ID of a genuine sensor, without its key (the app must say not-genuine).
        self.static_private = os.urandom(32) if profile == 'clone' else identity[:32]
        digest = hashlib.sha256(b'iot-sim address' + public).digest()
        self.address = hci.Address(digest[:5] + bytes([digest[5] | 0xC0]))  # LSB first; 0b11 = static random
        n = int(directory.name)
        self.ipv4 = bytes([10, 77, n >> 8, n & 0xFF])
        self.provisioned = profile in ('online', 'offline')
        self.online = profile == 'online'
        self.hello = None  # the phone that wrote hello last: one slot per sensor (device/bin/main.rs:38-39)
        self.peers = {}  # phone address -> Peer (device/bin/main.rs:91-95)
        self.records = {}  # attempt -> [payload hash, outcome] (device/src/provision.rs:606-612)
        self.links = 0
        self.busy_done = False

    def state(self):  # device/bin/main.rs:327-334
        return 2 if self.online else 3 if self.provisioned else 1

    def advertising_data(self):  # BlueZ 5.64 order: service UUIDs, manufacturer data, then flags
        return (b'\x11\x07' + bytes.fromhex(SERVICE_UUID.replace('-', ''))[::-1]
                + bytes([9, 0xFF, 0xFF, 0xFF, self.state()]) + bytes.fromhex(self.name[6:]) + b'\x02\x01\x02')

    def scan_response_data(self):
        return bytes([len(self.name) + 1, 0x09]) + self.name.encode()

    # Hello characteristic (device/bin/main.rs:56-80)
    def hello_write(self, phone, value):
        self.hello = None
        if value != b'hello':
            log(self.name, 'rejected request')
            raise att.ATT_Error(att.ErrorCode.REQUEST_NOT_SUPPORTED)
        self.hello = phone

    def hello_read(self, phone):
        if self.hello != phone:
            return b''
        self.hello = None
        log(self.name, 'hello exchanged')
        return b'world'

    # Provisioning characteristic (device/bin/main.rs:101-175)
    def provision_write(self, phone, value, mtu):
        now = time.monotonic()
        self.peers = {a: p for a, p in self.peers.items() if now - p.last < IDLE_S}
        if any(a != phone and p.proven for a, p in self.peers.items()):
            raise att.ATT_Error(att.ErrorCode.PROCEDURE_ALREADY_IN_PROGRESS)  # InProgress, 0xFE
        if not value:
            raise att.ATT_Error(att.ErrorCode.INVALID_ATTRIBUTE_LENGTH)  # InvalidValueLength, 0x0D
        if value[0] == 0:
            self.peers[phone] = Peer(Session(self, max(int(time.time()), FIRMWARE_BUILT)), now)
        elif value[0] != 1:
            raise att.ATT_Error(att.ErrorCode.REQUEST_NOT_SUPPORTED)  # NotSupported, 0x06
        peer = self.peers.get(phone)
        if peer is None:
            raise att.ATT_Error(att.ErrorCode.WRITE_NOT_PERMITTED)  # NotPermitted on a write, 0x03
        peer.last, peer.reply = now, None
        try:
            peer.reply = peer.session.on_write(value[1:])
        except Exception as error:  # ValueError carries the device's wording; InvalidTag and DH errors do not
            del self.peers[phone]
            text = str(error) if type(error) is ValueError else 'handshake or decryption failed'
            log(self.name, f'provisioning session closed: {text}')
            raise att.ATT_Error(att.ErrorCode.INSUFFICIENT_AUTHORIZATION) from None  # NotAuthorized, 0x08
        if value[0] == 0:
            log(self.name, f'provisioning session started (mtu {mtu})')
        if peer.session.refused:
            log(self.name, f'technician code refused: {peer.session.refused}')
        if not peer.proven and peer.session.technician:
            log(self.name, f'technician {peer.session.technician!r} accepted')
            peer.proven = True
            self.peers = {phone: peer}

    def provision_read(self, phone):
        peer = self.peers.get(phone)
        reply, peer.reply = (peer.reply, None) if peer else (None, None)
        return reply or b''

    # Attempt registry (device/src/provision.rs:620-673) and the simulated NetworkManager join (device/bin/main.rs:277-312)
    def handle(self, kind, attempt, ssid, password):
        if kind == 'status':
            return self.records.get(attempt, [None, UNKNOWN])[1]
        if self.profile == 'busy' and not self.busy_done:  # another phone's attempt is in flight right now
            self.busy_done = True
            self.start(os.urandom(16), None, TIMEOUT_S, failed(3))
        payload_hash = hashlib.sha256(bytes([len(ssid)]) + ssid + password).digest()
        if attempt in self.records:
            record = self.records[attempt]
            return record[1] if record[0] == payload_hash else failed(7)  # Conflict
        if any(r[1] == PENDING for r in self.records.values()):
            return failed(6)  # Busy
        if len(self.records) >= MAX_RECORDS:
            self.records.clear()
        try:
            password.decode()
            delay, outcome = {'slow': (SLOW_S, b'\x01' + self.ipv4), 'not_in_range': (NOT_IN_RANGE_S, failed(2)),
                              'timeout': (TIMEOUT_S, failed(3))}.get(self.profile, (JOIN_S, b'\x01' + self.ipv4))
            if password == WRONG_PASSWORD:
                delay, outcome = WRONG_PSK_S, failed(1)
        except UnicodeDecodeError:
            delay, outcome = 0, failed(1)  # device/bin/wifi.rs:61-63
        self.start(attempt, payload_hash, delay, outcome)
        return PENDING

    def start(self, attempt, payload_hash, delay, outcome):
        self.records[attempt] = [payload_hash, PENDING]
        log(self.name, f'attempt {attempt.hex()} pending')
        asyncio.get_running_loop().call_later(delay, self.complete, attempt, outcome)

    def complete(self, attempt, outcome):
        if attempt in self.records:
            self.records[attempt][1] = outcome
        log(self.name, f'attempt {attempt.hex()}', 'connected' if outcome[0] == 1 else f'failed {FAILURES[outcome[1] - 1]}')
        if outcome[0] == 1:
            self.provisioned = self.online = True  # advertised from the identity's next dwell on


# --- Bluetooth: one GATT database, ~20 advertising sets, the identity from the set that took the connection ---
class SensorServer(Server):
    def on_att_read_blob_request(self, bearer, request):
        if request.value_offset:  # device/bin/main.rs:68-71, 166-169: InvalidOffset, and the reply is not consumed
            raise att.ATT_Error(att.ErrorCode.INVALID_OFFSET, request.attribute_handle)
        return super().on_att_read_blob_request(bearer, request)


class RefusePairing(PairingDelegate):
    async def accept(self):  # a non-bondable BlueZ adapter: SMP Pairing Failed, Pairing Not Supported (0x05)
        return False


async def rotate(advertising_set, sensors, dwell):
    for sensor in itertools.cycle(sensors):
        if sensor.links:  # a real sensor stops advertising while a phone is connected
            await asyncio.sleep(0.01)
            continue
        if advertising_set.enabled:
            await advertising_set.stop()  # the address of a connectable set changes only while it is disabled
        await advertising_set.set_random_address(sensor.address)
        advertising_set.random_address = sensor.address  # Bumble reads it when a connection arrives
        await advertising_set.set_advertising_data(sensor.advertising_data())
        await advertising_set.set_scan_response_data(sensor.scan_response_data())
        try:
            await advertising_set.start()
        except hci.HCI_Error as error:  # the controller may have less room once phones are connected
            log(f'set {advertising_set.advertising_handle} paused: {error}')
            await asyncio.sleep(1)
            continue
        await asyncio.sleep(dwell)


def load(root):
    sensors = []
    for directory in sorted(p for p in root.iterdir() if (p / 'certificate').is_file()):
        n = int(directory.name)
        sensors.append(Sensor(directory, next((v for k, v in PLAN.items() if n in k), 'ok')))
    assert len({bytes(s.address) for s in sensors}) == len(sensors), 'address collision'
    return sensors


async def serve(sensors, source, sink, max_sets=MAX_SETS):
    by_address = {bytes(s.address): s for s in sensors}

    def sensor_of(connection):
        sensor = by_address.get(bytes(connection.self_address))
        if sensor is None:  # not yet bound to its advertising set
            raise att.ATT_Error(att.ErrorCode.UNLIKELY_ERROR)
        return sensor

    def phone(connection):
        return bytes(connection.peer_address)

    def characteristic(uuid, read, write):
        return Characteristic(uuid, Characteristic.Properties.READ | Characteristic.Properties.WRITE,
                              Characteristic.READABLE | Characteristic.WRITEABLE,
                              CharacteristicValue(read=read, write=write))

    device = Device.from_config_with_hci(DeviceConfiguration(name=GAP_NAME), source, sink)
    device.gatt_server = SensorServer(device)  # before any connection: each Connection copies it
    device.add_default_services()
    device.add_service(Service(SERVICE_UUID, [
        characteristic(HELLO_UUID, lambda c: sensor_of(c).hello_read(phone(c)),
                       lambda c, v: sensor_of(c).hello_write(phone(c), v)),
        characteristic(PROVISION_UUID, lambda c: sensor_of(c).provision_read(phone(c)),
                       lambda c, v: sensor_of(c).provision_write(phone(c), v, c.att_mtu)),
    ]))
    device.pairing_config_factory = lambda connection: PairingConfig(delegate=RefusePairing())

    def on_connection(connection):
        sensor = by_address.get(bytes(connection.self_address))
        if sensor is None:
            log('connection on an unknown address', connection.self_address)
            return
        sensor.links += 1
        connection.on(connection.EVENT_DISCONNECTION, lambda reason: setattr(sensor, 'links', sensor.links - 1))

    device.on(Device.EVENT_CONNECTION, on_connection)
    await device.power_on()
    phys = [hci.Phy.LE_1M, hci.Phy.LE_2M, hci.Phy.LE_CODED]
    await device.set_default_phy(phys, phys)  # what Linux sends at power-on
    n = min(max_sets, device.host.number_of_supported_advertising_sets, len(sensors))
    if not n:
        raise SystemExit('the controller reports no extended advertising sets')
    log(f'{len(sensors)} sensors on {n} of {device.host.number_of_supported_advertising_sets} advertising sets')
    parameters = AdvertisingParameters(
        advertising_event_properties=AdvertisingEventProperties(is_connectable=True, is_scannable=True,
                                                                is_legacy=True),  # 0x0013, ADV_IND
        primary_advertising_interval_min=INTERVAL_MS, primary_advertising_interval_max=INTERVAL_MS,
        own_address_type=hci.OwnAddressType.RANDOM)
    # The MT7921 reports 20 sets but cannot enable them all at once (Memory Capacity Exceeded): keep what it accepts.
    sets = []
    for i in range(n):
        advertising_set = await device.create_advertising_set(
            advertising_parameters=parameters, random_address=sensors[i].address, auto_start=False)
        await advertising_set.set_advertising_data(sensors[i].advertising_data())
        await advertising_set.set_scan_response_data(sensors[i].scan_response_data())
        try:
            await advertising_set.start()
        except hci.HCI_Error as error:
            log(f'the controller enables {len(sets)} sets at once ({error})')
            break  # left created and disabled: the MT7921 refuses to remove it (Command Disallowed)
        sets.append(advertising_set)
    keep = max(1, len(sets) - SPARE_SETS)
    for spare in sets[keep:]:
        await spare.stop()  # room for the phone's links
    sets = sets[:keep]
    n = len(sets)
    if not n:
        raise SystemExit('the controller enables no advertising set')
    dwell = min(DWELL_S, CYCLE_S / -(-len(sensors) // n))
    log(f'{len(sensors)} sensors on {n} sets: {dwell:.2f} s each, every sensor on air every {dwell * -(-len(sensors) // n):.1f} s')
    await asyncio.gather(*(rotate(s, sensors[i::n], dwell) for i, s in enumerate(sets)))


async def main(root):
    from bumble.transport import open_transport
    sensors = load(Path(root).expanduser())
    async with await open_transport('hci-socket:0') as transport:
        await serve(sensors, transport.source, transport.sink)


def selftest(vectors_path):
    """Replays configurator/src/noise-vectors.json on the device side, byte for byte."""
    import json
    v = json.loads(Path(vectors_path).read_text())
    key = lambda fill: bytes((fill + i) & 0xFF for i in range(32))  # device/tests/noise_vectors.rs:24-26
    sensor = Sensor.__new__(Sensor)
    sensor.name, sensor.profile, sensor.customer = v['deviceId'], 'ok', v['customer']
    sensor.certificate, sensor.technician_authority = bytes.fromhex(v['certificate']), bytes.fromhex(v['technicianAuthority'])
    sensor.static_private, sensor.records, sensor.busy_done = key(0x10), {}, False
    sensor.ipv4 = bytes([192, 168, 1, 40])
    sensor.online, sensor.provisioned = False, False
    advertisement = sensor.advertising_data()
    assert len(advertisement) == 31
    assert advertisement[22] == 1
    assert advertisement[23:28] == bytes.fromhex(v['deviceId'][6:])
    assert x25519_public(sensor.static_private).hex() == v['devicePublic']
    assert device_id(bytes.fromhex(v['devicePublic'])) == v['deviceId']
    assert parse_certificate(sensor.certificate) == (bytes.fromhex(v['devicePublic']), v['customer'])
    m = [bytes.fromhex(x['message']) for x in v['messages']]

    def session(now):
        s = Session(sensor, now)
        s.noise.e = key(0x70)
        assert s.on_write(m[0]) == m[1]
        return s

    async def run():
        s = session(FIRMWARE_BUILT)
        assert s.on_write(m[2]) == m[3] and s.technician == 'Noé'
        assert s.on_write(m[4]) == m[5]  # Provision: pending
        sensor.complete(bytes([0xa5] * 16), b'\x01' + sensor.ipv4)
        assert s.on_write(m[6]) == m[7]  # Status: connected 192.168.1.40
        assert session(4_102_444_800).on_write(m[2]) == bytes.fromhex(v['refusedExpired'])

    asyncio.run(run())
    print('noise vectors: device messages reproduced byte for byte')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--selftest']:
        selftest(sys.argv[2])
    else:
        asyncio.run(main(sys.argv[1]))
