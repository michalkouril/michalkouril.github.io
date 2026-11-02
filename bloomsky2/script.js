'use strict';

const SVC_1802 = '00001802-0000-1000-8000-00805f9b34fb';
const SVC_1803 = '00001803-0000-1000-8000-00805f9b34fb';
const SVC_1804 = '00001804-0000-1000-8000-00805f9b34fb';

const CHAR_DEVICE_ID_OR_PASS = '00003a02-0000-1000-8000-00805f9b34fb'; // in 1802: read = device ID, write = password
const CHAR_STATUS_OR_SSID = '00003a01-0000-1000-8000-00805f9b34fb'; // in 1803: read = status, write = SSID
const CHAR_COMMAND = '00003a03-0000-1000-8000-00805f9b34fb'; // in 1804: selects what the next write means

const STATUS_TIMEOUT_MS = 30000; // A SKY2 still on "wait" after 30s has gone wrong.
const STATUS_POLL_MS = 2000;
// A retry can read the previous attempt's result before the device overwrites
// it, so a final status matching the one from before the update isn't trusted yet.
const STALE_STATUS_GRACE_MS = 10000;

const STATUS_TEXT = {
  1: 'Wait',
  3: 'Good: connected to Wi-Fi',
  4: 'Not good: could not write the SSID/password',
  5: 'Not good: could not connect to Wi-Fi',
};

const FINAL_RESULTS = {
  3: {
    kind: 'ok',
    text: 'Success: your SKY2 is on Wi-Fi and reaching the gateway. Click Reboot to finish. ' +
          'Changing these settings again will need another hard reset.',
  },
  4: {
    kind: 'bad',
    text: 'The SKY2 could not save the SSID and password. Check them and try again.',
  },
  5: {
    kind: 'bad',
    text: 'The SKY2 could not connect to Wi-Fi. Check the SSID and password and try again. ' +
          'If it fails again, click Reboot, hard reset, and start over.',
  },
};

const $ = (selector) => document.querySelector(selector);

let device = null;
let deviceIdOrPass = null;
let statusOrSsid = null;
let command = null;

let updating = false;
let rebooting = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isConnected = () => Boolean(device && device.gatt.connected);

function describeStatus(code) {
  if (code === null) return 'No value';
  return `${code}: ${STATUS_TEXT[code] || 'Unknown'}`;
}

function setMessage(element, text, kind) {
  element.textContent = text || '';
  element.className = 'message' + (kind ? ` ${kind}` : '');
  element.hidden = !text;
}

const setConnectMessage = (text, kind) => setMessage($('#connectMessage'), text, kind);
const setResult = (text, kind) => {
  setMessage($('#result'), text, kind);
  if (text) $('#result').scrollIntoView({ block: 'nearest' });
};

function setControlsDisabled(disabled) {
  ['#wifi_ssid', '#wifi_pass', '#updatewifi', '#reboot', '#getStatus'].forEach((selector) => {
    $(selector).disabled = disabled;
  });
}

function lockWifiForm() {
  ['#wifi_ssid', '#wifi_pass', '#updatewifi'].forEach((selector) => {
    $(selector).disabled = true;
  });
}

/* ---------- Bluetooth support ---------- */

function checkBluetoothSupport() {
  if (!navigator.bluetooth) {
    const reason = window.isSecureContext
      ? 'This browser does not support Web Bluetooth, which this page needs. Open it in Chrome or Edge on a computer or Android device. Safari and Firefox will not work.'
      : 'Web Bluetooth only works on secure pages. Open this page over https://.';
    setMessage($('#support'), reason, 'bad');
    $('#setup').hidden = true;
    return;
  }

  if (!navigator.bluetooth.getAvailability) return;

  const showAvailability = (available) => {
    setMessage(
      $('#support'),
      available ? '' : 'No Bluetooth adapter is available. Turn Bluetooth on and allow your browser to use it.',
      available ? null : 'warn'
    );
  };
  navigator.bluetooth.getAvailability().then(showAvailability, () => {});
  navigator.bluetooth.addEventListener('availabilitychanged', (event) => showAvailability(event.value));
}

/* ---------- Connecting ---------- */

