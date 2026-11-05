#!/usr/bin/env python3
"""
sky2.py - Connect to a BloomSky SKY2 weather station over Bluetooth LE and
(eventually) change its Wi-Fi network.

This is a native alternative to the browser tool at /bloomsky2/, for when Web
Bluetooth in Chrome/Edge keeps failing at the connection step on Windows 10.
It talks to the exact same BLE services and characteristics as the web page,
using the operating system's own Bluetooth stack instead of the browser's.

------------------------------------------------------------------------------
REQUIREMENTS (Windows 10)
------------------------------------------------------------------------------
  * Windows 10, version 1709 (build 16299) or newer, with a Bluetooth LE radio.
  * Python 3.8 or newer.  Get it from https://www.python.org/downloads/ and
    tick "Add python.exe to PATH" in the installer.
  * The 'bleak' library.  Open Command Prompt or PowerShell and run:
        pip install bleak
    (If 'pip' isn't found, try:  py -m pip install bleak )

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
Put the SKY2 in config mode first (power on, Wi-Fi icon blinking alternate
colors), then run one of:

  py sky2.py scan
        List nearby Bluetooth LE devices so you can confirm the SKY2 ("BSKY")
        is advertising and see its address.

  py sky2.py connect
        Connect to the SKY2, list its services, and read the device ID and
        status.  This is the test to run first - it changes nothing.

  py sky2.py status
        Connect and print the status once (same read the web page polls).

  py sky2.py setwifi --ssid "YourNetwork" --password "YourPassword"
        Connect and run the full Wi-Fi change sequence, then watch the status.

  py sky2.py reboot
        Connect and send the reboot command.

Add  --address AA:BB:CC:DD:EE:FF  to any command to skip scanning and connect
to a specific device (use the address 'scan' printed).  Add  -v  for a verbose
log of every Bluetooth step.

Your Wi-Fi SSID and password are NEVER written to the log, only sent to the
device - the same rule the web tool follows.
"""

import argparse
import asyncio
import sys

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit(
        "The 'bleak' library isn't installed.\n"
        "Install it with:  pip install bleak\n"
        "(or:  py -m pip install bleak )"
    )

# ---------------------------------------------------------------------------
# Protocol - must match bloomsky2/script.js exactly.
# ---------------------------------------------------------------------------
# Printed at startup so you can confirm which copy of this file is running.
# Bump this whenever the file changes.
SCRIPT_VERSION = "2026-11-05.2"

DEVICE_NAME = "BSKY"

SVC_1802 = "00001802-0000-1000-8000-00805f9b34fb"
SVC_1803 = "00001803-0000-1000-8000-00805f9b34fb"
SVC_1804 = "00001804-0000-1000-8000-00805f9b34fb"

# In 1802: read = device ID, write = password.
CHAR_DEVICE_ID_OR_PASS = "00003a02-0000-1000-8000-00805f9b34fb"
# In 1803: read = status, write = SSID.
CHAR_STATUS_OR_SSID = "00003a01-0000-1000-8000-00805f9b34fb"
# In 1804: selects what the next write means.
CHAR_COMMAND = "00003a03-0000-1000-8000-00805f9b34fb"

STATUS_TEXT = {
    1: "Wait",
    3: "Good: connected to Wi-Fi",
    4: "Not good: could not write the SSID/password",
    5: "Not good: could not connect to Wi-Fi",
}

CONNECT_TIMEOUT = 20.0      # seconds per plain connection attempt
PAIR_TIMEOUT = 45.0         # longer, since pairing may prompt the user
SCAN_TIMEOUT = 12.0         # seconds
STATUS_POLL_SECONDS = 2.0
STATUS_WATCH_SECONDS = 40.0


def log(msg):
    print(msg, flush=True)


def vlog(args, msg):
    if args.verbose:
        print("  . " + msg, flush=True)


def describe_status(code):
    if code is None:
        return "No value"
    return f"{code}: {STATUS_TEXT.get(code, 'Unknown')}"


