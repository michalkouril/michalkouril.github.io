# Changing the SKY2 Wi-Fi from a Windows 10 PC

The web tool at <https://www.michalkouril.com/bloomsky2/> uses Bluetooth through
the browser (Chrome or Edge). On some Windows 10 laptops the browser cannot
finish the Bluetooth connection even though the SKY2 is found.

`sky2.py` is a fallback for those machines. It talks to the SKY2 over the same
Bluetooth connection, but through Windows' own Bluetooth stack instead of the
browser, which often works where the browser does not.

## 1. Install Python

1. Download Python from <https://www.python.org/downloads/>.
2. Run the installer. **On the first screen, tick "Add python.exe to PATH"**,
   then click *Install Now*.

## 2. Install the Bluetooth library

Open **Command Prompt** (press the Windows key, type `cmd`, press Enter) and run:

```
pip install bleak
```

If that says `pip` is not recognized, try:

```
py -m pip install bleak
```

## 3. Put the SKY2 in config mode

1. Press the power button for about 3 seconds. All three lights turn on. **The
   SKY2 must end up turned on.** If the left light then flashes by itself, it's on.
   If not, press the power button again.
2. Wait about 5 seconds and watch the Wi-Fi icon. If it's blinking alternate
   colors, skip the next step.
3. Hold the Wi-Fi button for at least 8 seconds, until the icon blinks alternate
   colors.

Keep the laptop close to the SKY2, and make sure no phone or other computer is
connected to it.

## 4. Run the tool

Download `sky2.py` (from <https://www.michalkouril.com/bloomsky2/sky2.py> or the
same folder as this file) into a folder you can find, e.g. your Downloads. In
Command Prompt, go to that folder and run the commands below.

```
cd %USERPROFILE%\Downloads
```

**First, confirm the SKY2 is visible:**

```
py sky2.py scan
```

You should see a line marked `<-- this is your SKY2`. If you don't, redo step 3
and scan again.

**Then test the connection (this changes nothing):**

```
py sky2.py connect
```

If it prints a device ID and a status, the connection works.

**Change the Wi-Fi:**

```
py sky2.py setwifi --ssid "YourNetworkName" --password "YourPassword"
```

Use the exact network name and password, with the quotes. The SKY2 only joins
**2.4 GHz** networks, not 5 GHz. The tool then watches the status and tells you
whether it connected.

## Other commands

| Command | What it does |
| --- | --- |
| `py sky2.py scan` | List nearby Bluetooth devices and find the SKY2 |
| `py sky2.py connect` | Connect and read the device ID + status (changes nothing) |
| `py sky2.py status` | Show the status once |
| `py sky2.py setwifi --ssid "..." --password "..."` | Change the Wi-Fi network |
| `py sky2.py reboot` | Restart the SKY2 |

Add `-v` to any command for a detailed log of every step, for example
`py sky2.py connect -v`. Your Wi-Fi name and password are never written to the
log.

## If it doesn't work

`connect` tries three different ways to talk to the SKY2 before giving up, so a
failure means all three didn't work.

**"Application-specific Error 0x80" (or any GATT error on every attempt):**
Windows is usually holding a stale pairing or cache for the SKY2. Clear it:

1. Open **Settings → Devices → Bluetooth & other devices**.
2. If **BSKY** or an unknown/other device is listed, click it, then **Remove**.
3. Turn Bluetooth **off and back on** (same screen).
4. Put the SKY2 back in config mode (Wi-Fi icon blinking alternate colors).
5. Run the command again.

Staying within a few feet of the SKY2 helps, and make sure no phone or other
computer is connected to it at the same time.

**Still failing?** Run the command again with `-v` and send back everything it
prints:

```
py sky2.py connect -v
```

Also note your Windows version (Settings → System → About) and whether the
laptop's Bluetooth is on. The verbose output tells us whether it's a pairing,
driver, or range problem.