async function onConnectClick() {
  const options = { filters: [{ services: [SVC_1802, SVC_1803, SVC_1804] }] };
  const filterName = $('#name').value;
  if (filterName) options.filters.push({ name: filterName });

  $('#scan').disabled = true;
  setConnectMessage('Choose your SKY2 in the browser’s Bluetooth window…');

  try {
    device = await navigator.bluetooth.requestDevice(options);
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setConnectMessage('Connecting to your SKY2…');
    const server = await device.gatt.connect();

    const getCharacteristic = async (service, characteristic) =>
      (await server.getPrimaryService(service)).getCharacteristic(characteristic);
    deviceIdOrPass = await getCharacteristic(SVC_1802, CHAR_DEVICE_ID_OR_PASS);
    statusOrSsid = await getCharacteristic(SVC_1803, CHAR_STATUS_OR_SSID);
    command = await getCharacteristic(SVC_1804, CHAR_COMMAND);

    const id = new TextDecoder('utf-8').decode(await deviceIdOrPass.readValue());
    $('#deviceid').value = id;
    await refreshStatus();

    showConnected();
  } catch (error) {
    const failedDevice = device;
    device = null; // Stops onDisconnected from replacing the message below.
    if (failedDevice && failedDevice.gatt.connected) failedDevice.gatt.disconnect();

    console.log('Connection failed:', error);
    if (error.name === 'NotFoundError' && /cancel/i.test(error.message)) {
      setConnectMessage('No device selected. Click Connect to try again.');
    } else {
      setConnectMessage(`Could not connect: ${error.message}`, 'bad');
    }
    $('#scan').disabled = false;
  }
}

function showConnected() {
  rebooting = false;
  setConnectMessage(`Connected to ${device.name || 'SKY2'}.`, 'ok');
  $('#scan').textContent = 'Connected';
  setResult('');
  $('#progress').hidden = true;
  $('#reboot').classList.remove('primary');
  setControlsDisabled(false);
  $('#devicePanel').hidden = false;
  $('#wifi_ssid').focus();
}

function onDisconnected(event) {
  if (event.target !== device) return;
  console.log('Bluetooth device disconnected');

  device = null;
  $('#devicePanel').hidden = true;
  $('#scan').disabled = false;
  $('#scan').textContent = 'Connect to SKY2 via Bluetooth';

  if (rebooting) {
    setConnectMessage('Your SKY2 is rebooting and has disconnected from Bluetooth. You can close this page.', 'ok');
  } else if (updating) {
    setConnectMessage('Your SKY2 disconnected before reporting a result. Connect again to check its status.', 'bad');
  } else {
    setConnectMessage('Your SKY2 disconnected. Connect again to continue.', 'warn');
  }
}

/* ---------- Status ---------- */

async function refreshStatus() {
  const value = await statusOrSsid.readValue();
  const code = value.byteLength ? value.getUint8(0) : null;
  console.log(`Status is ${code}`);
  $('#status').value = describeStatus(code);
  return code;
}