# ---------------------------------------------------------------------------
# Finding the device
# ---------------------------------------------------------------------------
async def find_device(args):
    """Return a BLEDevice for the SKY2, or None."""
    if args.address:
        log(f"Looking for a device at {args.address} ...")
        dev = await BleakScanner.find_device_by_address(args.address, timeout=SCAN_TIMEOUT)
        if dev is None:
            log(f"No device answered at {args.address} within {SCAN_TIMEOUT:.0f}s.")
        return dev

    log(f'Scanning for "{DEVICE_NAME}" (up to {SCAN_TIMEOUT:.0f}s) ...')
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: (d.name or ad.local_name or "") == DEVICE_NAME,
        timeout=SCAN_TIMEOUT,
    )
    if dev is None:
        log(
            f'Could not find "{DEVICE_NAME}". Make sure the SKY2 is on and its '
            "Wi-Fi icon is blinking alternate colors, that nothing else is "
            "connected to it, and that you are close to it.\n"
            "Run  py sky2.py scan  to see what is advertising."
        )
    return dev


async def cmd_scan(args):
    log(f"Scanning for Bluetooth LE devices (up to {SCAN_TIMEOUT:.0f}s) ...\n")
    devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT, return_adv=True)
    if not devices:
        log("No Bluetooth LE devices found. Is Bluetooth turned on?")
        return 1
    found_sky2 = False
    for address, (dev, adv) in sorted(
        devices.items(), key=lambda kv: (kv[1][1].rssi or -999), reverse=True
    ):
        name = dev.name or adv.local_name or "(no name)"
        is_sky2 = name == DEVICE_NAME
        found_sky2 = found_sky2 or is_sky2
        marker = "   <-- this is your SKY2" if is_sky2 else ""
        rssi = adv.rssi if adv.rssi is not None else "?"
        log(f"  {address}   rssi {rssi:>4}   {name}{marker}")
        # For the SKY2 (or everything under -v), show what it advertises. Which
        # services it lists here, and its manufacturer data, help us understand
        # why Windows later refuses discovery.
        if is_sky2 or args.verbose:
            uuids = adv.service_uuids or []
            short = ", ".join(u[4:8] if len(u) >= 8 else u for u in uuids) or "(none)"
            log(f"        advertised services: {short}")
            if adv.manufacturer_data:
                ids = ", ".join(f"0x{k:04x}" for k in adv.manufacturer_data)
                log(f"        manufacturer data from: {ids}")
            if adv.service_data:
                log(f"        service data for: {', '.join(adv.service_data)}")
    log("")
    if found_sky2:
        log(f'Found "{DEVICE_NAME}". Next run:  py sky2.py connect')
    else:
        log(
            f'Did not see "{DEVICE_NAME}". Put the SKY2 in config mode (Wi-Fi '
            "icon blinking alternate colors) and scan again."
        )
    return 0


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------
OUR_SERVICES = [SVC_1802, SVC_1803, SVC_1804]

# (label, kwargs, timeout). Each is a different way to get Windows to enumerate
# the SKY2's GATT services. A consistent app-specific error (0x80) on every
# non-pairing attempt points to the firmware refusing service discovery until
# the connection is paired/bonded - the documented reason bleak offers pair=True
# ("necessary to pair the device first in order to be able to even enumerate the
# services"). So the first attempts try plain discovery (fast, no Windows bond),
# and the last two pair first. 'winrt' options apply only on Windows; 'pair' and
# 'services' apply everywhere.
CONNECT_STRATEGIES = [
    ("fresh discovery, SKY2 services only",
        dict(services=OUR_SERVICES, winrt={"use_cached_services": False}), CONNECT_TIMEOUT),
    ("cached discovery, SKY2 services only",
        dict(services=OUR_SERVICES, winrt={"use_cached_services": True}), CONNECT_TIMEOUT),
    ("fresh discovery, all services",
        dict(winrt={"use_cached_services": False}), CONNECT_TIMEOUT),
    ("pair, then fresh discovery, SKY2 services only",
        dict(services=OUR_SERVICES, pair=True, winrt={"use_cached_services": False}), PAIR_TIMEOUT),
    ("pair, then fresh discovery, all services",
        dict(pair=True, winrt={"use_cached_services": False}), PAIR_TIMEOUT),
]


def make_client(device, kwargs, timeout):
    """Build a BleakClient, dropping kwargs that an older bleak doesn't accept."""
    for drop in ([], ["winrt"], ["winrt", "pair"]):
        trimmed = {k: v for k, v in kwargs.items() if k not in drop}
        try:
            return BleakClient(device, timeout=timeout, **trimmed)
        except TypeError:
            continue
    return BleakClient(device, timeout=timeout)