async function onRefreshClick() {
  if (!isConnected()) return;
  const button = $('#getStatus');
  button.disabled = true;
  try {
    await refreshStatus();
  } catch (error) {
    if (isConnected()) $('#status').value = `Could not read status: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/* ---------- Updating Wi-Fi ---------- */

function setProgress(percent, headline) {
  $('#progressBar').value = percent;
  $('#progressHeadline').textContent = headline;
}

function addLog(text) {
  const item = document.createElement('li');
  item.textContent = text;
  const list = $('#progressLog');
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
  $('#progress').scrollIntoView({ block: 'nearest' });
}

async function sendWifiSettings(ssid, pass) {
  const encoder = new TextEncoder();
  const sendCommand = (code) => command.writeValue(new Uint8Array([code]));

  // The order of these writes is the SKY2's setup protocol. Each command picks
  // what the following write to the characteristics means.
  const steps = [
    ['Starting setup', () => sendCommand(1)],
    ['Preparing to receive the SSID', () => sendCommand(3)],
    ['Sending the SSID', () => statusOrSsid.writeValue(encoder.encode(ssid))],
    ['Preparing to receive the password', () => sendCommand(2)],
    ['Sending the password', () => deviceIdOrPass.writeValue(encoder.encode(pass))],
    ['Saving the Wi-Fi settings', () => sendCommand(4)],
    ['Starting the Wi-Fi connection test', () => sendCommand(5)],
  ];

  for (let i = 0; i < steps.length; i++) {
    const [label, run] = steps[i];
    setProgress(Math.round((i / steps.length) * 20), `${label}…`);
    addLog(label);
    await run();
  }
}

/* Returns the final status code, or null if there was none before the timeout. */
async function waitForFinalStatus(statusBeforeUpdate) {
  const startedAt = Date.now();

  for (let check = 1; isConnected(); check++) {
    const elapsedMs = Date.now() - startedAt;
    const seconds = Math.round(elapsedMs / 1000);
    setProgress(
      20 + Math.min(80, Math.round((elapsedMs / STATUS_TIMEOUT_MS) * 80)),
      `Checking status (check ${check}, ${seconds}s of ${STATUS_TIMEOUT_MS / 1000}s)…`
    );

    try {
      const code = await refreshStatus();
      const isFinal = code in FINAL_RESULTS;
      const isPossiblyStale = code === statusBeforeUpdate && elapsedMs < STALE_STATUS_GRACE_MS;

      if (isFinal && isPossiblyStale) {
        addLog(`${seconds}s: status ${describeStatus(code)} (may be from the last attempt, still checking)`);
      } else {
        addLog(`${seconds}s: status ${describeStatus(code)}`);
        if (isFinal) return code;
      }
    } catch (error) {
      if (!isConnected()) return null;
      addLog(`${seconds}s: could not read status (${error.message}), will retry`);
    }

    if (Date.now() - startedAt + STATUS_POLL_MS > STATUS_TIMEOUT_MS) return null;
    await sleep(STATUS_POLL_MS);
  }
  return null;
}

async function onUpdateSubmit(event) {
  event.preventDefault();
  if (updating || !isConnected()) return;

  const ssid = $('#wifi_ssid').value;
  const pass = $('#wifi_pass').value;
  if (ssid === '' || pass === '') {
    setResult('Please enter both the Wi-Fi SSID and password.', 'bad');
    return;
  }

  updating = true;
  setControlsDisabled(true);
  setResult('');
  $('#progressLog').replaceChildren();
  $('#progress').hidden = false;
  setProgress(0, 'Starting…');

  let locked = false;
  try {
    const statusBeforeUpdate = await refreshStatus();
    await sendWifiSettings(ssid, pass);
    addLog(`Waiting up to ${STATUS_TIMEOUT_MS / 1000}s for your SKY2 to report a result`);

    const code = await waitForFinalStatus(statusBeforeUpdate);
    if (!isConnected()) return; // onDisconnected has already told the user.

    if (code === null) {
      setProgress(100, 'No result');
      setResult(
        `Your SKY2 did not report a result within ${STATUS_TIMEOUT_MS / 1000} seconds. ` +
        'Check the status once more, then try again or click Reboot.',
        'bad'
      );
    } else {
      setProgress(100, 'Finished');
      setResult(FINAL_RESULTS[code].text, FINAL_RESULTS[code].kind);
      if (code === 3) {
        locked = true;
        $('#reboot').classList.add('primary');
      }
    }
  } catch (error) {
    console.log('Update failed:', error);
    if (isConnected()) {
      setProgress($('#progressBar').value, 'Stopped');
      setResult(`Could not send the Wi-Fi settings: ${error.message}. Try again.`, 'bad');
    }
  } finally {
    updating = false;
    if (isConnected()) {
      setControlsDisabled(false);
      if (locked) lockWifiForm();
    }
  }
}

/* ---------- Rebooting ---------- */

async function onRebootClick() {
  if (!isConnected()) return;
  const wifiFormLocked = $('#updatewifi').disabled;

  rebooting = true;
  setControlsDisabled(true);
  setResult('Sending the reboot command…');
  try {
    await command.writeValue(new Uint8Array([7]));
    if (isConnected()) setResult('Reboot command sent. Your SKY2 should now restart.', 'ok');
  } catch (error) {
    // The SKY2 may drop the link before acknowledging; onDisconnected covers that.
    if (isConnected()) {
      rebooting = false;
      setControlsDisabled(false);
      if (wifiFormLocked) lockWifiForm();
      setResult(`Could not send the reboot command: ${error.message}`, 'bad');
    }
  }
}

/* ---------- Wiring ---------- */

$('#connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  onConnectClick();
});
$('#wifiForm').addEventListener('submit', onUpdateSubmit);
$('#getStatus').addEventListener('click', onRefreshClick);
$('#reboot').addEventListener('click', onRebootClick);

checkBluetoothSupport();