async def connect(args, device):
    """Connect to the device, trying several discovery strategies in turn."""
    last_error = None
    total = len(CONNECT_STRATEGIES)
    for index, (label, kwargs, timeout) in enumerate(CONNECT_STRATEGIES, start=1):
        log(f"Connecting (attempt {index} of {total}: {label}) ...")
        if "pair" in kwargs:
            log("  (If Windows shows a prompt or notification to pair/set up BSKY, allow it.)")
        client = make_client(device, kwargs, timeout)
        try:
            await client.connect()
            if client.is_connected:
                log("Connected.")
                return client
            last_error = "connect() returned but the device is not connected"
        except asyncio.TimeoutError:
            last_error = f"timed out after {CONNECT_TIMEOUT:.0f}s"
        except Exception as e:  # noqa: BLE001 - report anything the OS throws
            last_error = f"{type(e).__name__}: {e}"
        vlog(args, f"attempt {index} failed: {last_error}")
        try:
            await client.disconnect()
        except Exception:
            pass
        if index < total:
            await asyncio.sleep(1.5)
    raise RuntimeError(
        f"Could not connect after {total} attempts (including pairing). "
        f"Last error: {last_error}\n\n"
        "A consistent app-specific error such as 0x80 means the SKY2 is refusing "
        "service discovery. Things to try, then run the command again:\n"
        "  1. Clear any stale pairing: Settings -> Devices -> Bluetooth & other\n"
        "     devices; if 'BSKY' or an unknown device is listed, Remove it; then\n"
        "     turn Bluetooth off and back on.\n"
        "  2. Make sure the SKY2 is fully in config mode: the Wi-Fi icon must be\n"
        "     blinking ALTERNATE colors, not solid or a single color.\n"
        "  3. Make sure no phone or other computer is connected to it, and stay\n"
        "     within a few feet.\n\n"
        "If it still fails, install the free 'nRF Connect for Mobile' app on an\n"
        "Android phone, Scan, Connect to BSKY, and note whether it connects and\n"
        "what it shows - that tells us exactly what the SKY2 requires."
    )


def list_services(args, client):
    vlog(args, "Services found on the device:")
    for service in client.services:
        short = service.uuid[4:8]
        vlog(args, f"  service {short}  ({service.uuid})")
        for ch in service.characteristics:
            props = ",".join(ch.properties)
            vlog(args, f"    char {ch.uuid[4:8]}  [{props}]")


def get_char(client, uuid):
    ch = client.services.get_characteristic(uuid)
    if ch is None:
        raise RuntimeError(
            f"Characteristic {uuid[4:8]} not found on the device. "
            "This may not be a SKY2, or it isn't in config mode."
        )
    return ch


async def write_char(args, client, uuid, data, label):
    """Write, choosing with/without response the way the characteristic allows."""
    ch = get_char(client, uuid)
    response = "write" in ch.properties  # prefer acknowledged writes, like the browser
    vlog(args, f"{label}: writing {len(data)} byte(s) to {uuid[4:8]} (response={response})")
    await client.write_gatt_char(ch, data, response=response)


async def read_device_id(args, client):
    try:
        raw = await client.read_gatt_char(get_char(client, CHAR_DEVICE_ID_OR_PASS))
        vlog(args, f"Device ID: {len(raw)} byte(s)")
        return raw.decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        vlog(args, f"Read device ID failed: {type(e).__name__}: {e}")
        return None


async def read_status(args, client):
    try:
        raw = await client.read_gatt_char(get_char(client, CHAR_STATUS_OR_SSID))
        code = raw[0] if len(raw) else None
        vlog(args, f"Status raw: {list(raw)} -> {describe_status(code)}")
        return code
    except Exception as e:  # noqa: BLE001
        vlog(args, f"Read status failed: {type(e).__name__}: {e}")
        return None


# ---------------------------------------------------------------------------
# Commands that connect
# ---------------------------------------------------------------------------
async def cmd_connect(args):
    device = await find_device(args)
    if device is None:
        return 1
    client = await connect(args, device)
    try:
        list_services(args, client)
        device_id = await read_device_id(args, client)
        log(f"Device ID: {device_id if device_id is not None else '(could not read)'}")
        status = await read_status(args, client)
        log(f"Status:    {describe_status(status) if status is not None else '(could not read)'}")
        log("\nConnection works. When you're ready to change Wi-Fi:")
        log('  py sky2.py setwifi --ssid "YourNetwork" --password "YourPassword"')
    finally:
        await client.disconnect()
        log("Disconnected.")
    return 0


async def cmd_status(args):
    device = await find_device(args)
    if device is None:
        return 1
    client = await connect(args, device)
    try:
        status = await read_status(args, client)
        log(f"Status: {describe_status(status) if status is not None else '(could not read)'}")
    finally:
        await client.disconnect()
    return 0


async def watch_status(args, client, seconds):
    log(f"Watching status for up to {seconds:.0f}s ...")
    waited = 0.0
    final = None
    while waited < seconds:
        code = await read_status(args, client)
        log(f"  [{waited:4.0f}s] {describe_status(code)}")
        final = code
        if code in (3, 4, 5):  # terminal: good, write failed, or couldn't connect
            break
        await asyncio.sleep(STATUS_POLL_SECONDS)
        waited += STATUS_POLL_SECONDS
    return final


async def cmd_setwifi(args):
    device = await find_device(args)
    if device is None:
        return 1
    client = await connect(args, device)
    try:
        list_services(args, client)
        device_id = await read_device_id(args, client)
        log(f"Device ID: {device_id if device_id is not None else '(could not read)'}")

        ssid_bytes = args.ssid.encode("utf-8")
        pass_bytes = args.password.encode("utf-8")

        # This order is the SKY2's setup protocol. Each command byte tells the
        # device how to interpret the next write. SSID/password are never logged.
        steps = [
            ("1/7 Starting setup",                 CHAR_COMMAND,            bytes([1])),
            ("2/7 Preparing to receive the SSID",   CHAR_COMMAND,            bytes([3])),
            ("3/7 Sending the SSID",                CHAR_STATUS_OR_SSID,     ssid_bytes),
            ("4/7 Preparing to receive password",   CHAR_COMMAND,            bytes([2])),
            ("5/7 Sending the password",            CHAR_DEVICE_ID_OR_PASS,  pass_bytes),
            ("6/7 Saving the Wi-Fi settings",       CHAR_COMMAND,            bytes([4])),
            ("7/7 Starting the connection test",    CHAR_COMMAND,            bytes([5])),
        ]
        log("\nSending Wi-Fi settings ...")
        for label, uuid, data in steps:
            log(f"  {label}")
            await write_char(args, client, uuid, data, label)
        log("All settings sent.\n")

        final = await watch_status(args, client, STATUS_WATCH_SECONDS)
        log("")
        if final == 3:
            log("SUCCESS: the SKY2 connected to the new Wi-Fi network.")
        elif final == 5:
            log("The SKY2 could not connect to that network. Check the SSID and "
                "password (and that it's a 2.4 GHz network), then try again.")
        elif final == 4:
            log("The SKY2 reported it could not save the SSID/password. Try again.")
        else:
            log(f"Finished without a final 'Good' status (last: {describe_status(final)}). "
                "You can re-run setwifi, or check status again.")
    finally:
        await client.disconnect()
        log("Disconnected.")
    return 0


async def cmd_reboot(args):
    device = await find_device(args)
    if device is None:
        return 1
    client = await connect(args, device)
    try:
        log("Sending reboot command ...")
        await write_char(args, client, CHAR_COMMAND, bytes([7]), "reboot")
        log("Reboot command sent. The SKY2 should now restart.")
    except Exception as e:  # noqa: BLE001
        # The device often restarts before acknowledging, which looks like an error.
        log(f"The reboot command may have gone through despite: {type(e).__name__}: {e}")
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description="Connect to a BloomSky SKY2 over Bluetooth LE and change its Wi-Fi.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("-v", "--verbose", action="store_true", help="log every Bluetooth step")
    p.add_argument("--address", help="connect to this BLE address instead of scanning")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("scan", help="list nearby Bluetooth LE devices")
    sub.add_parser("connect", help="connect and read device ID + status (changes nothing)")
    sub.add_parser("status", help="connect and print the status once")
    sub.add_parser("reboot", help="connect and send the reboot command")

    sw = sub.add_parser("setwifi", help="connect and change the Wi-Fi network")
    sw.add_argument("--ssid", required=True, help="the Wi-Fi network name (2.4 GHz)")
    sw.add_argument("--password", required=True, help="the Wi-Fi password")

    return p


COMMANDS = {
    "scan": cmd_scan,
    "connect": cmd_connect,
    "status": cmd_status,
    "setwifi": cmd_setwifi,
    "reboot": cmd_reboot,
}


def main():
    args = build_parser().parse_args()
    log(f"sky2.py version {SCRIPT_VERSION}")
    try:
        return asyncio.run(COMMANDS[args.command](args))
    except KeyboardInterrupt:
        log("\nStopped.")
        return 130
    except RuntimeError as e:
        log(f"\nError: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
